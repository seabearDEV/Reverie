import { debug } from './utils/debug';
import { Scope, loadConfirmMap, saveConfirmMap, loadConfirmMapMerged } from './store';
import { resolveScopeForWrite } from './projectResolution';
import { assertSidecarsWritable } from './utils/unreadable';
import { keysOpeningSameEntry } from './utils/entryIdentity';


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
// Changing the list is exact. A flag is dropped only under the name it is
// listed as, when the user names it (removeConfirm) or the entry of that name
// is gone (the remove cascade, moveConfirm). Anything looser takes the flag
// of an entry that is still there: `commands.*` and `Commands.*` are two
// namespaces, and a store written on a case-sensitive volume can hold two
// entries that differ only by case, each with its own flag.

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
export function removeConfirm(key: string, scope?: Scope  ): void {
  // Auto collapses to 'project' when resolution succeeds, throws when it
  // fails (#99). The pre-#99 project-then-global fallthrough is dropped for
  // consistency with set/remove on entries and aliases.
  const effectiveScope = resolveScopeForWrite(scope);
  // #215: an unreadable list loads as empty, so "the key is not in it" would
  // be reported as a removal that happened. Refuse instead.
  assertSidecarsWritable(() => effectiveScope, ['confirm']);
  const keys = loadConfirmMap(effectiveScope);
  if (key in keys) {
    delete keys[key];
    saveConfirmMap(keys, effectiveScope);
    debug(`Confirm removed for key: "${key}" (${effectiveScope})`);
  }
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
 * Carry confirmation flags across a rename.
 *
 * `gated` is what the rename moved and the gate was asking about, old key to
 * new key, one pair per entry. The caller works that out before anything
 * moves — which entries it is about to move, and hasConfirm for each — so
 * nothing here guesses from the shape of a key. Guessing "everything under
 * the old key" took flags from entries that never moved: one in a namespace
 * spelled in another case, one in the other scope. Only the flag on the
 * renamed key itself used to move at all, so renaming a namespace left its
 * entries' flags behind and the renamed commands ran unconfirmed.
 *
 * Each new key is flagged in the scope the rename writes to. The old name is
 * dropped from that scope's list only under its exact spelling, and only if
 * `stillStored` says the old key no longer reads in either store: a rename
 * leaves an entry of the same name in the other store where it was, and that
 * entry was gated by this flag too.
 */
export function moveConfirm(
  gated: readonly (readonly [from: string, to: string])[],
  scope: Scope | undefined,
  stillStored: (key: string) => boolean,
): void {
  if (gated.length === 0) return;
  const effectiveScope = resolveScopeForWrite(scope);
  const keys = loadConfirmMap(effectiveScope);
  for (const [from, to] of gated) {
    keys[to] = true;
    if (from in keys && !stillStored(from)) delete keys[from];
  }
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
