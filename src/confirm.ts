import { debug } from './utils/debug';
import { Scope, loadConfirmMap, saveConfirmMap, loadConfirmMapMerged } from './store';
import { resolveScopeForWrite } from './projectResolution';
import { assertSidecarsWritable } from './utils/unreadable';


export function loadConfirmKeys(scope?: Scope  ): Record<string, true> {
  if (!scope || scope === 'auto') {
    return loadConfirmMapMerged();
  }
  return loadConfirmMap(scope);
}

export function saveConfirmKeys(data: Record<string, true>, scope?: Scope  ): void {
  const effectiveScope = resolveScopeForWrite(scope);
  saveConfirmMap(data, effectiveScope);
}

// ── Which entry a flag belongs to ───────────────────────────────────────
// Two rules, and they pull in opposite directions on purpose.
//
// Asking whether a key is flagged ignores case. Keys keep their case and
// compare without it (#216), and versions up to 1.3.0 could list a flag under
// another spelling than the entry's (`confirm set commands.Deploy` for an
// entry stored as `commands.deploy` reported success). Matching the exact
// spelling only left such an entry running unconfirmed; matching without case
// gates it. The gate errs toward asking.
//
// Changing the list is exact. Nothing drops a flag unless the user named it
// (removeConfirm) or the entry it is spelled as is gone (the remove cascade,
// moveConfirm). A cascade that ignored case would take the flag of an entry
// that was not removed: `commands.*` and `Commands.*` are two namespaces.

/** Do `a` and `b` name the same entry, case aside? */
function sameKey(a: string, b: string): boolean {
  return a === b || a.toLowerCase() === b.toLowerCase();
}

// Mark a key as requiring confirmation
export function setConfirm(key: string, scope?: Scope  ): void {
  const effectiveScope = resolveScopeForWrite(scope);
  const keys = loadConfirmMap(effectiveScope);
  keys[key] = true;
  saveConfirmMap(keys, effectiveScope);
  debug(`Confirm set for key: "${key}"`);
}

// Remove confirmation requirement from a key
export function removeConfirm(key: string, scope?: Scope  ): void {
  // Auto collapses to 'project' when resolution succeeds, throws when it
  // fails (#99). The pre-#99 project-then-global fallthrough is dropped for
  // consistency with set/remove on entries and aliases.
  const effectiveScope = resolveScopeForWrite(scope);
  // #215: an unreadable list loads as empty, so "the key is not in it" would
  // be reported as a removal that happened. Refuse instead.
  assertSidecarsWritable(() => effectiveScope, ['confirm']);
  const keys = loadConfirmMap(effectiveScope);
  // The user named this key, so every spelling of it goes: the gate reads
  // them all as this key, and leaving one behind would report the
  // requirement removed and keep enforcing it.
  const listed = Object.keys(keys).filter(k => sameKey(k, key));
  if (listed.length > 0) {
    for (const k of listed) delete keys[k];
    saveConfirmMap(keys, effectiveScope);
    debug(`Confirm removed for key: "${key}" (${effectiveScope})`);
  }
}

// Check if a key carries the confirm flag (checks merged), under any spelling
// of the key — see above. Literal in one respect: an unreadable confirmation
// list (#215) loads as empty and this answers false. The run gates add
// confirmListUnreadable() so they fail closed.
export function hasConfirm(key: string): boolean {
  const keys = loadConfirmMapMerged();
  if (keys[key] === true) return true;
  return Object.keys(keys).some(k => keys[k] === true && sameKey(k, key));
}

/**
 * Carry confirmation flags across a rename.
 *
 * `moved` is what the rename actually moved, old key to new key, one pair per
 * entry: the caller knows, and this must not guess from the key's shape.
 * Guessing "everything under the old key" took flags from entries that never
 * moved — one in a namespace spelled in another case, one in the other scope.
 * Only the flag on the renamed key itself used to move at all, so renaming a
 * namespace left its entries' flags behind and the renamed commands ran
 * unconfirmed.
 *
 * For each moved entry that was gated (as the gate reads it: merged list, any
 * spelling), the new key is flagged in the scope the rename writes to. The
 * old name is dropped from that scope's list only under its exact spelling,
 * and only if `stillStored` says the old key no longer reads: a rename in the
 * project leaves a global entry of the same name where it was, and that entry
 * was gated by this flag too.
 */
export function moveConfirm(
  moved: readonly (readonly [from: string, to: string])[],
  scope: Scope | undefined,
  stillStored: (key: string) => boolean,
): void {
  const merged = loadConfirmMapMerged();
  const flagged = new Set(Object.keys(merged).filter(k => merged[k] === true).map(k => k.toLowerCase()));
  const carried = moved.filter(([from]) => flagged.has(from.toLowerCase()));
  if (carried.length === 0) return;
  const effectiveScope = resolveScopeForWrite(scope);
  const keys = loadConfirmMap(effectiveScope);
  for (const [from, to] of carried) {
    keys[to] = true;
    if (from in keys && !stillStored(from)) delete keys[from];
  }
  saveConfirmMap(keys, effectiveScope);
  debug(`Confirm moved for ${carried.length} of ${moved.length} renamed entr${moved.length === 1 ? 'y' : 'ies'} (${effectiveScope})`);
}

// Cascade delete: remove key and any children (e.g., removing "commands" removes "commands.deploy")
export function removeConfirmForKey(key: string, scope?: Scope  ): void {
  const effectiveScope = resolveScopeForWrite(scope);
  removeConfirmFromScope(key, effectiveScope);
}

function removeConfirmFromScope(key: string, scope: 'project' | 'global'): void {
  const keys = loadConfirmMap(scope);
  // Exact, like the removal it follows: see "Changing the list is exact".
  const prefix = key + '.';
  let changed = false;
  for (const k of Object.keys(keys)) {
    if (k === key || k.startsWith(prefix)) {
      delete keys[k];
      changed = true;
    }
  }
  if (changed) {
    saveConfirmMap(keys, scope);
  }
}
