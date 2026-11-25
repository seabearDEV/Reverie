/**
 * Entry identity: which keys name the same stored entry.
 *
 * A key maps to its filename verbatim, so which spellings reach one entry is
 * the filesystem's rule, not ours. A default macOS or Windows volume ignores
 * case. APFS also folds Unicode forms: `ſ` opens `s`, `ﬁ` opens `fi`, an NFD
 * name opens an NFC one. HFS+, exFAT and FAT fold case and normalization but
 * not those letters. A case-sensitive volume folds nothing.
 *
 * Nothing done to the names reproduces that. `toLowerCase` misses the
 * letters; `realpath` reports the name it was last given after a rename onto
 * another spelling; a directory listing reports a normalized name on HFS+
 * and exFAT. So the names are not compared here. The filesystem is asked the
 * one thing it answers the same way everywhere: whether two paths are the
 * same file.
 *
 * Used by the confirmation gate (confirm.ts): a command flagged under one
 * spelling must not run unasked under another that opens the same file.
 */
import fs from 'fs';
import { entryFilePath } from './directoryStore';
import { findProjectStoreDir, getGlobalStoreDirPath } from './paths';

/** The store directories a read by key looks in: the project's, if any, then the global one. */
function storeDirs(): string[] {
  const dirs: string[] = [];
  try {
    const project = findProjectStoreDir();
    if (project) dirs.push(project);
  } catch {
    // No project store to look in.
  }
  try {
    dirs.push(getGlobalStoreDirPath());
  } catch {
    // No global store to look in.
  }
  return dirs;
}

/** Device and inode of the entry file `key` opens in `dir`, or undefined when it opens none. */
function entryFileId(dir: string, key: string): string | undefined {
  try {
    // bigint: an inode number can exceed what a double holds exactly.
    const st = fs.statSync(entryFilePath(dir, key), { bigint: true });
    return `${st.dev}:${st.ino}`;
  } catch {
    return undefined;   // not a storable key, or no such file
  }
}

/**
 * The keys among `candidates` that open the same entry file as `key` in some
 * store. `key` itself is not reported. Costs one stat per store for `key`,
 * and one per candidate in each store where `key` opens a file.
 */
export function keysOpeningSameEntry(key: string, candidates: Iterable<string>): string[] {
  const same = new Set<string>();
  const others = [...candidates].filter(c => c !== key);
  if (others.length === 0) return [];
  for (const dir of storeDirs()) {
    const id = entryFileId(dir, key);
    if (id === undefined) continue;
    for (const candidate of others) {
      if (entryFileId(dir, candidate) === id) same.add(candidate);
    }
  }
  return [...same];
}
