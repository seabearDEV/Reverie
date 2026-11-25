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

export type KeyCollisionKind = 'case' | 'parent' | 'child';

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

function isBranch(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

/**
 * What a leaf value written at `key` would collide with in `data`, or null.
 * Writing over the same key, spelled the same way, is an ordinary overwrite
 * and not a collision.
 */
export function findKeyCollision(data: CodexData, key: string): KeyCollision | null {
  const parts = key.split('.');
  const stored: string[] = [];   // the path as the store spells it
  let node: Record<string, unknown> = data;

  for (let i = 0; i < parts.length; i++) {
    const segment = parts[i];
    const match = Object.prototype.hasOwnProperty.call(node, segment)
      ? segment
      : Object.keys(node).find(k => k.toLowerCase() === segment.toLowerCase());
    if (match === undefined) return null;   // nothing stored here: the rest of the path is new
    stored.push(match);
    const value = node[match];

    if (i < parts.length - 1) {
      // An ancestor of `key`. A leaf here would be replaced by a subtree.
      if (!isBranch(value)) return { kind: 'child', key, existing: [stored.join('.')] };
      node = value;
      continue;
    }

    // The key itself.
    const storedKey = stored.join('.');
    if (isBranch(value)) {
      // Sorted: the store's load order is not stable, and the message names these.
      return { kind: 'parent', key, existing: Object.keys(flattenObject({ [storedKey]: value })).sort() };
    }
    return storedKey === key ? null : { kind: 'case', key, existing: [storedKey] };
  }
  return null;
}

/** Throw the refusal for `key` if writing a leaf there collides with `data`. */
export function assertKeyWritable(data: CodexData, key: string): void {
  const collision = findKeyCollision(data, key);
  if (collision) throw new KeyCollisionError(collision);
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
  const sorted = [...keys].sort((a, b) => {
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
