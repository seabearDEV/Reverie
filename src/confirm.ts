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
// Keys keep their case and compare without it (#216). The confirmation list
// has to follow the same rule, because the read behind `run` does: on a
// case-insensitive filesystem (default macOS, Windows) `commands.Deploy` opens
// the file of `commands.deploy`, and a list that only matched the exact
// spelling let a flagged entry run unconfirmed under any other one. The
// comparison is the same on every filesystem, so a store is gated the same
// way on every machine.

/** Do `a` and `b` name the same entry? */
function sameKey(a: string, b: string): boolean {
  return a === b || a.toLowerCase() === b.toLowerCase();
}

/**
 * The segments of `key` past `base` when `key` is `base` or a key under it
 * (none for `base` itself), or null when it is neither. Compared a segment at
 * a time: lower-casing can change a string's length, so cutting the original
 * at the lower-cased prefix's length could cut in the wrong place.
 */
function segmentsUnder(key: string, base: string): string[] | null {
  const keySegments = key.split('.');
  const baseSegments = base.split('.');
  if (keySegments.length < baseSegments.length) return null;
  for (let i = 0; i < baseSegments.length; i++) {
    if (!sameKey(keySegments[i], baseSegments[i])) return null;
  }
  return keySegments.slice(baseSegments.length);
}

// Mark a key as requiring confirmation. Another spelling of the same key
// already in the list is replaced, so the list names an entry once.
export function setConfirm(key: string, scope?: Scope  ): void {
  const effectiveScope = resolveScopeForWrite(scope);
  const keys = loadConfirmMap(effectiveScope);
  for (const listed of Object.keys(keys)) {
    if (listed !== key && sameKey(listed, key)) delete keys[listed];
  }
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
  // Every spelling: the gate reads them all as this key, so leaving one
  // behind would report the requirement removed and keep enforcing it.
  const listed = Object.keys(keys).filter(k => sameKey(k, key));
  if (listed.length > 0) {
    for (const k of listed) delete keys[k];
    saveConfirmMap(keys, effectiveScope);
    debug(`Confirm removed for key: "${key}" (${effectiveScope})`);
  }
}

// Check if a key carries the confirm flag (checks merged), under any spelling
// of the key — see sameKey above. Literal in one respect: an unreadable
// confirmation list (#215) loads as empty and this answers false. The run
// gates add confirmListUnreadable() so they fail closed; rename asks this to
// decide whether there is a flag to move, and must get the truth.
export function hasConfirm(key: string): boolean {
  const keys = loadConfirmMapMerged();
  if (keys[key] === true) return true;
  return Object.keys(keys).some(k => keys[k] === true && sameKey(k, key));
}

/**
 * Carry confirmation flags across a rename: the flag on `oldKey` and the flag
 * on every entry under it move to the same place under `newKey`.
 *
 * Only the flag on the renamed key itself used to move, so renaming a
 * namespace left the flags of its entries behind under names that no longer
 * existed, and the renamed commands ran unconfirmed.
 *
 * Which flags to carry is read from the merged list, as the gate reads it: a
 * flag kept in the other scope gated the entry too, and the renamed entry has
 * to stay gated. They are written to — and the old names cleared from — the
 * scope the rename writes to.
 */
export function moveConfirm(oldKey: string, newKey: string, scope?: Scope  ): void {
  const merged = loadConfirmMapMerged();
  const carried: string[] = [];
  for (const listed of Object.keys(merged)) {
    if (merged[listed] !== true) continue;
    const tail = segmentsUnder(listed, oldKey);
    if (tail) carried.push([newKey, ...tail].join('.'));
  }
  if (carried.length === 0) return;
  const effectiveScope = resolveScopeForWrite(scope);
  const keys = loadConfirmMap(effectiveScope);
  for (const listed of Object.keys(keys)) {
    if (segmentsUnder(listed, oldKey)) delete keys[listed];
  }
  for (const key of carried) keys[key] = true;
  saveConfirmMap(keys, effectiveScope);
  debug(`Confirm moved: "${oldKey}" -> "${newKey}" (${carried.length} flag(s), ${effectiveScope})`);
}

// Cascade delete: remove key and any children (e.g., removing "commands" removes "commands.deploy")
export function removeConfirmForKey(key: string, scope?: Scope  ): void {
  const effectiveScope = resolveScopeForWrite(scope);
  removeConfirmFromScope(key, effectiveScope);
}

function removeConfirmFromScope(key: string, scope: 'project' | 'global'): void {
  const keys = loadConfirmMap(scope);
  let changed = false;
  for (const k of Object.keys(keys)) {
    if (segmentsUnder(k, key)) {
      delete keys[k];
      changed = true;
    }
  }
  if (changed) {
    saveConfirmMap(keys, scope);
  }
}
