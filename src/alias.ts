import { debug } from './utils/debug';
import { Scope, loadAliasMap, saveAliasMap, updateAliasMap, updateStore, loadAliasMapMerged, hasProjectStore } from './store';
import { assertAliasNamesFree, entryKeysIn, otherStoreEntryKeys } from './utils/aliasNames';
import { isValidEntryKey } from './utils/directoryStore';
import { resolveScopeForWrite, unusedProjectStore } from './projectResolution';
import { assertSidecarsWritable } from './utils/unreadable';
import { type AliasMap, type NameContext, type NameView, type Resolution, type StoreName, aliasListedIn, aliasTarget, aliasesPointingAt, aliasesSeen, defaultScopeInProject, referenceContext, resolveName, typedContext } from './utils/nameResolver';

/**
 * The resolver's view of the stores as they stand now (utils/nameResolver).
 * Each part is loaded when the resolver first asks for it, and only then: a
 * lookup with -G never touches the project store, nor a default-scope
 * lookup outside a project its alias map. A new view for every question,
 * so a lookup never answers from a map read before something else wrote.
 */
export function nameView(): NameView {
  let has: boolean | undefined;
  let project: AliasMap | undefined;
  let global: AliasMap | undefined;
  let unused: { path: string | undefined } | undefined;
  return {
    get hasProjectStore() { return has ??= hasProjectStore(); },
    // Project scope with no project store throws the store's refusal (#294).
    get projectAliases() { return project ??= loadAliasMap('project'); },
    get globalAliases() { return global ??= loadAliasMap('global'); },
    get unusedProject() { return (unused ??= { path: unusedProjectStore() }).path; },
  };
}

/** What `written` means in `ctx`, as the stores stand now. */
export function resolveNameNow(ctx: NameContext, written: string): Resolution {
  // Each alias found is printed under --debug as it is looked up: the
  // name's own, and the global map's answer for the gate when a run reads
  // the gate names.
  return resolveName(nameView(), ctx, written, (name, target) => debug(`Alias resolved: "${name}" -> "${target}"`));
}

/** What a name typed with `scope` (CLI -G, an MCP scope; undefined or 'auto': the default) means. */
export function resolveTypedName(written: string, scope?: Scope): Resolution {
  return resolveNameNow(typedContext(scope), written);
}

/** What a `${name}` / `$(name)` in an entry stored in `from` means (#280). */
export function resolveReferenceName(written: string, from: StoreName): Resolution {
  return resolveNameNow(referenceContext(from), written);
}


export function loadAliases(scope?: Scope  ): Record<string, string> {
  if (!scope || scope === 'auto') {
    return loadAliasMapMerged();
  }
  return loadAliasMap(scope);
}

/** Replace the map wholesale (reset). A change to the map goes through updateAliasMap (#254). */
export function saveAliases(data: Record<string, string>, scope?: Scope  ): void {
  const effectiveScope = resolveScopeForWrite(scope);
  saveAliasMap(data, effectiveScope);
}

/**
 * Whether `name` is an alias in the map `scope` shows — both maps in the
 * default view — asked as the alias commands always have (aliasListedIn).
 * Decides "not found" for an alias removal or rename that changed nothing.
 */
export function aliasListed(name: string, scope?: Scope): boolean {
  return aliasListedIn(aliasesSeen(nameView(), typedContext(scope)), name);
}

/** The target the map `scope` shows for alias `name`, indexed as the audit row's before-value always was. */
export function aliasTargetListed(name: string, scope?: Scope): string | undefined {
  return aliasesSeen(nameView(), typedContext(scope))[name];
}

/**
 * #260: the global alias named `name` that an alias command in the default
 * scope left alone — it changes the project's list only — or undefined (an
 * explicit scope, or no such global alias). Asked after the command, so
 * outside a project the command has refused before this reads anything.
 */
export function globalAliasLeft(name: string, scope?: Scope): string | undefined {
  // In the default scope the command wrote the project's list, or refused before this.
  if (!defaultScopeInProject(typedContext(scope), 'project')) return undefined;
  return aliasTarget(loadAliasMap('global'), name);
}

/** What a default-scope alias removal says about a global alias of the name: refused when only the global store has it, a note when both do. `how`: the scope option on this surface. */
export function globalAliasRemovalMessage(name: string, target: string, removed: boolean, how: string): string {
  return removed
    ? `A global alias '${name}' (-> ${target}) still resolves here. To remove it too, pass ${how}.`
    : `Alias '${name}' is a global alias (-> ${target}), not one of this project's, so nothing was removed. To remove it, pass ${how}.`;
}

// Create or update an alias (one alias per entry — replaces any existing alias for the same target)
//
// Validates BOTH the alias name and the target path so the same key validation
// rules that protect entries also protect the alias map. Pre-fix, the alias
// map happily accepted "__proto__", ".dotleading", slashes, and the empty
// string as alias names, with downstream behavior ranging from "silently
// dropped on JSON serialization" to "creates a phantom alias visible in the
// list as `  -> target`."
//
// #279: and not under a name that is an entry's key, in either store (see
// utils/aliasNames.ts) — the alias would stand in for that entry. Refused
// with INVALID_INPUT (a KeyCollisionError).
export function setAlias(alias: string, path: string, scope?: Scope  ): void {
  if (!isValidEntryKey(alias)) {
    throw new Error(`Invalid alias name: ${JSON.stringify(alias)}`);
  }
  if (!isValidEntryKey(path)) {
    throw new Error(`Invalid alias target: ${JSON.stringify(path)}`);
  }
  const effectiveScope = resolveScopeForWrite(scope);
  const otherKeys = otherStoreEntryKeys(effectiveScope);
  // #254: decided against the map as it stands under the lock — and #279,
  // against the entries of that store as they stand there.
  updateStore(current => {
    assertAliasNamesFree([alias], [...entryKeysIn(current), ...otherKeys]);
    const aliases = { ...current.aliases };
    // Enforce one alias per entry: O(1) lookup via inverted map
    const keyToAlias = buildKeyToAliasMap(aliases);
    const existing = keyToAlias[path];
    if (existing && existing !== alias) {
      delete aliases[existing];
    }
    aliases[alias] = path;
    return { ...current, aliases };
  }, effectiveScope);
  console.log(`Alias '${alias}' added successfully.`);
}

// Remove an alias
export function removeAlias(alias: string, scope?: Scope  ): boolean {
  // Auto collapses to 'project' when resolution succeeds, throws when it
  // fails (#99). Pre-#99 project-then-global fallthrough is dropped to keep
  // remove semantics aligned with set: if you want to touch global, ask for it.
  const effectiveScope = resolveScopeForWrite(scope);
  // #215: an unreadable map loads as empty, and "no such alias" is the wrong
  // answer about a file that could not be read. Refuse instead.
  assertSidecarsWritable(() => effectiveScope, ['aliases']);
  if (!aliasListedIn(loadAliasMap(effectiveScope), alias)) return false;
  // #254: removed from the map as it stands under the lock.
  return changeAliasMap(effectiveScope, aliases => {
    if (!aliasListedIn(aliases, alias)) return null;
    const next = { ...aliases };
    delete next[alias];
    return next;
  });
}

// Rename an alias. #279: not to a name that is an entry's key (setAlias's rule).
export function renameAlias(oldName: string, newName: string, scope?: Scope  ): boolean {
  const effectiveScope = resolveScopeForWrite(scope);
  assertSidecarsWritable(() => effectiveScope, ['aliases']); // #215, as removeAlias
  const rename = (aliases: Record<string, string>): Record<string, string> | null => {
    if (!aliasListedIn(aliases, oldName)) return null;
    if (aliasListedIn(aliases, newName)) return null;
    const next = { ...aliases, [newName]: aliases[oldName] };
    delete next[oldName];
    return next;
  };
  if (rename(loadAliasMap(effectiveScope)) === null) return false;
  const otherKeys = otherStoreEntryKeys(effectiveScope);
  // #254: checked again, and renamed, in the map as it stands under the lock.
  let renamed = false;
  updateStore(current => {
    const next = rename(current.aliases);
    renamed = next !== null;
    if (next === null) return null;
    assertAliasNamesFree([newName], [...entryKeysIn(current), ...otherKeys]);
    return { ...current, aliases: next };
  }, effectiveScope);
  return renamed;
}

// Resolve a key that might be an alias: the key resolveTypedName gives it.
// With 'auto' scope: checks project aliases first, then global.
export function resolveKey(key: string, scope?: Scope  ): string {
  return resolveTypedName(key, scope).key;
}

// Remove any aliases whose target matches `key` or is a child of `key` (cascade delete).
//
// Called as a post-step from removeEntry — that caller already passed its
// scope through resolveScopeForWrite, so by the time we get here the entry
// remove either succeeded with an explicit scope or threw. Re-applying the
// guard here keeps independent callers honest while making cascade calls a
// no-cost passthrough.
export function removeAliasesForKey(key: string, scope?: Scope  ): void {
  const effectiveScope = resolveScopeForWrite(scope);
  removeAliasesFromScope(key, effectiveScope);
}

function removeAliasesFromScope(key: string, scope: 'project' | 'global'): void {
  const dropPointing = (aliases: Record<string, string>): Record<string, string> | null => {
    const pointing = aliasesPointingAt(aliases, key);
    if (pointing.length === 0) return null;
    const next = { ...aliases };
    for (const [alias] of pointing) delete next[alias];
    return next;
  };
  // Nothing points at the key: nothing to write.
  if (dropPointing(loadAliasMap(scope)) === null) return;
  changeAliasMap(scope, dropPointing);
}

/**
 * Apply `change` to the map as it stands under the store lock (#254), never
 * to a copy loaded earlier: an alias set in between would be dropped.
 * `change` returns the new map, or null when there is nothing to change.
 * True when it wrote.
 */
function changeAliasMap(
  scope: 'project' | 'global',
  change: (aliases: Record<string, string>) => Record<string, string> | null,
): boolean {
  let changed = false;
  updateAliasMap(aliases => {
    const next = change(aliases);
    changed = next !== null;
    return next;
  }, scope);
  return changed;
}

// Build inverted map from target paths to alias name (one alias per entry)
export function buildKeyToAliasMap(aliases?: Record<string, string>): Record<string, string> {
  const resolved = aliases ?? loadAliases();
  const keyToAliasMap: Record<string, string> = {};
  for (const [alias, target] of Object.entries(resolved)) {
    keyToAliasMap[target] = alias;
  }
  return keyToAliasMap;
}
