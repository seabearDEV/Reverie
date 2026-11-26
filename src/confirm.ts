import { debug } from './utils/debug';
import { Scope, loadConfirmMap, saveConfirmMap, updateConfirmMap, loadConfirmMapMerged, updateUnderBothLocks, inspectBothStores, findProjectFile, type LockedStore, type UnifiedData } from './store';
import { resolveScopeForWrite } from './projectResolution';
import { assertSidecarsWritable } from './utils/unreadable';
import { entriesOpenedBy, keysOpeningSameEntry, opensEntryFile, storedSpellingOf } from './utils/entryIdentity';
import { removeFlatKeysUnder } from './utils/objectPath';


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

/** Where `setConfirm` listed a flag. */
export interface FlagSet {
  /** The name the flag is listed under: the entry's stored spelling (#255). */
  key: string;
  /** The list it is in. */
  scope: 'project' | 'global';
  /**
   * Why it is not in the project's list, when that was the list asked for:
   *   - `globalOnly`: the entry is stored only in the global store (#256);
   *   - `opensGlobal`: the key opens the global store's entry, and the
   *     project holds only another spelling of it (a case-sensitive volume);
   * and why it is in the project's list though the global one was wanted:
   *   - `globalUnwritable`: the global store cannot be written, so the flag
   *     is in this project's list — it applies only here (owner, #256 review).
   */
  moved?: 'globalOnly' | 'opensGlobal' | 'globalUnwritable';
}

/**
 * Flag the entry `key` names, if it names one; false, with nothing written,
 * when it does not. Shared by `confirm set`, the flag-only `set --confirm`
 * and the prompt after a plain `set`.
 *
 * Decided from a read of both stores (inspectBothStores), then written to
 * the one list chosen, and nothing else: a store that is not written is not
 * opened for writing, so a read-only project or data directory does not fail
 * a flag that goes in the other list. The write asks again, under the locks,
 * whether the key still names an entry (#259): a rename or a removal since
 * the read leaves nothing under this name, and a flag there would gate
 * nothing that moved.
 *
 *   - The list (#256). An entry stored only in the global store takes a flag
 *     in the global list, whatever list was asked for. A flag gates by name,
 *     and a project's list is seen only in that project: a `rename -G` run
 *     from another project moved the entry and carried no flag it could not
 *     see, and the renamed command ran unasked where the flag was set. An
 *     entry in the project store, alone or over a global one, takes the list
 *     asked for: the project's by default, the global one with -G. Where the
 *     global store cannot be written, the flag of a global-only entry goes in
 *     the project's list instead, and the caller says what that means.
 *   - The name (#255). The flag is listed under the entry's stored spelling,
 *     not the one typed — the spelling in the store whose list is written,
 *     when the key names an entry there, else in the other. A spelling the
 *     filesystem folds onto the entry (`ſ` for `s`, `ﬁ` for `fi` on APFS)
 *     opens nothing on a case-sensitive volume or on Linux: a flag listed
 *     that way, copied there in a clone, gated nothing.
 */
export function setConfirm(key: string, scope?: Scope  ): FlagSet | false {
  const requested = resolveScopeForWrite(scope);
  for (let attempt = 0; ; attempt++) {
    const plan = inspectBothStores((project, global) => planFlag(key, requested, project, global));
    if (plan === undefined) return false;
    // Listed there already: the read is the answer, and nothing is opened
    // for writing — a store this process cannot write included.
    if (plan.listed) return done(key, plan.result);
    // The last attempt writes the global list whatever it finds: a flag
    // there gates the entry in every project, wherever it is by then.
    const target = attempt >= 2 ? 'global' : plan.result.scope;
    let outcome: FlagSet | false | 'replan';
    try {
      outcome = writeFlag(key, requested, target);
    } catch (err) {
      // The global store cannot be written: the flag of an entry the project
      // asked to flag goes in its own list, said so by the caller. Asked for
      // with -G, or an unreadable list (STORE_UNREADABLE), it fails as before.
      if (target !== 'global' || requested !== 'project' || !isUnwritable(err)) throw err;
      outcome = writeFlag(key, requested, 'project', true);
    }
    if (outcome !== 'replan') return done(key, outcome);
  }
}

function done(key: string, result: FlagSet | false): FlagSet | false {
  if (result) debug(`Confirm set for key: "${key}" as "${result.key}" (${result.scope}${result.moved ? `, ${result.moved}` : ''})`);
  return result;
}

/** A write refused by the filesystem for want of permission: a read-only directory or file. */
function isUnwritable(err: unknown): boolean {
  const code = !!err && typeof err === 'object' && 'code' in err ? err.code : undefined;
  return code === 'EACCES' || code === 'EPERM' || code === 'EROFS';
}

/**
 * Write the flag in `target`'s list, deciding again under the locks. 'replan'
 * when the project's list was chosen and the entry is no longer the project's
 * (moved or removed since the read): writing it there would be the flag
 * #256 removed. `fallback`: the project's list because the global store cannot
 * be written — written wherever the entry is.
 */
function writeFlag(key: string, requested: 'project' | 'global', target: 'project' | 'global', fallback = false): FlagSet | false | 'replan' {
  let outcome: FlagSet | false | 'replan' = false;
  updateUnderBothLocks(target, (written, other) => {
    const project = written.scope === 'project' ? written : other;
    const global = written.scope === 'global' ? written : other;
    const plan = planFlag(key, requested, project, global);
    if (plan === undefined) {
      outcome = false;
      return null;
    }
    if (!fallback && written.scope === 'project' && plan.result.scope !== 'project') {
      outcome = 'replan';
      return null;
    }
    const listed = spellingFor(key, written, written === project ? global : project) ?? key;
    outcome = {
      key: listed,
      scope: written.scope,
      ...(fallback ? { moved: 'globalUnwritable' as const } : written.scope === plan.result.scope && plan.result.moved ? { moved: plan.result.moved } : {}),
    };
    return withFlag(written.data, listed);
  });
  return outcome;
}

/**
 * Which list the flag of `key` goes in, under which name, and whether it is
 * listed there already; undefined when `key` names no entry in either store.
 * See setConfirm for the rules.
 */
function planFlag(
  key: string,
  requested: 'project' | 'global',
  project: LockedStore | undefined,
  global: LockedStore | undefined,
): { result: FlagSet; listed: boolean } | undefined {
  const inProject = project ? howNamed(project, key) : 'no';
  const inGlobal = global ? howNamed(global, key) : 'no';
  if (inProject === 'no' && inGlobal === 'no') return undefined;
  // The entry `key` reaches, as `run` reads it: a store whose file it opens,
  // the project's first; else one that holds it under another case.
  const reachesGlobal = global !== undefined && inProject !== 'file' && (inGlobal === 'file' || inProject === 'no');
  let scope: 'project' | 'global';
  let moved: FlagSet['moved'];
  if (requested === 'global' || project === undefined) scope = global ? 'global' : 'project';
  else if (reachesGlobal) {
    scope = 'global';
    moved = inProject === 'no' ? 'globalOnly' : 'opensGlobal';
  } else scope = 'project';
  const target = scope === 'global' ? global : project;
  const other = scope === 'global' ? project : global;
  const spelling = (target && spellingFor(key, target, other)) ?? key;
  return {
    result: { key: spelling, scope, ...(moved ? { moved } : {}) },
    listed: target?.data.confirm[spelling] === true,
  };
}

/**
 * How `key` names an entry of `store`: 'file' when its path opens an entry
 * file there — stored under that name, under a spelling the filesystem folds
 * it onto, or a file that does not parse, which is still an entry; 'name'
 * when a stored key differs from it only by case and no file is shared (a
 * case-sensitive volume — a flag gates its name case aside); 'no' otherwise.
 * A namespace is not an entry.
 */
function howNamed(store: LockedStore, key: string): 'file' | 'name' | 'no' {
  if (opensEntryFile(store.dir, key)) return 'file';
  const lower = key.toLowerCase();
  return entryNames(store).some(k => k.toLowerCase() === lower) ? 'name' : 'no';
}

/**
 * The stored spelling to list a flag under (#255): from `store`, the one
 * whose list is written, when `key` names an entry there; else from `other`.
 * Undefined when it names none in either.
 */
function spellingFor(key: string, store: LockedStore, other: LockedStore | undefined): string | undefined {
  if (howNamed(store, key) !== 'no') return storedSpelling(store, key);
  if (other && howNamed(other, key) !== 'no') return storedSpelling(other, key);
  return undefined;
}

/** `data` with `key` flagged, or null when it already is. */
function withFlag(data: UnifiedData, key: string): UnifiedData | null {
  if (data.confirm[key] === true) return null;
  return { ...data, confirm: { ...data.confirm, [key]: true } };
}

/** The entry keys of `store`, one per file, its unreadable entries included: their files are there. */
function entryNames(store: LockedStore): string[] {
  const unreadable = store.unreadable.flatMap(f => f.kind === 'entry' && f.key !== undefined ? [f.key] : []);
  return unreadable.length === 0 ? store.keys : [...store.keys, ...unreadable];
}

/**
 * The name the entry `key` names in `store` is stored under (#255): `key`
 * itself when it is; otherwise the stored key whose file `key` opens —
 * another case on a filesystem that ignores case, a letter APFS folds, the
 * same name in another Unicode normalization; otherwise the one stored key
 * that differs from it only by case. When several do (a case-sensitive
 * volume can hold `ops.x` and `OPS.x`) and none is `key`, the spelling typed
 * is kept: it gates each of them by name.
 */
function storedSpelling(store: LockedStore, key: string): string {
  const names = entryNames(store);
  if (names.includes(key)) return key;
  const opened = storedSpellingOf(store.dir, key, names);
  if (opened !== undefined) return opened;
  const lower = key.toLowerCase();
  const byCase = names.filter(k => k.toLowerCase() === lower);
  return byCase.length === 1 ? byCase[0] : key;
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
  if (!isListed(loadConfirmMap(effectiveScope), key)) return false;
  // #254: removed from the list as it stands under the lock.
  const removed = changeConfirmList(effectiveScope, keys => {
    if (!isListed(keys, key)) return null;
    const next = { ...keys };
    delete next[key];
    return next;
  });
  if (removed) debug(`Confirm removed for key: "${key}" (${effectiveScope})`);
  return removed;
}

/**
 * Is `key` flagged in `list` — its own entry, holding `true`? Not `key in
 * list`: a list is a plain object, and `constructor` or `toString` are in
 * every one of those (#257).
 */
function isListed(list: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(list, key) && list[key] === true;
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
 * The flags that gate `key` right now, and the list each is in — one row
 * per list, so a name flagged in both lists is named in both (#257): clearing
 * it from one still leaves the other. For the commands that clear a flag:
 * removal is exact, so a key can still be gated afterwards — by another
 * spelling in the list, or by the other store's list — and the command has
 * to say so instead of reporting it cleared.
 */
export function flagsGating(key: string): { key: string; scope: 'project' | 'global' }[] {
  const held: { key: string; scope: 'project' | 'global' }[] = [];
  const lists: ['project' | 'global', Record<string, unknown>][] = [];
  if (findProjectFile()) lists.push(['project', loadConfirmMap('project')]);
  lists.push(['global', loadConfirmMap('global')]);
  for (const [scope, list] of lists) {
    const flagged = Object.keys(list).filter(k => list[k] === true);
    const exact = isListed(list, key) ? [key] : [];
    for (const k of [...exact, ...gatingAmong(key, flagged).filter(k => k !== key)]) held.push({ key: k, scope });
  }
  return held;
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
