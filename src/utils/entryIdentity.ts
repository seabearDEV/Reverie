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
 * For each of `keys`, the `candidates` that open the same entry file in some
 * store. A key is never matched with itself, and a key with no match is left
 * out of the result.
 *
 * One pass: each candidate's file is looked up once per store, then each key's
 * once. Asking key by key instead costs keys × candidates lookups, which a
 * rename of a large namespace turned into seconds.
 */
export function entriesOpenedBy(keys: Iterable<string>, candidates: Iterable<string>): Map<string, string[]> {
  const matches = new Map<string, string[]>();
  const wanted = [...candidates];
  if (wanted.length === 0) return matches;
  const asked = [...keys];
  for (const dir of storeDirs()) {
    const byFile = new Map<string, string[]>();
    for (const candidate of wanted) {
      const id = entryFileId(dir, candidate);
      if (id === undefined) continue;
      const names = byFile.get(id);
      if (names) names.push(candidate);
      else byFile.set(id, [candidate]);
    }
    if (byFile.size === 0) continue;
    for (const key of asked) {
      // A candidate under this very name needs no lookup, and is not a match.
      const id = entryFileId(dir, key);
      if (id === undefined) continue;
      for (const candidate of byFile.get(id) ?? []) {
        if (candidate === key) continue;
        const found = matches.get(key);
        if (!found) matches.set(key, [candidate]);
        else if (!found.includes(candidate)) found.push(candidate);
      }
    }
  }
  return matches;
}

/**
 * The keys among `candidates` that open the same entry file as `key` in some
 * store. `key` itself is not reported.
 */
export function keysOpeningSameEntry(key: string, candidates: Iterable<string>): string[] {
  return entriesOpenedBy([key], candidates).get(key) ?? [];
}
