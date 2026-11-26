import { debug } from './utils/debug';
import { Scope, loadAliasMap, saveAliasMap, updateAliasMap, loadAliasMapMerged } from './store';
import { isValidEntryKey } from './utils/directoryStore';
import { resolveScopeForWrite } from './projectResolution';
import { assertSidecarsWritable } from './utils/unreadable';


export function loadAliases(scope?: Scope  ): Record<string, string> {
  if (!scope || scope === 'auto') {
    return loadAliasMapMerged();
  }
  return loadAliasMap(scope);
}

/** Replace the map wholesale (reset). A change to the map goes through updateAliases (#254). */
export function saveAliases(data: Record<string, string>, scope?: Scope  ): void {
  const effectiveScope = resolveScopeForWrite(scope);
  saveAliasMap(data, effectiveScope);
}

/**
 * #254: the read-modify-write `saveAliases(fn(loadAliases(scope)), scope)` as
 * one transaction on the map it writes. `fn` returns the new map, or null to
 * write nothing; it runs under the store lock, so it must be synchronous and
 * must not touch the store.
 *
 * In the default scope loadAliases layers the project's map over the global
 * one, and callers wrote that whole view to the project. A single writer
 * still gets exactly that: the global layer, another store under another
 * lock, is read first; the project's own map is read under its lock.
 */
export function updateAliases(
  fn: (aliases: Record<string, string>) => Record<string, string> | null,
  scope?: Scope,
): void {
  const effectiveScope = resolveScopeForWrite(scope);
  const layered = (!scope || scope === 'auto') && effectiveScope === 'project';
  const below = layered ? loadAliasMap('global') : {};
  updateAliasMap(own => fn(layered ? { ...below, ...own } : own), effectiveScope);
}

// Create or update an alias (one alias per entry — replaces any existing alias for the same target)
//
// Validates BOTH the alias name and the target path so the same key validation
// rules that protect entries also protect the alias map. Pre-fix, the alias
// map happily accepted "__proto__", ".dotleading", slashes, and the empty
// string as alias names, with downstream behavior ranging from "silently
// dropped on JSON serialization" to "creates a phantom alias visible in the
// list as `  -> target`."
export function setAlias(alias: string, path: string, scope?: Scope  ): void {
  if (!isValidEntryKey(alias)) {
    throw new Error(`Invalid alias name: ${JSON.stringify(alias)}`);
  }
  if (!isValidEntryKey(path)) {
    throw new Error(`Invalid alias target: ${JSON.stringify(path)}`);
  }
  const effectiveScope = resolveScopeForWrite(scope);
  // #254: decided against the map as it stands under the lock.
  updateAliasMap(current => {
    const aliases = { ...current };
    // Enforce one alias per entry: O(1) lookup via inverted map
    const keyToAlias = buildKeyToAliasMap(aliases);
    const existing = keyToAlias[path];
    if (existing && existing !== alias) {
      delete aliases[existing];
    }
    aliases[alias] = path;
    return aliases;
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
  if (!(alias in loadAliasMap(effectiveScope))) return false;
  // #254: removed from the map as it stands under the lock.
  return changeAliasMap(effectiveScope, aliases => {
    if (!(alias in aliases)) return null;
    const next = { ...aliases };
    delete next[alias];
    return next;
  });
}

// Rename an alias
export function renameAlias(oldName: string, newName: string, scope?: Scope  ): boolean {
  const effectiveScope = resolveScopeForWrite(scope);
  assertSidecarsWritable(() => effectiveScope, ['aliases']); // #215, as removeAlias
  const rename = (aliases: Record<string, string>): Record<string, string> | null => {
    if (!(oldName in aliases)) return null;
    if (newName in aliases) return null;
    const next = { ...aliases, [newName]: aliases[oldName] };
    delete next[oldName];
    return next;
  };
  if (rename(loadAliasMap(effectiveScope)) === null) return false;
  // #254: checked again, and renamed, in the map as it stands under the lock.
  return changeAliasMap(effectiveScope, rename);
}

// Resolve a key that might be an alias
// With 'auto' scope: checks project aliases first, then global
export function resolveKey(key: string, scope?: Scope  ): string {
  // Strip trailing colon (CLI tab-completion artifact)
  const cleanKey = key.replace(/:$/, '');
  // Use Object.hasOwn so prototype-chain names like "__proto__", "constructor",
  // and "toString" don't accidentally resolve to inherited properties of the
  // alias map. Without this guard, resolveKey("__proto__") returned
  // Object.prototype (an object, not a string), which then crashed downstream
  // string operations with "path.split is not a function".
  if (!scope || scope === 'auto') {
    const merged = loadAliasMapMerged();
    const resolved = Object.hasOwn(merged, cleanKey) ? merged[cleanKey] : cleanKey;
    if (resolved !== cleanKey) {
      debug(`Alias resolved: "${cleanKey}" -> "${resolved}"`);
    }
    return resolved;
  }
  const aliases = loadAliasMap(scope);
  const resolved = Object.hasOwn(aliases, cleanKey) ? aliases[cleanKey] : cleanKey;
  if (resolved !== cleanKey) {
    debug(`Alias resolved: "${cleanKey}" -> "${resolved}"`);
  }
  return resolved;
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
  const prefix = key + '.';
  const dropPointing = (aliases: Record<string, string>): Record<string, string> | null => {
    const next = { ...aliases };
    let changed = false;
    for (const [alias, target] of Object.entries(aliases)) {
      if (target === key || target.startsWith(prefix)) {
        delete next[alias];
        changed = true;
      }
    }
    return changed ? next : null;
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
