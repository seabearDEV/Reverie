import { debug } from './utils/debug';
import { Scope, loadConfirmMap, saveConfirmMap, updateConfirmMap, loadConfirmMapMerged, updateUnderBothLocks, type LockedStore } from './store';
import { resolveScopeForWrite } from './projectResolution';
import { assertSidecarsWritable } from './utils/unreadable';
import { entriesOpenedBy, keysOpeningSameEntry, opensEntryFile } from './utils/entryIdentity';
import { flattenObject, removeFlatKeysUnder } from './utils/objectPath';


export function loadConfirmKeys(scope?: Scope  ): Record<string, true> {
  if (!scope || scope === 'auto') {
    return loadConfirmMapMerged();
  }
  return loadConfirmMap(scope);
}

/** Replace the list wholesale (reset). A change to the list goes through updateConfirmMap (#254). */
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
// A rename drops nothing at all (rename.ts). A flag gates by name, and the
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

/**
 * Flag `key` in the list `scope` writes, if it still names an entry. False,
 * with nothing written, when it does not.
 *
 * The callers look the key up first, for the message (confirmTargetProblem),
 * but that look is outside any lock. A rename committed in between moved the
 * entry, and the flag then landed on the old name with the new one unflagged
 * — both commands reporting success (#259). So it is asked again here, under
 * the locks of both stores (the entry may be in either, whichever list is
 * written), by the rule `confirm set` applies: see namesEntry.
 */
export function setConfirm(key: string, scope?: Scope  ): boolean {
  const effectiveScope = resolveScopeForWrite(scope);
  let named = false;
  updateUnderBothLocks(effectiveScope, (target, other) => {
    named = namesEntry(key, other ? [target, other] : [target]);
    if (!named || target.data.confirm[key] === true) return null;
    return { ...target.data, confirm: { ...target.data.confirm, [key]: true } };
  });
  if (named) debug(`Confirm set for key: "${key}"`);
  return named;
}

/**
 * Does `key` name an entry in one of `stores`, as `confirm set` decides it
 * (confirmTargetProblem): stored under that name, case aside, or stored under
 * a name whose file `key` opens. An entry whose file does not parse is still
 * an entry — its file is there. A namespace is not.
 */
function namesEntry(key: string, stores: LockedStore[]): boolean {
  const lower = key.toLowerCase();
  return stores.some(store => opensEntryFile(store.dir, key)
    || Object.keys(flattenObject(store.data.entries)).some(k => k.toLowerCase() === lower));
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
  if (!(key in loadConfirmMap(effectiveScope))) return false;
  // #254: removed from the list as it stands under the lock.
  const removed = changeConfirmList(effectiveScope, keys => {
    if (!(key in keys)) return null;
    const next = { ...keys };
    delete next[key];
    return next;
  });
  if (removed) debug(`Confirm removed for key: "${key}" (${effectiveScope})`);
  return removed;
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
  return gatedByFlags(keys, Object.keys(merged).filter(k => merged[k] === true));
}

/**
 * gatedAmong against a given list of flagged keys, reading no store: for a
 * transaction that holds the lists as they stand under its locks (a rename,
 * #259). Asks the filesystem which files the keys open, so it has to run
 * before the transaction moves any of them.
 */
export function gatedByFlags(keys: readonly string[], flagged: readonly string[]): Set<string> {
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
 * The flags listed under `key` or a key below it in the list `scope` writes —
 * what a removal leaves in place (#244), so the command can say so.
 */
export function flagsListedUnder(key: string, scope?: Scope): string[] {
  const list = loadConfirmMap(resolveScopeForWrite(scope));
  const prefix = key + '.';
  return Object.keys(list).filter(k => list[k] === true && (k === key || k.startsWith(prefix))).sort();
}

// Drop the flags listed under a key and its children (e.g. "commands" drops
// "commands.deploy"). Since #244 no removal calls this: a removal leaves the
// flags, as a rename does, and only `confirm remove` clears one.
export function removeConfirmForKey(key: string, scope?: Scope  ): void {
  const effectiveScope = resolveScopeForWrite(scope);
  removeConfirmFromScope(key, effectiveScope);
}

function removeConfirmFromScope(key: string, scope: 'project' | 'global'): void {
  // Exact, like the removal it follows: see "Changing the list is exact".
  const dropUnder = (keys: Record<string, true>): Record<string, true> | null => {
    const next = { ...keys };
    return removeFlatKeysUnder(next, key) ? next : null;
  };
  // Nothing listed under the key: nothing to write.
  if (dropUnder(loadConfirmMap(scope)) === null) return;
  changeConfirmList(scope, dropUnder);
}

/**
 * Apply `change` to the list as it stands under the store lock (#254), never
 * to a copy loaded earlier: a flag set in between would be dropped. `change`
 * returns the new list, or null when there is nothing to change. True when
 * it wrote.
 */
function changeConfirmList(
  scope: 'project' | 'global',
  change: (keys: Record<string, true>) => Record<string, true> | null,
): boolean {
  let changed = false;
  updateConfirmMap(keys => {
    const next = change(keys);
    changed = next !== null;
    return next;
  }, scope);
  return changed;
}
