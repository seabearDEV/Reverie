import { color } from './formatting';
import { getNestedValue, setNestedValue, removeNestedValue, flattenObject } from './utils/objectPath';
import { CodexData, CodexValue } from './types';
import { debug } from './utils/debug';
import { Scope, loadEntries, saveEntries, loadEntriesMerged, findProjectFile, saveEntriesAndTouchMeta, saveEntriesAndRemoveMeta, getEntryFast, setEntryFast } from './store';
import { isValidEntryKey } from './utils/directoryStore';
import { resolveScopeForWrite, ProjectResolutionError } from './projectResolution';
import { isJsonMode, failJson } from './utils/output';

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

  // In JSON mode, route the failure into the structured envelope (#117 WS1)
  // instead of writing a human line to stderr. Project-resolution refusals
  // map to the dedicated code so agents can branch on them.
  if (isJsonMode()) {
    const code = error instanceof ProjectResolutionError ? 'PROJECT_UNRESOLVED' : 'RUNTIME';
    failJson(code, `${contextPrefix}${message} ${errorText}`.trim()); // failJson sets exitCode=1
    return;
  }

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
 * Save data to storage. Bulk-write entry point used by import handlers; the
 * project-resolution guard is applied here so an `--scope auto` import with
 * no resolvable project refuses up front.
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
    debug(`setValue fast-path failed, falling through: ${String(err)}`);
  }
  const data = loadEntries(effectiveScope);
  setNestedValue(data, key, value);
  saveEntriesAndTouchMeta(data, key, effectiveScope);
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
  // Users who need to remove a global entry must pass --scope global / scope:'global'.
  const effectiveScope = resolveScopeForWrite(scope);
  const data = loadEntries(effectiveScope);
  const removed = removeNestedValue(data, key);
  if (removed) {
    saveEntriesAndRemoveMeta(data, key, effectiveScope);
  }
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
 * Validate a confirm-map import. Each key must be a valid entry key.
 * Uses getOwnPropertyNames so __proto__ as an own property is enumerated.
 */
export function validateImportConfirm(obj: Record<string, unknown>): void {
  const invalid = Object.getOwnPropertyNames(obj).filter(k => !isValidEntryKey(k));
  if (invalid.length > 0) {
    const list = invalid.map(k => JSON.stringify(k)).join(', ');
    throw new Error(`Import contains invalid confirm keys: ${list}`);
  }
}
