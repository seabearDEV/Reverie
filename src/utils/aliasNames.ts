/**
 * Alias names that are entry keys (#279).
 *
 * resolveKey looks a name up in the alias map before it looks for an entry,
 * so an alias named after an entry stands in for that entry wherever the name
 * is used: `run`, `get`, a `${name}` in another value. A merge import or an
 * `alias set` could add one over a confirm-gated entry, and the name then ran
 * the alias's target unasked. The run gate now checks the name as written as
 * well, which closes that; an alias over an entry still hides the entry, and
 * nothing a user means to do needs one. So every write that adds an alias
 * refuses a name that is an entry's key in either store — under that
 * spelling, another case, or a spelling the filesystem opens its file under
 * (entryNamedBy).
 *
 * The store being written is checked as it stands under its lock; the other
 * store is read just before, without its lock.
 */
import { hasProjectStore, loadEntries } from '../store';
import type { CodexData } from '../types';
import { flattenObject } from './objectPath';
import { KeyCollisionError } from './keyCollision';
import { entryNamedBy } from './entryIdentity';

/** The entry keys of the store a write does not write; none outside a project when the global store is written. */
export function otherStoreEntryKeys(written: 'project' | 'global'): string[] {
  if (written === 'global' && !hasProjectStore()) return [];
  return Object.keys(flattenObject(loadEntries(written === 'project' ? 'global' : 'project')));
}

/** The entry keys a store's state holds: the leaves of its tree, and the entries hidden under another entry (#267). */
export function entryKeysIn(state: { entries: CodexData; hidden?: readonly string[] | undefined }): string[] {
  return [...Object.keys(flattenObject(state.entries)), ...(state.hidden ?? [])];
}

/** Throw the refusal (INVALID_INPUT) for the first of `names` that names one of `entryKeys`, or an entry file in either store. */
export function assertAliasNamesFree(names: Iterable<string>, entryKeys: Iterable<string>): void {
  const keys = new Set(entryKeys);
  for (const name of names) {
    const entry = entryNamedBy(name, keys);
    if (entry !== undefined) throw new KeyCollisionError({ kind: 'alias', key: name, existing: [entry] });
  }
}

/**
 * assertAliasNamesFree against both stores as they stand now, read without
 * a lock, plus `alsoKeys` (an entry the same command is about to write): for
 * a command whose alias is written after something else, so the refusal
 * comes before its first write. The alias write checks again under its lock.
 */
export function assertAliasNameFreeNow(name: string, alsoKeys: readonly string[] = []): void {
  const keys = [...Object.keys(flattenObject(loadEntries('global'))), ...alsoKeys];
  if (hasProjectStore()) keys.push(...Object.keys(flattenObject(loadEntries('project'))));
  assertAliasNamesFree([name], keys);
}
