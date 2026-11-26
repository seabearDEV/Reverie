/**
 * Key collisions (#216, #224): the writes that would silently remove or
 * overwrite another entry, and the refusal they get instead.
 *
 * A key is a leaf with a value or a parent of other keys, never both, and a
 * key maps to its filename verbatim. Two ways a single write used to destroy
 * entries it did not name:
 *
 *   - **parent / child** — writing a value to a key that has entries under it
 *     removed all of them; writing a key under an existing leaf removed the
 *     leaf. Both reported success.
 *   - **case** — on a case-insensitive filesystem (default macOS, Windows)
 *     two keys that differ only by case are one file, so the second write
 *     replaced the first under a key that listings then did not contain.
 *
 * Keys stay case-preserving and compare case-insensitively: the check is the
 * same on every filesystem, so a store behaves the same on every machine.
 *
 * This module has no store imports on purpose — several test suites mock the
 * store modules with explicit factories.
 */
import type { CodexData } from '../types';
import { flattenObject } from './objectPath';

export type KeyCollisionKind = 'case' | 'fold' | 'parent' | 'child';

export interface KeyCollision {
  kind: KeyCollisionKind;
  /** The key the caller tried to write. */
  key: string;
  /** The existing key(s) in the way, as they are spelled in the store. */
  existing: string[];
}

/** How many existing keys a refusal names before it summarizes the rest. */
const NAMED_KEYS_CAP = 5;

function describeCollision(c: KeyCollision): string {
  const key = `'${c.key}'`;
  if (c.kind === 'case') {
    const other = `'${c.existing[0]}'`;
    return `Refusing to write ${key}: it differs only by case from the existing key ${other}, `
      + `and on a case-insensitive filesystem the two are one file. Write to ${other}, or rename it first.`;
  }
  if (c.kind === 'fold') {
    // #246: a spelling no name comparison catches (APFS folds `ſ` to `s`,
    // `ﬁ` to `fi`, …): the filesystem opened the existing key's file.
    const other = `'${c.existing[0]}'`;
    return `Refusing to write ${key}: on this filesystem it opens the file of the existing key ${other}, `
      + `so the write would replace that entry. Write to ${other}, or pick another key.`;
  }
  if (c.kind === 'child') {
    const other = `'${c.existing[0]}'`;
    return `Refusing to write ${key}: ${other} holds a value, and a key under it would remove that value. `
      + `Rename or remove ${other} first, or pick another key.`;
  }
  const n = c.existing.length;
  const named = c.existing.slice(0, NAMED_KEYS_CAP).map(k => `'${k}'`).join(', ')
    + (n > NAMED_KEYS_CAP ? `, and ${n - NAMED_KEYS_CAP} more` : '');
  return n === 1
    ? `Refusing to write ${key}: it is the parent of an entry (${named}), and a value there would remove it. `
      + `Remove or rename that entry first, or write to a key under ${key}.`
    : `Refusing to write ${key}: it is the parent of ${n} entries (${named}), and a value there would remove them. `
      + `Remove or rename those entries first, or write to a key under ${key}.`;
}

/**
 * A write refused because it would remove or overwrite an entry it did not
 * name. Carries an existing envelope code: this is a request the caller has
 * to change, not a store fault.
 */
export class KeyCollisionError extends Error {
  readonly code = 'INVALID_INPUT' as const;
  readonly collision: KeyCollision;

  constructor(collision: KeyCollision) {
    super(describeCollision(collision));
    this.name = 'KeyCollisionError';
    this.collision = collision;
  }
}

/**
 * What a leaf value written at `key` would collide with among `existingKeys`
 * (the store's leaf keys), or null.
 *
 * The comparison is flat, over every stored key, and case-insensitive. A walk
 * down the tree is not enough: it follows one branch per segment, and a store
 * can hold both `a.*` and `A.*` — then `A.x` has to be compared with `a.x`,
 * which sits in the other branch.
 *
 * Writing over a key that already exists, spelled the same way, is an
 * ordinary overwrite and never a collision, whatever else is in the store: a
 * pair that already differs only by case is `lint`'s to report, and refusing
 * here would leave the entry unwritable.
 */
export function findKeyCollisionAmong(existingKeys: Iterable<string>, key: string): KeyCollision | null {
  const lower = key.toLowerCase();
  const under: string[] = [];
  let leafAbove: string | undefined;
  let caseTwin: string | undefined;
  for (const other of existingKeys) {
    if (other === key) return null;
    const otherLower = other.toLowerCase();
    if (otherLower === lower) caseTwin ??= other;
    else if (otherLower.startsWith(lower + '.')) under.push(other);
    else if (lower.startsWith(otherLower + '.')) leafAbove ??= other;
  }
  if (leafAbove !== undefined) return { kind: 'child', key, existing: [leafAbove] };
  // Sorted: the store's load order is not stable, and the message names these.
  if (under.length > 0) return { kind: 'parent', key, existing: under.sort() };
  if (caseTwin !== undefined) return { kind: 'case', key, existing: [caseTwin] };
  return null;
}

/** findKeyCollisionAmong against the leaf keys of a loaded tree. */
export function findKeyCollision(data: CodexData, key: string): KeyCollision | null {
  return findKeyCollisionAmong(Object.keys(flattenObject(data)), key);
}

/** Throw the refusal for `key` if writing a leaf there collides with `data`. */
export function assertKeyWritable(data: CodexData, key: string): void {
  assertKeysWritable(data, [key]);
}

/**
 * The same check for several keys about to be written together — the leaves
 * of a copied or renamed subtree, or of a merge import. Checked against the
 * store as it stands, before any of them is set, so a refusal leaves nothing
 * half-written. Flattens the tree once.
 */
export function assertKeysWritable(data: CodexData, keys: Iterable<string>): void {
  const existing = Object.keys(flattenObject(data));
  for (const key of keys) {
    const collision = findKeyCollisionAmong(existing, key);
    if (collision) throw new KeyCollisionError(collision);
  }
}

/**
 * Would a single-file write of `key` collide with any of `existingKeys`?
 * The cheap form of the check, for a caller that has a list of keys (a
 * directory listing) and not the tree: it only answers yes or no.
 */
export function collidesWithAny(key: string, existingKeys: Iterable<string>): boolean {
  const lower = key.toLowerCase();
  for (const other of existingKeys) {
    if (other === key) continue;
    const otherLower = other.toLowerCase();
    if (otherLower === lower) return true;
    if (otherLower.startsWith(lower + '.') || lower.startsWith(otherLower + '.')) return true;
  }
  return false;
}

/**
 * Pairs of keys in one list that cannot both exist: equal but for case, or
 * one the parent of the other once case is ignored. For `lint`, and for an
 * import file checked against itself.
 */
export function findCollidingPairs(keys: Iterable<string>): [string, string][] {
  // A key listed twice is one key, not a pair (an import file can name the
  // same entry flat and nested: {"a.b": …, "a": {"b": …}}).
  const sorted = [...new Set(keys)].sort((a, b) => {
    const la = a.toLowerCase(), lb = b.toLowerCase();
    return la < lb ? -1 : la > lb ? 1 : a < b ? -1 : a > b ? 1 : 0;
  });
  const pairs: [string, string][] = [];
  for (let i = 0; i < sorted.length; i++) {
    const lower = sorted[i].toLowerCase();
    for (let j = i + 1; j < sorted.length; j++) {
      const otherLower = sorted[j].toLowerCase();
      if (otherLower === lower || otherLower.startsWith(lower + '.')) {
        pairs.push([sorted[i], sorted[j]]);
      } else if (!otherLower.startsWith(lower)) {
        break;   // sorted: nothing later can match this prefix
      }
    }
  }
  return pairs;
}

/**
 * #267: entries stored under another entry. A key is an entry or a
 * namespace, never both, yet a hand edit or a git merge can leave
 * `ns.k.json` beside `ns.k.sub.json`. The tree the store hands its callers
 * holds the entry, and everything stored under it is hidden. Maps each
 * hidden key to the entry it is hidden under (the topmost one). Exact names:
 * keys that differ by case are lint's case check.
 */
export function entriesUnderEntries(keys: Iterable<string>): Map<string, string> {
  const all = new Set(keys);
  const hidden = new Map<string, string>();
  for (const key of all) {
    for (let i = key.indexOf('.'); i !== -1; i = key.indexOf('.', i + 1)) {
      const prefix = key.slice(0, i);
      if (all.has(prefix)) {
        hidden.set(key, prefix);
        break;
      }
    }
  }
  return hidden;
}

// The entry keys each store's last scan listed, one per file (#267), for
// lint: the tree it reads cannot show both halves of such a pair. Fed by
// store.ts, as the unreadable-file registry is, so that lint.ts needs no new
// import from '../store' — which several suites mock with explicit factories.
const storedKeySources = new Map<'project' | 'global', () => string[]>();

export function registerStoredKeysSource(id: 'project' | 'global', list: () => string[]): void {
  storedKeySources.set(id, list);
}

/** The keys `id`'s last scan in this process listed; none when it has not scanned. No I/O. */
export function storedKeysOf(id: 'project' | 'global'): string[] {
  return storedKeySources.get(id)?.() ?? [];
}

/**
 * Why `oldKey` cannot be renamed to `newKey`, or null when it can be tried.
 *
 * A rename removes the old key with everything under it. When it wrote the
 * new keys first and removed the old one after (before #259), a destination
 * under the source (`arch` → `arch.sub`) wrote the subtree and then deleted
 * it along with the original, and a destination that is not a storable key
 * wrote nothing and still removed the source — both reporting success. A destination that differs from the source only by case
 * is the same file on a case-insensitive filesystem.
 *
 * `isValidKey` is passed in so this module keeps no store imports.
 */
export function renameDestinationProblem(oldKey: string, newKey: string, isValidKey: (key: string) => boolean): string | null {
  if (!isValidKey(newKey)) return `Cannot rename '${oldKey}' to '${newKey}': that is not a valid key.`;
  const oldLower = oldKey.toLowerCase();
  const newLower = newKey.toLowerCase();
  if (newKey === oldKey) return `Cannot rename '${oldKey}' to itself.`;
  if (newLower === oldLower) {
    return `Cannot rename '${oldKey}' to '${newKey}': they differ only by case, which is one file on a case-insensitive filesystem. Rename through a temporary key.`;
  }
  if (newLower.startsWith(oldLower + '.')) {
    return `Cannot rename '${oldKey}' to '${newKey}': the new key is under the old one. Rename through a temporary key.`;
  }
  return null;
}
