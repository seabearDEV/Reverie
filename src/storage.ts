import { color } from './formatting';
import { getNestedValue, setNestedValue, removeNestedValue, flattenObject, removeFlatKeysUnder } from './utils/objectPath';
import { KeyCollisionError, assertKeyWritable, findCollidingPairs } from './utils/keyCollision';
import { LockTimeoutError } from './utils/fileLock';
import { StoreWriteError, isStoreIoError } from './utils/storeWriteError';
import { CodexData, CodexValue } from './types';
import { debug } from './utils/debug';
import { Scope, loadEntries, saveEntries, updateEntries, updateStore, loadEntriesMerged, findProjectFile, getEntryFast, setEntryFast } from './store';
import { isValidEntryKey } from './utils/directoryStore';
import { resolveScopeForWrite, ProjectResolutionError } from './projectResolution';
import { StoreUnreadableError, markUnreadableShown, noteWriteRefused, readForWrite } from './utils/unreadable';
import { isJsonMode, failJson, recordErrorCode } from './utils/output';

export type { Scope } from './store';

/**
 * Extract a human-readable message from an unknown error value
 */
export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Consistent error handling with improved context
 */
export function handleError(message: string, error: unknown, context?: string): void {
  const contextPrefix = context ? `[${context}] ` : '';
  // Always include the error's own message in user-facing output. Pre-fix
  // the non-DEBUG branch printed only `message` (e.g. "Failed to set entry:")
  // and threw away the underlying error text — so a CLI user setting an
  // invalid key saw "Failed to set entry:" with no idea why. The actual
  // reason ("Invalid store key: __proto__") was only visible with
  // DEBUG=true. Now both branches show the message, with the stack
  // trace gated on DEBUG.
  const errorText = error instanceof Error ? error.message : String(error);

  // #215: the refusal's own message is complete — what, why, and how to fix
  // it. Prefixing "Failed to set entry:" only buries that, and the code must
  // be STORE_UNREADABLE, never RUNTIME or NOT_FOUND.
  if (error instanceof StoreUnreadableError) {
    markUnreadableShown(error.files);
    if (error.attempted === 'write') noteWriteRefused();
    if (isJsonMode()) {
      failJson('STORE_UNREADABLE', errorText);
    } else {
      recordErrorCode('STORE_UNREADABLE');
      console.error(`${color.red('✗ ')}${errorText}`);
      process.exitCode = 1;
    }
    return;
  }

  // #99: a refused auto-scope write explains itself in full — the resolver's
  // steps and the choices. Prefixing "Failed to set entry:" only buries it
  // (and printed a doubled colon). JSON mode keeps its envelope below.
  if (error instanceof ProjectResolutionError && !isJsonMode()) {
    recordErrorCode('PROJECT_UNRESOLVED');
    console.error(`${color.red('✗ ')}${errorText}`);
    process.exitCode = 1;
    return;
  }

  // #261: another process held the store lock for the whole wait. Nothing
  // was written, and the message says so and what to do: one line, IO.
  // #271: so does a write the filesystem refused, naming the file and why.
  if (isStoreIoError(error)) {
    if (isJsonMode()) {
      failJson('IO', errorText);
    } else {
      recordErrorCode('IO');
      console.error(`${color.red('✗ ')}${errorText}`);
      process.exitCode = 1;
    }
    return;
  }

  // #216 / #224: a refused collision says what is in the way and what to do.
  // It is a request to change, not a fault: INVALID_INPUT, no "Failed to…".
  if (error instanceof KeyCollisionError) {
    if (isJsonMode()) {
      failJson(error.code, errorText);
    } else {
      // The row carries the code --json reports (#203). Without this the
      // wrapper falls back to RUNTIME for a text-mode refusal.
      recordErrorCode(error.code);
      console.error(`${color.red('✗ ')}${errorText}`);
      process.exitCode = 1;
    }
    return;
  }

  // In JSON mode, route the failure into the structured envelope (#117 WS1)
  // instead of writing a human line to stderr. Project-resolution refusals
  // map to the dedicated code so agents can branch on them.
  if (isJsonMode()) {
    const code = error instanceof ProjectResolutionError ? 'PROJECT_UNRESOLVED'
      : error instanceof StoreUnreadableError ? 'STORE_UNREADABLE'
      : 'RUNTIME';
    failJson(code, `${contextPrefix}${message} ${errorText}`.trim()); // failJson sets exitCode=1
    return;
  }

  // Text mode: keep the same code for the telemetry and audit rows (#203).
  recordErrorCode(error instanceof ProjectResolutionError ? 'PROJECT_UNRESOLVED' : 'RUNTIME');

  if (process.env.DEBUG === 'true') {
    console.error(`${color.red(contextPrefix + message)}: ${errorText}`);
    if (error instanceof Error && error.stack) {
      console.error(color.gray(error.stack));
    }
  } else {
    console.error(`${color.red(contextPrefix + message)}: ${errorText}`);
  }

  // Surface failure via the process exit code so scripts wrapping rvr can
  // detect errors. Pre-fix the CLI returned 0 on most error paths.
  process.exitCode = 1;
}

/**
 * Load data from storage
 */
export function loadData(scope?: Scope  ): CodexData {
  debug('loadData called', { scope });
  if (!scope || scope === 'auto') {
    return loadEntriesMerged();
  }
  return loadEntries(scope);
}

/**
 * Replace one store's entries wholesale (reset). Never with a tree loaded
 * and changed: anything another process wrote since the load would be
 * deleted (#254) — updateEntries is for that. The project-resolution guard
 * is applied here so an `--scope auto` write with no resolvable project
 * refuses up front.
 */
export function saveData(data: CodexData, scope?: Scope  ): void {
  const effectiveScope = resolveScopeForWrite(scope);
  saveEntries(data, effectiveScope);
}

// ── Per-key operations ─────────────────────────────────────────────────

/**
 * Get a value or subtree by dot-path key.
 * With 'auto' scope: checks project first, falls through to global.
 */
export function getValue(key: string, scope?: Scope  ): CodexValue | undefined {
  // Fast path: leaf-key lookups read exactly one entry file instead of
  // scanning the whole store directory. On miss we fall through to the slow
  // path, which can also resolve subtree lookups (where `key` is a parent of
  // multiple stored leaves) — those still require the full load.
  if (isValidEntryKey(key)) {
    // Wrapped in try/catch so any unexpected fast-path failure (including
    // test environments where the fast-path export is mocked away) silently
    // degrades to the slow path instead of breaking the operation.
    try {
      if (!scope || scope === 'auto') {
        if (findProjectFile()) {
          const projectVal = getEntryFast(key, 'project');
          if (projectVal !== undefined) return projectVal;
          const globalVal = getEntryFast(key, 'global');
          if (globalVal !== undefined) return globalVal;
        } else {
          const globalVal = getEntryFast(key, 'global');
          if (globalVal !== undefined) return globalVal;
        }
      } else {
        const v = getEntryFast(key, scope);
        if (v !== undefined) return v;
      }
    } catch (err) {
      // #215: an entry file that exists but does not parse is not a miss.
      // It must not degrade to the slow path (which would report "not
      // found"), nor — in auto scope — fall through from a broken project
      // entry to the global value of the same key.
      if (err instanceof StoreUnreadableError) throw err;
      debug(`getValue fast-path failed, falling through: ${String(err)}`);
    }
  }
  // Slow path: full load + nested walk. Handles subtree returns and any case
  // the fast path missed.
  if (!scope || scope === 'auto') {
    // Fallthrough: project first, then global
    if (findProjectFile()) {
      const projectVal = getNestedValue(loadEntries('project'), key);
      if (projectVal !== undefined) return projectVal;
      return getNestedValue(loadEntries('global'), key);
    }
    return getNestedValue(loadEntries('global'), key);
  }
  return getNestedValue(loadEntries(scope), key);
}

/**
 * Existence pre-read for a key that is about to be written (the overwrite
 * prompt, a copy/rename destination). An entry file that does not parse makes
 * getValue throw a *read* error; here the caller is writing, so it becomes
 * the refused write it is (#215) — but only when the file is in the store the
 * write lands in. See readForWrite.
 */
export function getValueForWrite(key: string, scope?: Scope): CodexValue | undefined {
  return readForWrite<CodexValue | undefined, Scope>(s => getValue(key, s), scope, () => resolveScopeForWrite(scope));
}

/**
 * Set a single leaf value by dot-path key.
 *
 * Validates the key at this boundary so invalid keys (path traversal,
 * sidecar collisions, prototype pollution attempts, leading/trailing dots,
 * empty segments) reject *before* any in-memory mutation. Without this gate,
 * a key like ".dotleading" would slip through setNestedValue (which only
 * blocks __proto__/constructor/prototype) and create a phantom entry under
 * the empty-string key, then get silently normalized on flatten — producing
 * a write that the read path could never find.
 */
export function setValue(key: string, value: string, scope?: Scope  ): void {
  if (!isValidEntryKey(key)) {
    throw new Error(`Invalid store key: ${JSON.stringify(key)}`);
  }
  // Refuse auto-scoped writes when project resolution failed (#99). When it
  // succeeds, auto collapses to 'project' here so downstream load/save get
  // an explicit scope instead of routing through 'auto' fallthrough.
  const effectiveScope = resolveScopeForWrite(scope);
  // Fast path: write a single entry file directly. Returns false if a parent
  // or child collision means we'd have to restructure multiple files — in
  // that case fall through to the full load + diff path which already
  // handles those conversions. Wrapped in try/catch so any unexpected
  // fast-path failure (including test mocks that omit the export) degrades
  // gracefully to the slow path.
  try {
    if (setEntryFast(key, value, effectiveScope)) return;
  } catch (err) {
    // #215: a refusal to replace an unparseable file must stay a refusal.
    // Falling through would hand the write to save(), which guards too, but
    // the fast path's error is the precise one.
    if (err instanceof StoreUnreadableError) throw err;
    // #246: so does a write that would land in another entry's file.
    if (err instanceof KeyCollisionError) throw err;
    // A writer held the store lock for the whole wait: the slow path would
    // wait on the same lock again and double the time to the same refusal.
    if (err instanceof LockTimeoutError) throw err;
    // #271: a file the filesystem would not write. The slow path writes the
    // same file, and fails the same way.
    if (err instanceof StoreWriteError) throw err;
    debug(`setValue fast-path failed, falling through: ${String(err)}`);
  }
  updateEntries((entries, meta) => {
    // #216 / #224: the fast path declined because another entry is in the
    // way — one under this key, a leaf above it, or a key that differs only
    // by case. Setting the value here would restructure the tree and remove
    // that entry without a word. Refuse, naming it. Judged under the lock,
    // against the store this write lands in (#254).
    assertKeyWritable(entries, key);
    setNestedValue(entries, key, value);
    meta[key] = Date.now();
  }, effectiveScope);
}

/**
 * Set a leaf value together with its alias and its confirmation flag, in one
 * store write (#268): `set <key> <value> --confirm` wrote the value, then the
 * alias, then the flag, and a lock timeout or a crash between them left the
 * command stored and ungated. Now all of it lands or none of it does: the
 * store writes the list first when it gains a flag (last when it loses one),
 * and takes back what it wrote if a later file fails.
 *
 * Everything goes to the store `scope` writes, the flag too, under the key as
 * written — that is the entry the value was just stored as. `confirm` true
 * lists it, false takes the flag listed under exactly that name (removal is
 * exact), undefined leaves the list alone. With `value` undefined only the
 * alias and the flag change (a flag-only `set --no-confirm -a`). The checks
 * of setValue apply, decided under the lock: a key or an alias that cannot
 * be stored, and an entry in the way (#216, #224), refuse before anything is
 * written. Returns whether a flag was taken off.
 */
export function setValueWithMeta(
  key: string,
  value: string | undefined,
  scope: Scope | undefined,
  meta: { alias?: string | undefined; confirm?: boolean | undefined },
): { flagRemoved: boolean } {
  if (!isValidEntryKey(key)) {
    throw new Error(`Invalid store key: ${JSON.stringify(key)}`);
  }
  // setAlias's checks, made before the value lands rather than after it.
  if (meta.alias !== undefined && !isValidEntryKey(meta.alias)) {
    throw new Error(`Invalid alias name: ${JSON.stringify(meta.alias)}`);
  }
  const effectiveScope = resolveScopeForWrite(scope);
  let flagRemoved = false;
  updateStore(current => {
    flagRemoved = false;
    const next = { ...current };
    if (value !== undefined) {
      assertKeyWritable(current.entries, key);
      setNestedValue(current.entries, key, value);
      next.entries = current.entries;
      next._meta = { ...(current._meta ?? {}), [key]: Date.now() };
    }
    if (meta.alias !== undefined) {
      // One alias per entry, as setAlias keeps it.
      const aliases = { ...current.aliases };
      for (const [name, target] of Object.entries(aliases)) {
        if (target === key && name !== meta.alias) delete aliases[name];
      }
      aliases[meta.alias] = key;
      next.aliases = aliases;
    }
    if (meta.confirm === true && current.confirm[key] !== true) {
      next.confirm = { ...current.confirm, [key]: true };
    } else if (meta.confirm === false && Object.hasOwn(current.confirm, key) && current.confirm[key] === true) {
      const confirm = { ...current.confirm };
      delete confirm[key];
      next.confirm = confirm;
      flagRemoved = true;
    }
    return next;
  }, effectiveScope);
  return { flagRemoved };
}

/**
 * Remove an entry (and children) by dot-path key. Returns true if anything was removed.
 * With 'auto' scope: removes from whichever scope contains it (project preferred).
 */
export function removeValue(key: string, scope?: Scope  ): boolean {
  if (!isValidEntryKey(key)) {
    // An invalid key cannot match any real entry — return false instead of
    // throwing, so callers that probe with user input get a clean "not found"
    // rather than a stack trace.
    return false;
  }
  // Auto collapses to 'project' when resolution succeeds, throws when it
  // fails (#99). The pre-#99 project-then-global fallthrough is deliberately
  // dropped so a misconfigured workspace cannot silently delete from global.
  // Users who need to remove a global entry must pass -G (CLI) / scope:'global' (MCP).
  const effectiveScope = resolveScopeForWrite(scope);
  // Nothing under this key: nothing to write. #267: an entry stored under
  // another entry (`ns.k.sub` beside `ns.k`) is not in the tree, but `get`
  // reads it from its file, and so does this check.
  if (!removeNestedValue(loadEntries(effectiveScope), key) && getEntryFast(key, effectiveScope) === undefined) return false;
  // #254: the removal itself, decided again under the lock — the tree
  // loaded above is already stale, and saving it would delete every entry
  // another process wrote since.
  let removed = false;
  updateStore(current => {
    const inTree = removeNestedValue(current.entries, key);
    // #267: named in `removed`, the key goes with every entry stored under
    // it, the ones the tree cannot show included: `rm ns.k` takes a hidden
    // `ns.k.sub` along, and `rm ns.k.sub` removes that file alone.
    const hidden = (current.hidden ?? []).some(k => k === key || k.startsWith(`${key}.`));
    removed = inTree || hidden;
    if (!removed) return null;
    const meta = { ...(current._meta ?? {}) };
    removeFlatKeysUnder(meta, key);
    return { ...current, _meta: meta, removed: [key] };
  }, effectiveScope);
  return removed;
}

/**
 * Return all entries as flat dot-path -> value pairs.
 * With 'auto' scope: merges project over global.
 */
export function getEntriesFlat(scope?: Scope  ): Record<string, string> {
  if (!scope || scope === 'auto') {
    return flattenObject(loadEntriesMerged());
  }
  return flattenObject(loadEntries(scope));
}

/**
 * Validate that every leaf key in an entries object passes isValidEntryKey,
 * throwing a descriptive error listing all bad keys if any. Used by import
 * handlers (CLI and MCP) so a JSON payload containing prototype-pollution
 * names, sidecar collisions, leading dots, etc. is rejected up-front instead
 * of being silently dropped by isSafeKey or partly applied.
 *
 * Walks the object directly rather than going through flattenObject because
 * flattenObject does `obj['__proto__']` which triggers the prototype getter
 * (returns Object.prototype, recurses into nothing) and silently drops the
 * key — exactly the bug we're trying to catch. This walk uses
 * getOwnPropertyDescriptor to read the actual own-property value, bypassing
 * the inherited accessor.
 */
export function validateImportEntries(obj: Record<string, unknown>): void {
  const invalid: string[] = [];
  const masked: string[] = [];
  const nonString: string[] = [];
  const leafKeys: string[] = [];

  function walk(node: Record<string, unknown>, prefix: string): void {
    for (const key of Object.getOwnPropertyNames(node)) {
      const fullKey = prefix ? `${prefix}.${key}` : key;
      const desc = Object.getOwnPropertyDescriptor(node, key);
      // Use the descriptor's value, not node[key], so __proto__ as an own
      // property is read as a data value rather than triggering the getter.
      const value = desc?.value as unknown;
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        // Validate the prefix segment we're about to descend through.
        if (!isValidEntryKey(fullKey)) invalid.push(fullKey);
        walk(value as Record<string, unknown>, fullKey);
      } else {
        if (!isValidEntryKey(fullKey)) invalid.push(fullKey);
        leafKeys.push(fullKey);
        // Catch the [encrypted] sentinel that maskEncryptedValues writes on
        // export. Importing it would overwrite real ciphertext in the store
        // with the literal string, silently destroying every encrypted
        // value. Reject up-front — the user needs to re-export with
        // --include-encrypted to get a restorable file.
        if (value === '[encrypted]') masked.push(fullKey);
        // CodexValue leaves are strings only (#79). Non-string leaves —
        // numbers, booleans, arrays, null — pass structural validation but
        // violate the type contract and would surface as confusing errors
        // in downstream read paths. Catch them at the import boundary.
        if (typeof value !== 'string') nonString.push(fullKey);
      }
    }
  }

  walk(obj, '');

  if (invalid.length > 0) {
    const list = invalid.map(k => JSON.stringify(k)).join(', ');
    throw new Error(`Import contains invalid entry keys: ${list}`);
  }
  if (masked.length > 0) {
    const list = masked.map(k => JSON.stringify(k)).join(', ');
    throw new Error(
      `Import contains masked encrypted placeholders at keys: ${list}. ` +
      `This file was produced by a masking export and cannot be used to restore values. ` +
      `Re-export with --include-encrypted (CLI) or includeEncrypted: true (MCP) to get a restorable file.`
    );
  }
  if (nonString.length > 0) {
    const list = nonString.map(k => JSON.stringify(k)).join(', ');
    throw new Error(`Import contains non-string leaf values at keys: ${list}. Entry values must be strings.`);
  }
  // #216: two keys in one file that differ only by case (or one the parent
  // of the other once case is ignored) are one file on a case-insensitive
  // filesystem — the second would replace the first.
  const pairs = findCollidingPairs(leafKeys);
  if (pairs.length > 0) {
    const list = pairs.map(([a, b]) => `'${a}' and '${b}'`).join('; ');
    throw new Error(`Import contains keys that differ only by case and cannot both be stored: ${list}.`);
  }
}

/**
 * Validate an alias-map import. Both alias names AND target paths must be
 * valid entry keys; non-string values are rejected separately by callers.
 *
 * Uses getOwnPropertyNames + getOwnPropertyDescriptor to enumerate keys and
 * read values, so a JSON.parse'd object with an own __proto__ property is
 * actually visible (Object.entries / obj[key] would trigger the prototype
 * getter and silently miss it).
 */
export function validateImportAliases(obj: Record<string, unknown>): void {
  const invalidNames: string[] = [];
  const invalidTargets: string[] = [];
  for (const name of Object.getOwnPropertyNames(obj)) {
    const desc = Object.getOwnPropertyDescriptor(obj, name);
    const target = desc?.value as unknown;
    if (!isValidEntryKey(name)) invalidNames.push(name);
    if (typeof target === 'string' && !isValidEntryKey(target)) invalidTargets.push(target);
  }
  if (invalidNames.length > 0 || invalidTargets.length > 0) {
    const parts: string[] = [];
    if (invalidNames.length > 0) {
      parts.push(`invalid alias names: ${invalidNames.map(k => JSON.stringify(k)).join(', ')}`);
    }
    if (invalidTargets.length > 0) {
      parts.push(`invalid alias targets: ${invalidTargets.map(k => JSON.stringify(k)).join(', ')}`);
    }
    throw new Error(`Import contains ${parts.join('; ')}`);
  }
}

/**
 * Validate a confirm-map import. Each key must be a valid entry key, and each
 * value must be the literal boolean `true` — the confirm sidecar is the
 * run-confirmation tripwire, and hasConfirm() checks `=== true`, so a crafted
 * import carrying a falsy value (false, 0, "true") for an existing gated key
 * would merge over the user's `true` and silently disarm the gate. Legitimate
 * exports only ever emit `true`.
 * Uses getOwnPropertyNames so __proto__ as an own property is enumerated.
 */
export function validateImportConfirm(obj: Record<string, unknown>): void {
  const invalid = Object.getOwnPropertyNames(obj).filter(k => !isValidEntryKey(k));
  if (invalid.length > 0) {
    const list = invalid.map(k => JSON.stringify(k)).join(', ');
    throw new Error(`Import contains invalid confirm keys: ${list}`);
  }
  const invalidValues = Object.getOwnPropertyNames(obj).filter(k => obj[k] !== true);
  if (invalidValues.length > 0) {
    const list = invalidValues.map(k => JSON.stringify(k)).join(', ');
    throw new Error(`Import confirm values must be the literal true; offending keys: ${list}`);
  }
}
