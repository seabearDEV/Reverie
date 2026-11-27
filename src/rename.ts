/**
 * Rename an entry or a namespace: one transaction (#259).
 *
 * A rename moves the value, re-points the aliases that name it, and flags
 * the new key of every gated entry it moves. It used to do those as separate
 * store writes, deciding what to move and which entries were gated before
 * taking any lock. Three ways that went wrong, each with every command
 * reporting success: a flag set in between landed on the old name only, so
 * the renamed command ran unconfirmed; a lock held by another process between
 * two of the writes left the value moved and its flag behind; and an entry
 * written under the old namespace in between was removed with it, under
 * neither name.
 *
 * Now everything is decided from the stores as they stand under their locks,
 * and written in one store write. The flags can come from either store's
 * list (the global list is read in every project), so both stores' locks
 * are held: see updateUnderBothLocks for the lock order. A refusal, or a
 * lock that cannot be had, writes nothing.
 *
 * Shared by `rvr rename` and `reverie_rename`. Each surface keeps its own
 * pre-checks and wording; this module decides, and throws a RenameRefusal
 * (or a KeyCollisionError / StoreUnreadableError) when the rename cannot go
 * ahead.
 */
import path from 'path';
import type { CodexValue } from './types';
import { type Scope, type LockedStore, updateUnderBothLocks } from './store';
import { resolveScopeForWrite } from './projectResolution';
import { gatedByFlags } from './confirm';
import { KeyCollisionError, assertKeysWritable, renameDestinationProblem } from './utils/keyCollision';
import { flattenObject, getNestedValue, removeNestedValue, removeFlatKeysUnder, setNestedValue } from './utils/objectPath';
import { StoreUnreadableError } from './utils/unreadable';
import { storedSpellingOf } from './utils/entryIdentity';
import { isValidEntryKey } from './utils/directoryStore';
import { assertAliasNamesFree } from './utils/aliasNames';

/** A rename that cannot go ahead as asked. Nothing was written. */
export class RenameRefusal extends Error {
  readonly code: 'NOT_FOUND' | 'INVALID_INPUT';

  constructor(message: string, code: 'NOT_FOUND' | 'INVALID_INPUT') {
    super(message);
    this.name = 'RenameRefusal';
    this.code = code;
  }
}

export interface RenameResult {
  /** The entries moved, old key to new key, one pair per entry. */
  moved: [from: string, to: string][];
  /** Of those, the ones a flag gated: each is now flagged under its new key as well. */
  flagged: [from: string, to: string][];
}

/**
 * Move `oldKey` — an entry, or a namespace and everything under it — to
 * `newKey` in the store `scope` writes, and set `newAlias` on it. All of it
 * or none of it.
 *
 * Lookups are main's (#99): in the default scope inside a project, the
 * source and the "already exists" check fall through to the global store,
 * as every read by key does. A global entry renamed that way is copied into
 * the project and stays where it was, and the aliases are re-pointed in the
 * view that layers the project map over the global one.
 *
 * The source must be named as it is stored (#247). A key maps to its file,
 * and a filesystem that folds names opens an entry's file for another
 * spelling of it — another case on default macOS, `ſ` for `s` on APFS. The
 * removal is by name, so a rename through such a spelling used to copy the
 * entry and report it renamed. Whether a spelling reaches an entry is asked
 * of the filesystem (entryIdentity), not worked out from the names. The
 * same name in another Unicode normalization is the one exception: as for
 * every write (#253), it is that key, and the stored one is renamed. A
 * namespace has no file of its own, so another spelling of one opens
 * nothing and is not found, as before.
 */
export function renameKey(oldKey: string, newKey: string, scope: Scope | undefined, newAlias?: string): RenameResult {
  const destinationProblem = renameDestinationProblem(oldKey, newKey, isValidEntryKey);
  if (destinationProblem) throw new RenameRefusal(destinationProblem, 'INVALID_INPUT');
  if (newAlias && !isValidEntryKey(newAlias)) {
    throw new RenameRefusal(`Invalid alias name: ${JSON.stringify(newAlias)}`, 'INVALID_INPUT');
  }

  const writeScope = resolveScopeForWrite(scope);
  const fallsThrough = (!scope || scope === 'auto') && writeScope === 'project';
  let result: RenameResult = { moved: [], flagged: [] };

  try {
    updateUnderBothLocks(writeScope, (target, other) => {
      assertListsReadable(oldKey, target, other);
      assertNothingUnreadableUnder(oldKey, target);
      const lookIn = fallsThrough && other ? [target, other] : [target];

      // The source, as it stands now, under the name it is stored as.
      let found: { store: LockedStore; key: string; value: CodexValue } | undefined;
      for (const store of lookIn) {
        const value = getNestedValue(store.data.entries, oldKey);
        if (value !== undefined) {
          found = { store, key: oldKey, value };
          break;
        }
        const stored = storedSpellingOf(store.dir, oldKey, storedKeys(store));
        if (stored !== undefined) {
          // #253: the same name in another Unicode normalization is that key —
          // HFS+ and exFAT list names in NFD, so the key typed and the key
          // listed can differ only so. Any other spelling is refused (#247).
          if (!sameUnderNFC(stored, oldKey)) throw new RenameRefusal(anotherSpelling(oldKey, stored), 'INVALID_INPUT');
          const storedValue = getNestedValue(store.data.entries, stored);
          if (storedValue !== undefined) {
            found = { store, key: stored, value: storedValue };
            break;
          }
        }
        const broken = store.unreadable.find(f => f.kind === 'entry' && f.key === oldKey);
        if (broken) throw new StoreUnreadableError([broken], 'read');
      }
      if (!found) throw new RenameRefusal(`Entry '${oldKey}' not found.`, 'NOT_FOUND');
      const source = found.key;
      // A leaf and entries under it, both on disk (a hand edit, a merge) —
      // the source itself, or any key in the namespace it moves: the tree a
      // rename works on holds only one of them, and the write would delete
      // the other. Refused, naming both, until it is resolved.
      // Each key's dot prefixes looked up in a set: linear, where comparing
      // every key with every other took seconds inside both locks on a
      // namespace of thousands.
      const moving = storedKeys(found.store).filter(k => k === source || k.startsWith(`${source}.`)).sort();
      const movingSet = new Set(moving);
      const namespaces = new Set<string>();
      for (const k of moving) {
        for (let i = k.indexOf('.'); i !== -1; i = k.indexOf('.', i + 1)) {
          const prefix = k.slice(0, i);
          if (movingSet.has(prefix)) namespaces.add(prefix);
        }
      }
      const pair = moving.find(k => namespaces.has(k));
      if (pair !== undefined) {
        const under = moving.filter(o => o.startsWith(`${pair}.`));
        const named = under.slice(0, 3).map(k => `'${k}'`).join(', ') + (under.length > 3 ? `, and ${under.length - 3} more` : '');
        throw new RenameRefusal(`Cannot rename '${oldKey}': '${pair}' is stored both as an entry and as a namespace (${named}), `
          + `and a rename would lose one of them, so nothing was renamed. \`rvr copy\` what you want to keep to a free key; `
          + `\`rvr rm ${pair}\` then removes both.`, 'INVALID_INPUT');
      }
      if (source !== oldKey) {
        const problem = renameDestinationProblem(source, newKey, isValidEntryKey);
        if (problem) throw new RenameRefusal(problem, 'INVALID_INPUT');
        assertNothingUnreadableUnder(source, target);
      }

      // The destination: free, under its own name and under any it opens —
      // a namespace too, where it is the same name in another normalization.
      for (const store of lookIn) {
        if (getNestedValue(store.data.entries, newKey) !== undefined
          || storedSpellingOf(store.dir, newKey, storedKeys(store)) !== undefined
          || storedNamespaceUnderNFC(store, newKey) !== undefined) {
          throw new RenameRefusal(`Entry '${newKey}' already exists. Remove it first or choose a different key.`, 'INVALID_INPUT');
        }
      }
      const values = flattenObject({ [source]: found.value });
      const moved = Object.keys(values).map((from): [string, string] => [from, newKey + from.slice(source.length)]);
      // #216 / #224 / #246: no new key may land on an entry it does not name.
      // Checked with the source still in place, as the separate writes were.
      assertKeysWritable(target.data.entries, moved.map(([, to]) => to));
      const targetKeys = new Set(storedKeys(target));
      for (const [, to] of moved) {
        // #253: a twin under the same name in another normalization is that
        // key, not a collision — as for every other write (foldTwin).
        const twin = storedSpellingOf(target.dir, to, targetKeys);
        if (twin !== undefined && !sameUnderNFC(twin, to)) throw new KeyCollisionError({ kind: 'fold', key: to, existing: [twin] });
      }

      // Which of them is gated: by a flag in either list, under its name, case
      // aside, or under a name that opens its file. Asked before the files move.
      const listed = (list: Record<string, unknown>): string[] => Object.keys(list).filter(k => list[k] === true);
      const gated = gatedByFlags(moved.map(([from]) => from), [...listed(target.data.confirm), ...listed(other?.data.confirm ?? {})]);
      const flagged = moved.filter(([from]) => gated.has(from));

      // The new state of the store written.
      const entries = target.data.entries;
      const meta = { ...(target.data._meta ?? {}) };
      if (found.store === target) {
        removeNestedValue(entries, source);
        removeFlatKeysUnder(meta, source);
      }
      const now = Date.now();
      for (const [from, to] of moved) {
        setNestedValue(entries, to, values[from]);
        meta[to] = now;
      }
      const aliasView = fallsThrough && other ? { ...other.data.aliases, ...target.data.aliases } : target.data.aliases;
      let aliases = repointAliases(aliasView, source, newKey) ?? target.data.aliases;
      if (newAlias) {
        // #279: not under a name that is an entry's key once the rename is
        // done, in either store — the old key is free if it moved away.
        const movedAway = (k: string): boolean => found.store === target && (k === source || k.startsWith(`${source}.`));
        assertAliasNamesFree([newAlias], [
          ...Object.keys(flattenObject(entries)),
          ...(target.data.hidden ?? []).filter(k => !movedAway(k)),
          ...(other ? storedKeys(other) : []),
        ]);
        aliases = withAlias(aliases, newAlias, newKey);
      }
      // A rename removes no flag (#234): the old name's may gate an entry of
      // that name somewhere this rename cannot see. It adds the new key's.
      const confirm = { ...target.data.confirm };
      for (const [, to] of flagged) confirm[to] = true;

      result = { moved, flagged };
      return { ...target.data, entries, _meta: meta, aliases, confirm };
    });
  } catch (err) {
    // A key is a file name, and how long one may be is the filesystem's rule
    // (APFS does not count it in bytes): the write is the test. It failed
    // before anything was deleted, and the store took back what it wrote.
    if (isErrnoCode(err, 'ENAMETOOLONG')) {
      throw new RenameRefusal(`'${keyInPath(err, newKey)}' is too long for a file name on this filesystem; nothing was renamed.`, 'INVALID_INPUT');
    }
    throw err;
  }
  return result;
}

function isErrnoCode(err: unknown, code: string): boolean {
  return !!err && typeof err === 'object' && 'code' in err && err.code === code;
}

/** The key whose entry file (or its temp file) a failed write was creating; `fallback` if the error does not say. */
function keyInPath(err: unknown, fallback: string): string {
  const failed = !!err && typeof err === 'object' && 'path' in err && typeof err.path === 'string' ? path.basename(err.path) : '';
  const match = /^(.*)\.json(?:\.[0-9a-f]{16}\.tmp)?$/.exec(failed);
  return match ? match[1] : fallback;
}

/** The store's entry keys, one per file — a leaf and an entry under it both, where both are on disk. */
function storedKeys(store: LockedStore): string[] {
  return store.keys;
}

function sameUnderNFC(a: string, b: string): boolean {
  return a.normalize('NFC') === b.normalize('NFC');
}

/**
 * The stored spelling of the namespace `key` names in another Unicode
 * normalization (#253), or undefined. A namespace has no file of its own, so
 * the filesystem is asked about an entry under it: whether `key`'s spelling
 * of that entry's path opens the entry's file.
 */
function storedNamespaceUnderNFC(store: LockedStore, key: string): string | undefined {
  const depth = key.split('.').length;
  const keys = storedKeys(store);
  for (const stored of keys) {
    const parts = stored.split('.');
    if (parts.length <= depth) continue;
    const prefix = parts.slice(0, depth).join('.');
    if (prefix === key || !sameUnderNFC(prefix, key)) continue;
    if (storedSpellingOf(store.dir, key + stored.slice(prefix.length), [stored]) === stored) return prefix;
  }
  return undefined;
}

function anotherSpelling(oldKey: string, stored: string): string {
  return `Cannot rename '${oldKey}': the entry it opens is stored as '${stored}'. `
    + `A rename moves an entry by its stored name — did you mean '${stored}'?`;
}

/**
 * #215 / #245: what the rename writes must be readable, and so must every
 * list a flag could come from. The written store's alias map and list get the
 * refusal any write to them gets. The other store's list is only read, but
 * with it unreadable the rename cannot see the flags in it, and the moved
 * entry would run unconfirmed once the list is repaired.
 */
function assertListsReadable(oldKey: string, target: LockedStore, other: LockedStore | undefined): void {
  const own = target.unreadable.filter(f => f.kind === 'aliases' || f.kind === 'confirm');
  if (own.length > 0) throw new StoreUnreadableError(own, 'write');
  const theirs = other?.unreadable.filter(f => f.kind === 'confirm') ?? [];
  if (other && theirs.length > 0) {
    throw new StoreUnreadableError(theirs, 'write',
      `Refusing to rename '${oldKey}' while the ${other.scope} store's confirmation list cannot be read (a rename flags the new key of every gated entry it moves, and the flag may be in that list)`);
  }
}

/**
 * #215: an unreadable entry under the old key would stay behind while its
 * alias moves. Asked again here, of the store as it stands under the lock.
 */
function assertNothingUnreadableUnder(oldKey: string, target: LockedStore): void {
  const prefix = `${oldKey}.`;
  const broken = target.unreadable.filter(f => f.kind === 'entry' && f.key?.startsWith(prefix));
  if (broken.length > 0) {
    throw new StoreUnreadableError(broken, 'write', `Refusing to rename '${oldKey}' while entry '${broken[0].key}' under it cannot be read`);
  }
}

/**
 * The alias map with every alias that targets `oldKey`, or a key under it,
 * pointed at the same place under `newKey` — or null when none does. One
 * alias per entry, as setAlias keeps it: an alias already on a new target
 * gives way to the one that moved there.
 */
function repointAliases(current: Record<string, string>, oldKey: string, newKey: string): Record<string, string> | null {
  const oldPrefix = oldKey + '.';
  const updates: [string, string][] = [];
  for (const [alias, target] of Object.entries(current)) {
    if (target === oldKey) updates.push([alias, newKey]);
    else if (target.startsWith(oldPrefix)) updates.push([alias, newKey + target.slice(oldKey.length)]);
  }
  if (updates.length === 0) return null;
  const aliases = { ...current };
  const newTargets = new Set(updates.map(([, t]) => t));
  for (const [alias, target] of Object.entries(aliases)) {
    if (newTargets.has(target)) delete aliases[alias];
  }
  for (const [alias, target] of updates) aliases[alias] = target;
  return aliases;
}

/** `aliases` with `alias` pointing at `key`, taking the place of the alias `key` had (setAlias's rule). */
function withAlias(aliases: Record<string, string>, alias: string, key: string): Record<string, string> {
  const next = { ...aliases };
  let existing: string | undefined;
  for (const [name, target] of Object.entries(next)) if (target === key) existing = name;
  if (existing !== undefined && existing !== alias) delete next[existing];
  next[alias] = key;
  return next;
}
