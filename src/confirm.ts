import { debug } from './utils/debug';
import { Scope, loadConfirmMap, saveConfirmMap, loadConfirmMapMerged } from './store';
import { resolveScopeForWrite } from './projectResolution';
import { assertSidecarsWritable } from './utils/unreadable';
import { entriesOpenedBy, keysOpeningSameEntry } from './utils/entryIdentity';


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
// Asking whether a key is flagged is generous. A key is gated when a flag is
// listed under its name, case aside, or under any name that opens the same
// entry file (utils/entryIdentity.ts). A key maps to its filename, and on a
// filesystem that folds names another spelling opens the flagged entry's
// file: matching the exact spelling only let that command run unasked. The
// gate errs toward asking.
//
// Changing the list is exact, and sparing. A flag is dropped only under the
// name it is listed as, and only when the user names it (removeConfirm) or
// removes the entry of that name (the remove cascade). Anything looser takes
// the flag of an entry that is still there: `commands.*` and `Commands.*` are
// two namespaces, and a store written on a case-sensitive volume can hold two
// entries that differ only by case, each with its own flag.
//
// A rename drops nothing at all (moveConfirm). A flag gates by name, and the
// global list is read in every project, so the flag on a renamed key may be
// what gates another project's entry of the same name — which the rename
// cannot see. It adds the flag under the new key and leaves the old one.

/** Do `a` and `b` name the same entry, case aside? */
function sameKey(a: string, b: string): boolean {
  return a === b || a.toLowerCase() === b.toLowerCase();
}

/** The listed keys, of `flagged`, that gate `key`: its own name case aside, or a name opening the same entry file. */
function gatingAmong(key: string, flagged: string[]): string[] {
  const byName = flagged.filter(k => sameKey(k, key));
  const byFile = keysOpeningSameEntry(key, flagged).filter(k => !byName.includes(k));
  return [...byName, ...byFile];
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
export function removeConfirm(key: string, scope?: Scope  ): boolean {
  // Auto collapses to 'project' when resolution succeeds, throws when it
  // fails (#99). The pre-#99 project-then-global fallthrough is dropped for
  // consistency with set/remove on entries and aliases.
  const effectiveScope = resolveScopeForWrite(scope);
  // #215: an unreadable list loads as empty, so "the key is not in it" would
  // be reported as a removal that happened. Refuse instead.
  assertSidecarsWritable(() => effectiveScope, ['confirm']);
  const keys = loadConfirmMap(effectiveScope);
  if (!(key in keys)) return false;
  delete keys[key];
  saveConfirmMap(keys, effectiveScope);
  debug(`Confirm removed for key: "${key}" (${effectiveScope})`);
  return true;
}

// Check if a key carries the confirm flag (checks merged), as the gate reads
// it — see above. Literal in one respect: an unreadable confirmation list
// (#215) loads as empty and this answers false. The run gates add
// confirmListUnreadable() so they fail closed.
export function hasConfirm(key: string): boolean {
  const keys = loadConfirmMapMerged();
  if (keys[key] === true) return true;
  return gatingAmong(key, Object.keys(keys).filter(k => keys[k] === true)).length > 0;
}

/**
 * hasConfirm for many keys at once: those of `keys` that are gated. The same
 * answer key by key, from one read of the list and one look at each file.
 */
export function gatedAmong(keys: readonly string[]): Set<string> {
  const merged = loadConfirmMapMerged();
  const flagged = Object.keys(merged).filter(k => merged[k] === true);
  const gated = new Set<string>();
  if (flagged.length === 0) return gated;
  const byName = new Set(flagged.map(k => k.toLowerCase()));
  const rest: string[] = [];
  for (const key of keys) {
    if (byName.has(key.toLowerCase())) gated.add(key);
    else rest.push(key);
  }
  for (const key of entriesOpenedBy(rest, flagged).keys()) gated.add(key);
  return gated;
}

/**
 * The flags that gate `key` right now, and the list each is in. For the
 * commands that clear a flag: removal is exact, so a key can still be gated
 * afterwards — by another spelling in the list, or by the other store's
 * list — and the command has to say so instead of reporting it cleared.
 */
export function flagsGating(key: string): { key: string; scope: 'project' | 'global' }[] {
  const merged = loadConfirmMapMerged();
  const flagged = Object.keys(merged).filter(k => merged[k] === true);
  const exact = merged[key] === true ? [key] : [];
  const holders = [...exact, ...gatingAmong(key, flagged).filter(k => k !== key)];
  if (holders.length === 0) return [];
  const global = loadConfirmMap('global');
  return holders.map(k => ({ key: k, scope: global[k] === true ? 'global' as const : 'project' as const }));
}

/**
 * Carry confirmation flags across a rename: flag each new key.
 *
 * `gated` is what the rename moved and the gate was asking about, old key to
 * new key, one pair per entry. The caller works that out before anything
 * moves — which entries it is about to move, and gatedAmong for them — so
 * nothing here guesses from the shape of a key. Only the flag on the renamed
 * key itself used to move, so renaming a namespace left its entries' flags
 * behind and the renamed commands ran unconfirmed.
 *
 * Nothing is dropped. The old name keeps its flag: see "A rename drops
 * nothing at all" above. `rvr confirm remove` clears it when it is stale.
 */
export function moveConfirm(gated: readonly (readonly [from: string, to: string])[], scope?: Scope  ): void {
  if (gated.length === 0) return;
  const effectiveScope = resolveScopeForWrite(scope);
  const keys = loadConfirmMap(effectiveScope);
  let changed = false;
  for (const [, to] of gated) {
    if (keys[to] === true) continue;
    keys[to] = true;
    changed = true;
  }
  if (!changed) return;
  saveConfirmMap(keys, effectiveScope);
  debug(`Confirm carried to ${gated.length} renamed entr${gated.length === 1 ? 'y' : 'ies'} (${effectiveScope})`);
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
