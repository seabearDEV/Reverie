/**
 * File-per-entry directory store (v1.10.0 layout).
 *
 * Each entry lives in `<dir>/<dotted-key>.json` as a wrapper of the form
 * `{ value, meta?: { created?, updated? } }`. Store-level state lives in
 * sidecar files `_aliases.json` and `_confirm.json`. The lock file lives
 * *outside* the directory at `<dir>.lock` so bulk-op atomicity swaps can
 * rename the directory itself without clobbering the lock.
 *
 * This module implements the `ScopedStore` interface defined in `../store`,
 * so it is a drop-in replacement for `createScopedStore` — consumers above
 * the store layer see the same `UnifiedData` shape on load/save.
 *
 * Design and decisions: see GitHub issue #54 and the `arch.storeLayout`
 * Reverie entry.
 */

import fs from 'fs';
import path from 'path';
import { CodexData, CodexValue } from '../types';
import type { ScopedStore, UnifiedData } from '../store';
import { atomicWriteFileSync } from './atomicWrite';
import { STORE_LOCK_WAIT_MS, withFileLock } from './fileLock';

/** A store write's lock: it may wait for other writers' transactions (#254). */
function withStoreLock<T>(dir: string, fn: () => T): T {
  // The lock file is a write too, beside the store (#274).
  assertNotTestCheckout(dir);
  return withFileLock(getStoreLockKey(dir), fn, STORE_LOCK_WAIT_MS);
}
import { flattenObject, expandFlatKeys } from './objectPath';
import { debug } from './debug';
import { StoreUnreadableError, UnreadableFile, classifyUnparseable, keysCollide, nameCollisionError } from './unreadable';
import { KeyCollisionError, collidesWithAny, entriesUnderEntries } from './keyCollision';
import { toStoreWriteError } from './storeWriteError';

// ── Test guard (#274) ──────────────────────────────────────────────────

/**
 * The checkout the test suite runs from, set by the test preload
 * (src/__tests__/_setup.ts) and inherited by every child a suite spawns.
 */
export const TEST_CHECKOUT_ENV = 'RVR_TEST_CHECKOUT';

/** `p` with symlinks resolved as far as the path exists; the rest appended as given. */
function canonicalPath(p: string): string {
  const resolved = path.resolve(p);
  try {
    return fs.realpathSync(resolved);
  } catch {
    // Not there yet, or `fs` is a test's mock: resolve the parent instead.
    const parent = path.dirname(resolved);
    return parent === resolved ? resolved : path.join(canonicalPath(parent), path.basename(resolved));
  }
}

function isInside(target: string, root: string): boolean {
  const rel = path.relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/**
 * #274: why a store write to `dir` is refused, or undefined. Under the test
 * suite (RVR_TEST=1, with the checkout recorded by the preload), a store
 * inside the checkout is the repository's own `.reverie/` — its entries are
 * committed — reached because in-process tests run from the checkout and a
 * store mock missing an export fell through to the real module. Refused for
 * every write: entry, sidecar, epoch and lock. A test that needs a project
 * store makes one in a temp directory.
 */
export function testCheckoutRefusal(dir: string): string | undefined {
  if (process.env.RVR_TEST !== '1') return undefined;
  const root = process.env[TEST_CHECKOUT_ENV];
  if (!root) return undefined;
  if (!isInside(path.resolve(dir), path.resolve(root)) && !isInside(canonicalPath(dir), canonicalPath(root))) return undefined;
  return `Refusing to write ${dir}: it is inside the checkout under test (${root}), and RVR_TEST is set. `
    + 'A test that needs a project store makes one in a temp directory (#274).';
}

/**
 * Throw testCheckoutRefusal's refusal, if any. Also for the writes beside the
 * store that are not the store's own: `init` creating or removing
 * `.reverie/`, and the backups an import or a reset makes first.
 */
export function assertNotTestCheckout(dir: string): void {
  const refusal = testCheckoutRefusal(dir);
  if (refusal !== undefined) throw new Error(refusal);
}

// ── Types ──────────────────────────────────────────────────────────────

/** Optional metadata block inside a per-entry wrapper file. */
export interface EntryMeta {
  /** Timestamp of the entry's first write. Preserved across updates. */
  created?: number;
  /** Timestamp of the entry's most recent write. Bumped on every write. */
  updated?: number;
}

/** On-disk per-entry file format. */
export interface EntryWrapper {
  value: CodexValue;
  meta?: EntryMeta;
}

/** Cached state of one entry file. */
interface CachedEntry {
  wrapper: EntryWrapper;
  mtimeMs: number;
}

/**
 * Cached state of one sidecar file (_aliases.json, _confirm.json).
 * `mtimeMs` of `-1` means "observed as missing" — used so that a later
 * fs.stat of a real mtime compares unequal and triggers a re-read.
 */
interface CachedSidecar<T> {
  data: T;
  mtimeMs: number;
  /** Set when the file exists but does not parse (#215). `data` is then `{}`. */
  unreadable?: UnreadableFile;
}

/** An entry file that exists but does not parse, as of `mtimeMs` (#215). */
interface UnreadableEntry {
  file: UnreadableFile;
  mtimeMs: number;
}

// ── File layout helpers ────────────────────────────────────────────────

const ALIASES_FILE = '_aliases.json';
const CONFIRM_FILE = '_confirm.json';
const EPOCH_FILE = '_epoch.json';
const README_FILE = '_README.md';
const GITIGNORE_FILE = '.gitignore';
const ENTRY_FILE_SUFFIX = '.json';

/**
 * Hand-edit warning written to `<store>/_README.md` on store creation. The
 * `_` prefix means isEntryFilename ignores it; it exists purely as an
 * in-context nudge for developers browsing the directory who might
 * otherwise be tempted to open an entry file and tweak it. See the
 * `conventions.editSurface` Reverie entry for the rationale.
 */
const README_CONTENT = `# Reverie store — do not hand-edit

This directory is managed by Reverie. Each \`*.json\` file is a single
store entry written through the CLI or MCP tools.

**Internal sidecar files** (prefix \`_\`, safe to ignore):

- \`_README.md\` — this file
- \`_aliases.json\` — short-name aliases for entries
- \`_confirm.json\` — entries that require confirmation before running
- \`_epoch.json\` — internal commit counter for crash safety; the integer
  climbs by 2 with every save and is used by readers to detect a writer
  mid-commit. Per-clone state: the \`.gitignore\` in this directory keeps it
  out of commits (a fresh clone starts at 0). You should never need to touch it.
- \`.gitignore\` — ignores \`_epoch.json\` so only entries and shared sidecars
  are committed. Safe to extend.

**Edit via one of:**

- \`rvr set <key> <value>\` (and the rest of the CLI)
- The Reverie MCP tools (\`reverie_set\`, \`reverie_get\`, etc.)
- A future UI

Direct edits to these files desync per-entry metadata (created/updated
timestamps, future verified/agent fields) and silently break staleness
signals. The wrapper format \`{ value, meta }\` assumes only the official
tools touch it.

If you need to bulk-import or restructure, do it through the CLI.

**If git leaves conflict markers in a file here** (two branches wrote the
same entry), Reverie will not read that file and refuses to write over it.
Keep one side whole — \`git checkout --ours -- <file>\` or
\`git checkout --theirs -- <file>\` — then \`git add <file>\`.
\`rvr lint\` lists every file in this state.

A file that is not a conflict but simply invalid (truncated, emptied) is
refused the same way. Restore it from version control or a backup, or
delete it — the one case where removing a file here by hand is the fix:
the tools will not remove a file they cannot read.
`;

/**
 * Maximum number of retries for the seqlock loop in load(). In practice,
 * writes are short (sub-millisecond for small saves), so a handful of retries
 * is more than enough to ride out even pathologically overlapping writes.
 * After exhausting retries we return a best-effort snapshot and log via debug.
 */
const MAX_LOAD_RETRIES = 3;

/**
 * Small shared buffer for Atomics.wait()-based sleeps during the load()
 * retry loop. Reused across all store instances to avoid per-call allocation.
 */
const _loadRetrySleep = new Int32Array(new SharedArrayBuffer(4));

/** True if a filename in the store directory represents an entry (not a sidecar). */
function isEntryFilename(name: string): boolean {
  return name.endsWith(ENTRY_FILE_SUFFIX) && !name.startsWith('_');
}

/** Converts an entry filename (`arch.storage.json`) to its dotted key (`arch.storage`). */
function keyFromFilename(name: string): string {
  return name.slice(0, -ENTRY_FILE_SUFFIX.length);
}

/**
 * Returns true if the key is safe to use as a flat entry filename.
 * A valid key:
 *   - Is a non-empty string
 *   - Does not start with `_` (reserved for sidecars like `_aliases`, `_confirm`)
 *   - Does not start or end with `.` (would create empty segments and a hidden file)
 *   - Contains no path separators (`/`, `\`) — keys are flat filenames, not paths
 *   - Contains no NUL, which no filename can hold
 *   - Has no empty segment, `..` segment, or prototype-polluting name (`__proto__`,
 *     `constructor`, `prototype`) when split on `.`
 *
 * The `typeof key !== 'string'` guard is defensive: a caller that bypasses
 * Zod validation (or that lets a prototype-chain object slip in via an
 * unsafe alias-map lookup) should fail closed here instead of crashing
 * deeper in the pipeline with `path.split is not a function`.
 */
export function isValidEntryKey(key: string): boolean {
  if (typeof key !== 'string') return false;
  if (!key || key.startsWith('_')) return false;
  if (key.startsWith('.') || key.endsWith('.')) return false;
  if (key.includes('/') || key.includes('\\')) return false;
  // NUL ends a path at the system call: no file can be named with one.
  if (key.includes('\0')) return false;
  const parts = key.split('.');
  for (const part of parts) {
    if (!part || part === '..' ||
        part === '__proto__' || part === 'constructor' || part === 'prototype') return false;
  }
  return true;
}

/**
 * Converts a dotted key to its entry file path within the store directory.
 * Throws if the key is invalid (would escape the store directory or collide
 * with a reserved sidecar name).
 */
/**
 * #246: the stored key, other than `key`, whose entry file `key`'s path opens.
 *
 * A key maps to its filename, and a filesystem that folds names opens an
 * existing file for a spelling no name comparison predicts: APFS folds `ſ`
 * to `s` and `ﬁ` to `fi` (case is caught earlier, by name). Asked of the
 * filesystem as #234 does — are these the same file — with lstat, so a
 * symlink is never followed. A stored key that differs only by Unicode
 * normalization is the same key, not a twin: HFS+ and exFAT list names in
 * NFD, so an NFC key would otherwise find its own entry. Costs a stat per
 * stored key, and runs only when `key`'s path exists under no listed name.
 */
function foldTwin(dir: string, key: string, storedKeys: Iterable<string>): string | undefined {
  const idOf = (k: string): string | undefined => {
    try {
      const st = fs.lstatSync(entryFilePath(dir, k), { bigint: true });
      return `${st.dev}:${st.ino}`;
    } catch {
      return undefined;
    }
  };
  const id = idOf(key);
  if (id === undefined) return undefined;
  const nfc = key.normalize('NFC');
  for (const other of storedKeys) {
    if (other === key) continue;
    if (idOf(other) !== id) continue;
    return other.normalize('NFC') === nfc ? undefined : other;
  }
  return undefined;
}

export function entryFilePath(dir: string, key: string): string {
  if (!isValidEntryKey(key)) {
    throw new Error(`Invalid store key: ${JSON.stringify(key)}`);
  }
  const filePath = path.join(dir, key + ENTRY_FILE_SUFFIX);
  // Defense in depth: ensure the resolved path stays inside the store directory.
  const resolvedDir = path.resolve(dir);
  const resolvedFile = path.resolve(filePath);
  const relative = path.relative(resolvedDir, resolvedFile);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Key resolves outside store directory: ${JSON.stringify(key)}`);
  }
  return filePath;
}

/**
 * Returns the path passed to `withFileLock` for this store. The file-lock
 * primitive appends `.lock` internally, so callers pass the store directory
 * itself and the actual lock file ends up as a sibling at `<dir>.lock`.
 */
export function getStoreLockKey(dir: string): string {
  return dir;
}

// ── Wrapper I/O ────────────────────────────────────────────────────────

/** Parses an entry file's contents into an EntryWrapper. Returns null on parse failure. */
export function parseEntryWrapper(raw: string): EntryWrapper | null {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!('value' in parsed)) return null;
    const wrapper: EntryWrapper = { value: parsed.value as CodexValue };
    if (parsed.meta && typeof parsed.meta === 'object') {
      // EntryMeta has only optional fields, so `object` satisfies it structurally.
      wrapper.meta = parsed.meta;
    }
    return wrapper;
  } catch {
    return null;
  }
}

/** Serializes an EntryWrapper to the pretty JSON format used on disk. */
export function serializeEntryWrapper(wrapper: EntryWrapper): string {
  return JSON.stringify(wrapper, null, 2);
}

/** Serializes a sidecar object (aliases or confirm) with sorted keys. */
function serializeSidecar<T extends Record<string, unknown>>(data: T): string {
  const sorted = Object.fromEntries(
    Object.entries(data).sort(([a], [b]) => a.localeCompare(b))
  );
  return JSON.stringify(sorted, null, 2);
}

/**
 * Read a store-controlled file, refusing to follow a symlink (#159). Store
 * contents ship inside cloned repos; a hostile `.reverie/<key>.json` (or
 * sidecar) shipped as a symlink to a victim file would otherwise be read and
 * surfaced as the entry value. lstat sees the link itself and we reject. A
 * missing file throws ENOENT as before, so existing callers' ENOENT handling
 * is unchanged. (Static-clone threat model — the lstat/read window is not a
 * live-race concern here.)
 */
function readStoreFile(filePath: string): string {
  const st = fs.lstatSync(filePath); // throws ENOENT if absent — callers handle
  if (st.isSymbolicLink()) {
    throw new Error(`Refusing to read symlinked store file: ${filePath}`);
  }
  return fs.readFileSync(filePath, 'utf8');
}

/**
 * Reads a sidecar file. A missing or empty file is an empty map. A file that
 * does not parse to an object is ALSO returned as an empty map, but flagged
 * `unreadable` (#215): callers must not mistake it for "no aliases" / "no
 * confirmation flags", and save() must not rewrite it.
 */
function readSidecar<T>(filePath: string, kind: 'aliases' | 'confirm'): { data: T; unreadable?: UnreadableFile } {
  let raw: string;
  try {
    raw = readStoreFile(filePath);
  } catch (err) {
    if (!isENOENT(err)) {
      debug(`Failed to read sidecar ${filePath}: ${String(err)}`);
    }
    return { data: {} as T };
  }
  if (!raw.trim()) return { data: {} as T };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { data: parsed as T };
    }
  } catch { /* classified below */ }
  debug(`Unparseable sidecar: ${filePath}`);
  return { data: {} as T, unreadable: { kind, path: filePath, reason: classifyUnparseable(raw) } };
}

/**
 * Fresh read of one entry file, for the write guards (#215): returns the
 * unreadable descriptor when the file exists and does not parse, undefined
 * when it parses or is absent. Other read failures (a symlink, EACCES) are
 * not this guard's business — the callers' existing handling applies.
 */
function probeEntryFile(filePath: string, key: string): UnreadableFile | undefined {
  let raw: string;
  try {
    raw = readStoreFile(filePath);
  } catch {
    return undefined;
  }
  return parseEntryWrapper(raw)
    ? undefined
    : { kind: 'entry', path: filePath, key, reason: classifyUnparseable(raw) };
}

/** Device and inode of the file at `filePath` itself (a symlink is not followed), or undefined. */
function fileIdentity(filePath: string): string | undefined {
  try {
    const st = fs.lstatSync(filePath, { bigint: true });
    return `${st.dev}:${st.ino}`;
  } catch {
    return undefined;
  }
}

function isENOENT(err: unknown): boolean {
  return (
    !!err &&
    typeof err === 'object' &&
    'code' in err &&
    (err as { code: string }).code === 'ENOENT'
  );
}

/** May this process create and remove files in `dir`? */
function isWritableDir(dir: string): boolean {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** A filesystem refusal to create a file here: no permission, or a read-only volume. */
function isUnwritableError(err: unknown): boolean {
  const code = !!err && typeof err === 'object' && 'code' in err ? err.code : undefined;
  return code === 'EACCES' || code === 'EPERM' || code === 'EROFS';
}

// ── Epoch (seqlock for torn-read detection) ───────────────────────────
//
// The store uses a seqlock pattern to let readers (load()) detect that
// they overlapped a writer (save()) without taking the writer lock.
//
// Convention:
//   - Even epoch  = stable state, no writer in progress.
//   - Odd epoch   = writer mid-commit. Readers must not trust the on-disk
//                   state while they observe an odd epoch.
//
// save() bumps epoch to odd before touching any files, then to the next
// even value after all writes complete — both bumps happen under the
// directory lock. Readers snapshot the epoch before and after scanning;
// a match on an even value guarantees no writer committed during the scan.
//
// The epoch file is `_epoch.json` at the store directory root. The `_`
// prefix means `isEntryFilename` already excludes it from entry scans.

/**
 * Read the commit epoch from `_epoch.json`. Returns 0 when the file is
 * missing, unparseable, or shaped wrong — these are all treated as "no
 * writer has ever run," which is the correct initial state (the first
 * save will bump through 1 → 2 and establish the invariant).
 */
function readEpoch(dir: string): number {
  try {
    const raw = readStoreFile(path.join(dir, EPOCH_FILE));
    const parsed = JSON.parse(raw) as { epoch?: unknown };
    if (typeof parsed.epoch === 'number'
      && Number.isSafeInteger(parsed.epoch)
      && parsed.epoch >= 0) {
      return parsed.epoch;
    }
    return 0;
  } catch {
    return 0;
  }
}

/** Atomically write the commit epoch to `_epoch.json`. */
function writeEpoch(dir: string, epoch: number): void {
  atomicWriteFileSync(path.join(dir, EPOCH_FILE), JSON.stringify({ epoch }) + '\n');
}

/**
 * Run a commit's steps with the epoch odd, and write it even again on every
 * way out of them (#262): a refusal, a failed write, a failed delete or list
 * write after the entries are in, an error from the caller's change. Writing
 * the even value back at each `throw` missed every exit added after it, and
 * a store left odd sends every reader through its retries to a snapshot it
 * cannot trust, until the next write. Under the store lock. When the commit
 * failed, a failure to write the even value is logged and the commit's own
 * error is the one thrown. `committed` runs after the even value is written,
 * only when the commit succeeded.
 */
function underOddEpoch(dir: string, commit: () => void, committed?: () => void): void {
  const startEpoch = readEpoch(dir);
  const inProgressEpoch = startEpoch + (startEpoch % 2 === 0 ? 1 : 2);
  writeEpoch(dir, inProgressEpoch);
  let failure: { err: unknown } | undefined;
  try {
    commit();
  } catch (err) {
    failure = { err };
  }
  try {
    writeEpoch(dir, inProgressEpoch + 1);
  } catch (err) {
    if (!failure) throw err;
    debug(`Could not write epoch ${inProgressEpoch + 1} to ${dir} after a failed commit: ${String(err)}`);
  }
  if (failure) throw failure.err;
  committed?.();
}

/**
 * Git-ignore rules for per-clone store state, seeded to `<store>/.gitignore`
 * (#187). `.reverie/` is designed to be committed, but `_epoch.json` is a
 * local seqlock counter bumped on every write — committing it made every
 * merge between two writers conflict on the counter before any entry did.
 * readEpoch() treats a missing file as 0, so a fresh clone without it is in
 * the correct initial state. The `.` prefix keeps the file out of entry
 * scans (isEntryFilename requires the .json suffix).
 */
const GITIGNORE_CONTENT = `# Per-clone store state, managed by Reverie — not shared via git.
_epoch.json
`;

/**
 * Seed a documentation/config file into the store directory if it doesn't
 * already exist. Idempotent and best-effort: a failure to write (read-only
 * filesystem, permissions) is logged via debug and swallowed so the store
 * itself keeps working.
 *
 * Uses an atomic no-clobber create so a file that appears concurrently
 * (for example, a user-customized one) is preserved rather than replaced.
 */
function ensureSeedFile(dir: string, name: string, content: string): void {
  try {
    fs.writeFileSync(path.join(dir, name), content, { flag: 'wx' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return;
    debug(`Failed to write ${name} in ${dir}: ${String(err)}`);
  }
}

/** Seed the hand-edit warning README and the per-clone .gitignore (#187). */
function ensureStoreSeeds(dir: string): void {
  ensureSeedFile(dir, README_FILE, README_CONTENT);
  ensureSeedFile(dir, GITIGNORE_FILE, GITIGNORE_CONTENT);
}

// ── Equality helpers ───────────────────────────────────────────────────

/**
 * Stable deep-equal for CodexValue shapes (string or nested object of strings).
 * Uses a sorted-key stringify so object key order doesn't affect equality.
 */
function stableStringify(v: unknown): string {
  if (typeof v === 'string') return JSON.stringify(v);
  if (v && typeof v === 'object') {
    const keys = Object.keys(v).sort();
    const parts = keys.map(
      k => JSON.stringify(k) + ':' + stableStringify((v as Record<string, unknown>)[k])
    );
    return '{' + parts.join(',') + '}';
  }
  return JSON.stringify(v);
}

function valueEquals(a: CodexValue, b: CodexValue): boolean {
  if (a === b) return true;
  return stableStringify(a) === stableStringify(b);
}

function shallowEquals<T extends Record<string, unknown>>(a: T, b: T): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const k of aKeys) {
    if (a[k] !== b[k]) return false;
  }
  return true;
}

// ── The factory ────────────────────────────────────────────────────────

/** How far a failed commit got (#271): whether `fn` threw, and whether a file may have changed. */
interface CommitProgress {
  changed: boolean;
  fnFailure?: { err: unknown };
}

/**
 * Create a file-per-entry directory-backed ScopedStore.
 *
 * @param getDirPath  Function returning the absolute path to the store directory.
 * @param ensureDir   Function that ensures the store directory exists on disk
 *                    (called before any write). Mirrors createScopedStore's contract.
 */
export function createDirectoryStore(
  getDirPath: () => string,
  ensureDir: () => void
): ScopedStore {
  // Per-entry cache, keyed by dotted key. Each entry records its file mtime
  // so we can detect external writes between load() calls.
  const entryCache = new Map<string, CachedEntry>();
  // Entry files that exist but do not parse (#215), keyed like entryCache and
  // mtime-tracked the same way so an unchanged broken file is not re-read on
  // every scan. A key is in at most one of the two maps.
  const unreadableEntries = new Map<string, UnreadableEntry>();
  // Sidecar caches — mtime-tracked so scanAndSync() can skip the re-read when
  // nothing changed. A cached sentinel mtime of `-1` means "observed as
  // missing"; any real fs.stat mtime compares unequal, so we'll pick up a
  // sidecar that appears later without a stale-read hazard.
  let aliasesCache: CachedSidecar<Record<string, string>> | null = null;
  let confirmCache: CachedSidecar<Record<string, true>> | null = null;
  // Directory mtime at the time of the last successful scanAndSync. The
  // directory's own mtime is bumped by every atomic-write inside it (since
  // atomicWriteFileSync uses create-tmp + rename, which adds and removes a
  // dir entry). If the dir mtime hasn't changed, no entry, sidecar, or
  // epoch file has been touched — so we can skip the per-file scan
  // entirely. Sentinel `-1` means "no scan has run yet".
  let dirMtimeMs = -1;

  function clear(): void {
    entryCache.clear();
    unreadableEntries.clear();
    aliasesCache = null;
    confirmCache = null;
    dirMtimeMs = -1;
  }

  /**
   * Stat a sidecar file and return either its current data (cached or
   * re-read) or an empty-object fallback if it's missing. Updates the
   * passed-in cache slot in place by returning the new CachedSidecar;
   * callers assign the result back.
   */
  function refreshSidecar<T extends Record<string, unknown>>(
    filePath: string,
    kind: 'aliases' | 'confirm',
    cached: CachedSidecar<T> | null
  ): CachedSidecar<T> {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch (err) {
      if (isENOENT(err)) {
        // File missing. If we already had a "missing" sentinel, keep it;
        // otherwise install one so future scans can detect a new sidecar.
        return cached?.mtimeMs === -1 ? cached : { data: {} as T, mtimeMs: -1 };
      }
      throw err;
    }
    if (cached?.mtimeMs === stat.mtimeMs) {
      return cached;
    }
    const { data, unreadable } = readSidecar<T>(filePath, kind);
    return unreadable ? { data, mtimeMs: stat.mtimeMs, unreadable } : { data, mtimeMs: stat.mtimeMs };
  }

  /**
   * A sidecar as it is on disk right now, for update() under the lock
   * (#254). Not through refreshSidecar: that keeps its copy while the mtime
   * matches, and two writes inside one mtime tick leave it stale. Missing is
   * the `-1` sentinel, as there, so save() still creates the file.
   */
  function rereadSidecar<T extends Record<string, unknown>>(
    filePath: string,
    kind: 'aliases' | 'confirm'
  ): CachedSidecar<T> {
    let mtimeMs: number;
    try {
      mtimeMs = fs.statSync(filePath).mtimeMs;
    } catch (err) {
      if (isENOENT(err)) return { data: {} as T, mtimeMs: -1 };
      throw err;
    }
    const { data, unreadable } = readSidecar<T>(filePath, kind);
    return unreadable ? { data, mtimeMs, unreadable } : { data, mtimeMs };
  }

  /**
   * Has a file recorded as unreadable changed, or gone, since the scan that
   * recorded it (#215)? The directory-mtime fast skip below assumes every
   * writer adds or removes a directory entry. The store's own atomic writes
   * do, and so does git; a person repairing a broken file with an editor save
   * or `cp backup <file>` rewrites it in place and leaves the directory
   * untouched. Without this check a long-lived process keeps reporting the
   * file, keeps the entry out of load(), and — the next time it saves — acts
   * on that stale picture: the repaired entry is absent from the data being
   * saved, so it is deleted; a repaired alias map is rewritten from empty.
   * Costs one stat per unreadable file, and nothing on a healthy store.
   */
  function unreadableFileChanged(): boolean {
    const recorded: [string, number][] = [];
    for (const u of unreadableEntries.values()) recorded.push([u.file.path, u.mtimeMs]);
    if (aliasesCache?.unreadable) recorded.push([aliasesCache.unreadable.path, aliasesCache.mtimeMs]);
    if (confirmCache?.unreadable) recorded.push([confirmCache.unreadable.path, confirmCache.mtimeMs]);
    for (const [filePath, mtimeMs] of recorded) {
      try {
        if (fs.statSync(filePath).mtimeMs !== mtimeMs) return true;
      } catch {
        return true; // gone, or not statable: let the full scan decide
      }
    }
    return false;
  }

  /**
   * Scan the directory and refresh caches: re-read any entry whose mtime has
   * changed, drop cache entries for files that no longer exist, and reload
   * the sidecars. Must be called with or without the lock depending on caller
   * context — save() calls it under the lock for authoritative current state.
   */
  function scanAndSync(): void {
    const dir = getDirPath();

    // Fast skip: stat the directory itself first. If its mtime hasn't
    // changed since the last scan, no atomic-write has touched any file
    // inside it (atomicWriteFileSync's create-tmp + rename bumps the dir
    // mtime as a side effect of adding and removing the tmp dirent), so
    // the entry cache, sidecar caches, and seqlock epoch file are all
    // still authoritative. Skip the readdir + per-entry stat loop — unless a
    // file recorded as unreadable has since been repaired in place, which
    // the directory mtime cannot show.
    try {
      const dirStat = fs.statSync(dir);
      if (dirMtimeMs !== -1 && dirStat.mtimeMs === dirMtimeMs && !unreadableFileChanged()) {
        return;
      }
      dirMtimeMs = dirStat.mtimeMs;
    } catch (err) {
      if (isENOENT(err)) {
        entryCache.clear();
        unreadableEntries.clear();
        aliasesCache = { data: {}, mtimeMs: -1 };
        confirmCache = { data: {}, mtimeMs: -1 };
        dirMtimeMs = -1;
        return;
      }
      throw err;
    }

    let files: string[];
    try {
      files = fs.readdirSync(dir);
    } catch (err) {
      if (isENOENT(err)) {
        entryCache.clear();
        unreadableEntries.clear();
        aliasesCache = { data: {}, mtimeMs: -1 };
        confirmCache = { data: {}, mtimeMs: -1 };
        dirMtimeMs = -1;
        return;
      }
      throw err;
    }

    const seen = new Set<string>();
    for (const file of files) {
      if (!isEntryFilename(file)) continue;
      const filePath = path.join(dir, file);
      let mtimeMs: number;
      try {
        mtimeMs = fs.statSync(filePath).mtimeMs;
      } catch {
        continue;
      }
      const key = keyFromFilename(file);
      if (!isValidEntryKey(key)) {
        debug(`Skipping entry file with unsafe key: ${file}`);
        continue;
      }
      seen.add(key);
      const cached = entryCache.get(key);
      if (cached?.mtimeMs === mtimeMs) {
        // A key is in at most one of the two maps. A current cache entry
        // means the file parsed (or we wrote it) after it was recorded.
        unreadableEntries.delete(key);
        continue;
      }
      if (unreadableEntries.get(key)?.mtimeMs === mtimeMs) continue;
      try {
        const raw = readStoreFile(filePath);
        const wrapper = parseEntryWrapper(raw);
        if (wrapper) {
          entryCache.set(key, { wrapper, mtimeMs });
          unreadableEntries.delete(key);
        } else {
          // #215: the file exists and does not parse. Record it instead of
          // skipping it — and drop any copy parsed before it broke, which a
          // long-lived process would otherwise keep serving as current.
          debug(`Unparseable entry file: ${filePath}`);
          entryCache.delete(key);
          unreadableEntries.set(key, {
            file: { kind: 'entry', path: filePath, key, reason: classifyUnparseable(raw) },
            mtimeMs,
          });
        }
      } catch (err) {
        debug(`Failed to read entry file ${filePath}: ${String(err)}`);
      }
    }

    // Drop cache entries for files that no longer exist.
    for (const key of [...entryCache.keys()]) {
      if (!seen.has(key)) entryCache.delete(key);
    }
    for (const key of [...unreadableEntries.keys()]) {
      if (!seen.has(key)) unreadableEntries.delete(key);
    }

    // Refresh sidecar caches. refreshSidecar stats first and re-parses only
    // if the mtime changed, so an unchanged sidecar costs a single stat()
    // instead of a stat + read + JSON.parse.
    aliasesCache = refreshSidecar<Record<string, string>>(
      path.join(dir, ALIASES_FILE),
      'aliases',
      aliasesCache
    );
    confirmCache = refreshSidecar<Record<string, true>>(
      path.join(dir, CONFIRM_FILE),
      'confirm',
      confirmCache
    );
  }

  /**
   * Store files that exist but did not parse, as of the last scan this
   * instance ran (#215). Does no I/O: a command that never scanned reports
   * nothing, and a single-key read finds out about its own file in getOne().
   */
  function unreadable(): UnreadableFile[] {
    const files = [...unreadableEntries.values()].map(e => e.file);
    if (aliasesCache?.unreadable) files.push(aliasesCache.unreadable);
    if (confirmCache?.unreadable) files.push(confirmCache.unreadable);
    return files.sort((a, b) => a.path.localeCompare(b.path));
  }

  function load(): UnifiedData {
    const dir = getDirPath();

    // Seqlock retry: snapshot the epoch before scanning, scan, then re-read
    // the epoch. If a writer committed during the scan (or is mid-commit
    // when we start), the epochs will differ or the "before" read will be
    // odd — retry in either case. Bounded to MAX_LOAD_RETRIES so we never
    // spin indefinitely under heavy write contention.
    for (let attempt = 0; attempt <= MAX_LOAD_RETRIES; attempt++) {
      const before = readEpoch(dir);
      if (before % 2 !== 0) {
        // Writer is mid-commit. Back off briefly and retry. Backoffs only
        // fire on attempts 0..MAX_LOAD_RETRIES-1 (1ms, 2ms, 4ms with the
        // current MAX_LOAD_RETRIES=3); on the final attempt we log and
        // proceed with a best-effort scan rather than waiting again.
        if (attempt < MAX_LOAD_RETRIES) {
          Atomics.wait(_loadRetrySleep, 0, 0, 1 << attempt);
          continue;
        }
        debug(
          `Store epoch ${before} is odd after ${MAX_LOAD_RETRIES + 1} attempts — ` +
          `returning possibly-torn snapshot from ${dir}`
        );
      }
      scanAndSync();
      const after = readEpoch(dir);
      if (before === after) break;
      if (attempt === MAX_LOAD_RETRIES) {
        debug(
          `Store epoch changed ${before} -> ${after} across load scan after ` +
          `${MAX_LOAD_RETRIES + 1} attempts — returning possibly-torn snapshot from ${dir}`
        );
        break;
      }
      // Otherwise: loop and retry with a fresh scan. No backoff here —
      // unlike the odd-epoch case, an epoch *mismatch* means the writer
      // already committed (we read the post-commit even value as `after`).
      // Writes are sub-millisecond, so by the time we re-scan the writer
      // is almost certainly done; backing off would only add latency in
      // the common case without preventing further mismatches.
    }

    return snapshot();
  }

  /** The cached state as UnifiedData, in fresh objects a caller may mutate. */
  function snapshot(): UnifiedData {
    // Assemble the nested `entries` tree from the flat per-key cache.
    // #267: an entry and entries under it, both on disk, cannot both be in
    // the tree. The entry is, always: which one won used to be whichever the
    // cache listed last, so it depended on directory order and could flip
    // after a write. The rest are listed as `hidden`, and update() keeps
    // their files.
    const hidden = entriesUnderEntries(entryCache.keys());
    const flat: Record<string, CodexValue> = {};
    const meta: Record<string, number> = {};
    for (const [key, cached] of entryCache) {
      if (hidden.has(key)) continue;
      flat[key] = cached.wrapper.value;
      if (cached.wrapper.meta?.updated !== undefined) {
        meta[key] = cached.wrapper.meta.updated;
      }
    }
    const entries = expandFlatKeys(flat) as CodexData;

    // Defensive shallow copies: callers (e.g. setAlias) load the map, mutate
    // it in place, then call save with the mutated reference. Under the old
    // (non-mtime-cached) sidecar path, this was safe because every scanAndSync
    // reassigned `aliasesCache` to a fresh JSON.parse result — the caller's
    // mutated copy was no longer the cache. Now that we reuse the cache
    // across scans when mtime is unchanged, we have to hand out copies so
    // caller mutation doesn't silently pollute the cache (which would make
    // the dirty-check in save() return "no change" and skip the write).
    const result: UnifiedData = {
      entries,
      aliases: { ...(aliasesCache?.data ?? {}) },
      confirm: { ...(confirmCache?.data ?? {}) },
    };
    if (Object.keys(meta).length > 0) {
      result._meta = meta;
    }
    if (hidden.size > 0) result.hidden = [...hidden.keys()].sort();
    return result;
  }

  /**
   * Replace the whole store with `data`: every entry absent from it is
   * deleted, both sidecars become exactly its maps. For a caller whose new
   * state does not depend on the current one (import replace, reset). A
   * caller that read the store to compute `data` must use update() instead —
   * whatever another process wrote since that read is deleted here (#254).
   */
  function save(data: UnifiedData): void {
    update(() => data);
  }

  /**
   * Read-modify-write as one transaction under the store lock (#254).
   *
   * `fn` gets the store as it stands under the lock — rescanned, both
   * sidecars re-read from disk — in fresh objects it may mutate, and returns
   * the state to write (or null: write nothing). The write is the same diff
   * save() always did, against that same state, so what another process
   * wrote before the lock is in what `fn` sees and survives unless `fn`
   * itself removes it. Before this, every write loaded first, outside the
   * lock, and the full save deleted what was written in between.
   *
   * `fn` must be synchronous and must not touch this store: the lock is not
   * re-entrant (a nested write waits for it and fails), and the epoch is odd
   * (a nested load spins in its seqlock retry). If `fn` throws, nothing is
   * written and the epoch goes back to even.
   *
   * A failure of the store's own file operations is a StoreWriteError
   * (#271), naming the file; what `fn` throws is thrown as it is.
   */
  function update(fn: (current: UnifiedData) => UnifiedData | null): void {
    const progress: CommitProgress = { changed: false };
    try {
      commitUpdate(fn, progress);
    } catch (err) {
      dirMtimeMs = -1;   // the caches may no longer match the directory: rescan
      if (progress.fnFailure && progress.fnFailure.err === err) throw err;
      throw toStoreWriteError(err, !progress.changed);
    }
  }

  /** update()'s body. `progress` says whether `fn` threw and whether a file may have changed. */
  function commitUpdate(fn: (current: UnifiedData) => UnifiedData | null, progress: CommitProgress): void {
    const dir = getDirPath();
    assertNotTestCheckout(dir);
    ensureDir();
    ensureStoreSeeds(dir);

    // 0. Begin commit: bump epoch to the next odd value. Readers that
    //    observe an odd epoch loop in their seqlock retry until we finish.
    //    readEpoch() returns 0 if the file is missing, so the first save
    //    on a fresh store transitions 0 → 1 → 2. Ahead of the scan, so a
    //    reader that overlaps the scan retries. Every way out of the steps
    //    below writes the even value back (#262).
    withStoreLock(dir, () => underOddEpoch(dir, () => {
      // 1. The store as it stands, read under the lock. A full scan: the
      //    directory-mtime fast skip trusts a timestamp, and on a
      //    filesystem with coarse mtimes another process's write can
      //    share one with our last scan. Sidecars re-read from disk for
      //    the same reason (see rereadSidecar).
      dirMtimeMs = -1;
      scanAndSync();
      aliasesCache = rereadSidecar<Record<string, string>>(path.join(dir, ALIASES_FILE), 'aliases');
      confirmCache = rereadSidecar<Record<string, true>>(path.join(dir, CONFIRM_FILE), 'confirm');

      // 2. The caller's change, decided from that state.
      let data: UnifiedData | null;
      try {
        data = fn(snapshot());
      } catch (err) {
        progress.fnFailure = { err };
        throw err;
      }

      // Nothing to write: the epoch goes back to even, and the scan above
      // makes the directory token current.
      if (data === null) return;

      // 3. Compute deltas, from the new entries flattened to leaves.
      //    #267: an entry stored under another entry is not in the tree
      //    `fn` got (see snapshot), so it is absent from what `fn` returns
      //    whatever `fn` did. Its file is deleted only when the write
      //    removes it: by naming it, or a key above it, in `removed`, or by
      //    removing the entry it is hidden under (`rm ns.k` takes
      //    `ns.k.sub` with it). Every other write — an alias, a flag, a
      //    rename elsewhere — deleted it without a word.
      const newFlat = flattenObject(data.entries);
      const hidden = entriesUnderEntries(entryCache.keys());
      const removed = data.removed ?? [];
      const toDelete: string[] = [];
      for (const key of entryCache.keys()) {
        if (Object.hasOwn(newFlat, key)) continue;
        const under = hidden.get(key);
        if (under === undefined
          || !Object.hasOwn(newFlat, under)
          || removed.some(r => key === r || key.startsWith(`${r}.`))) toDelete.push(key);
      }
      const toWrite: [string, CodexValue, number | undefined][] = [];
      for (const [key, value] of Object.entries(newFlat)) {
        const current = entryCache.get(key);
        const newUpdated = data._meta?.[key];
        const unchanged =
          !!current &&
          valueEquals(current.wrapper.value, value) &&
          current.wrapper.meta?.updated === newUpdated;
        if (!unchanged) toWrite.push([key, value, newUpdated]);
      }
      const aliasPath = path.join(dir, ALIASES_FILE);
      const confirmPath = path.join(dir, CONFIRM_FILE);
      const rewriteAliases = !aliasesCache || aliasesCache.mtimeMs === -1 || !shallowEquals(aliasesCache.data, data.aliases);
      const rewriteConfirm = !confirmCache || confirmCache.mtimeMs === -1 || !shallowEquals(confirmCache.data, data.confirm);

      // 3b. Refuse to replace a file that does not parse (#215). An
      //     unreadable entry is absent from entryCache, so a write to its key
      //     lands in toWrite looking like a new entry; an unreadable sidecar
      //     loaded as {}, so any change to it looks like a rewrite from
      //     empty. Either write would discard both sides of a git conflict.
      //     Decided from a fresh read of each target, not from the scan.
      //     All-or-nothing: checked before any delta is applied.
      const refused: UnreadableFile[] = [];
      for (const [key] of toWrite) {
        const broken = probeEntryFile(entryFilePath(dir, key), key);
        if (broken) refused.push(broken);
      }
      if (rewriteAliases) {
        const broken = readSidecar(aliasPath, 'aliases').unreadable;
        if (broken) refused.push(broken);
      }
      if (rewriteConfirm) {
        const broken = readSidecar(confirmPath, 'confirm').unreadable;
        if (broken) refused.push(broken);
      }
      if (refused.length > 0) throw new StoreUnreadableError(refused, 'write');

      // 3c. Nor a write to an ancestor or a descendant of an unreadable entry
      //     (#215). The store cannot see that entry, so `a.b.c` would land
      //     beside an unreadable `a.b` — a leaf and a subtree under one name
      //     — and once the file is resolved the next full save deletes one
      //     of them. setOne() sends every such write here: it detects the
      //     collision from the file names and returns false.
      for (const [key] of toWrite) {
        for (const u of unreadableEntries.values()) {
          if (u.file.key !== undefined && keysCollide(key, u.file.key)) throw nameCollisionError(key, u.file);
        }
      }

      // 3d. Nor a new key whose path opens another entry's file (#246) —
      //     copy, rename and import write through here. An entry this same
      //     save deletes is not in the way: the write lands in its file, and
      //     step 4 then leaves that file alone.
      const deleting = new Set(toDelete);
      for (const [key] of toWrite) {
        if (entryCache.has(key)) continue;
        const twin = foldTwin(dir, key, entryCache.keys());
        if (twin !== undefined && !deleting.has(twin)) throw new KeyCollisionError({ kind: 'fold', key, existing: [twin] });
      }

      // 4. Apply deltas, every write before any delete (#259). A write can
      //    fail (a name too long for the filesystem, a directory in the
      //    way, a file made immutable); a delete done before it is not
      //    undone, so a rename lost its source and kept only the keys it had
      //    written so far. Each atomicWriteFileSync is individually atomic;
      //    concurrent readers detect mid-commit state via the odd epoch we
      //    wrote in step 0 and retry their scan in load().
      //
      //    The confirmation list goes first when it gains flags, and last
      //    when it loses them: whichever write fails, nothing that was
      //    gated before or after this commit is ungated in between. A
      //    rename adds the new keys' flags — a renamed command must never
      //    exist on disk without its flag. A list that both gains and loses
      //    is written twice: the union first, the final list last.
      //
      //    When the commit deletes no file, that last write is still inside
      //    the undo: if it fails, the entries and the alias map it was
      //    written with are taken back (#268, #257). `set <key> <value>
      //    --no-confirm` and `set <key> --no-confirm -a <alias>` write a list
      //    that loses a flag, and left the value or the alias behind when the
      //    list could not be written. With deletes, it stays after them, as
      //    before: a delete is not undone, and the list goes last.
      const oldConfirm = confirmCache?.data ?? {};
      const unionConfirm = { ...oldConfirm, ...data.confirm };
      const confirmGains = rewriteConfirm && !shallowEquals(oldConfirm, unionConfirm);
      const confirmLoses = rewriteConfirm && !shallowEquals(unionConfirm, data.confirm);
      const finalConfirm = rewriteConfirm && (confirmLoses || !confirmGains);
      const finalConfirmUndoable = finalConfirm && toDelete.length === 0;
      // The alias map as it stood, to put back: undefined when there was no file.
      const priorAliases = aliasesCache && aliasesCache.mtimeMs !== -1 ? { ...aliasesCache.data } : undefined;
      const written: [string, EntryWrapper][] = [];
      // What each write replaced, to put back if a later one fails. Found by
      // the file the key's path opens, not by the key: on a filesystem that
      // folds names the write of `Deploy` lands in the file of a stored
      // `deploy`, and undoing it by unlinking that path deleted `deploy`.
      const replaced: ({ path: string; content: string } | undefined)[] = [];
      // The cached keys by the file each opens, built the first time a write
      // lands in a file not cached under its own key: once per commit, not
      // once per such write (an import re-casing many keys).
      let cachedByFile: Map<string, string> | undefined;
      const priorOf = (key: string): { path: string; content: string } | undefined => {
        const filePath = entryFilePath(dir, key);
        const exact = entryCache.get(key);
        if (exact) return { path: filePath, content: serializeEntryWrapper(exact.wrapper) };
        const id = fileIdentity(filePath);
        if (id === undefined) return undefined;   // a new file: undone by removing it
        if (!cachedByFile) {
          cachedByFile = new Map();
          for (const other of entryCache.keys()) {
            const otherId = fileIdentity(entryFilePath(dir, other));
            if (otherId !== undefined && !cachedByFile.has(otherId)) cachedByFile.set(otherId, other);
          }
        }
        const other = cachedByFile.get(id);
        const cached = other !== undefined ? entryCache.get(other) : undefined;
        if (other !== undefined && cached) {
          return { path: entryFilePath(dir, other), content: serializeEntryWrapper(cached.wrapper) };
        }
        try {
          return { path: filePath, content: fs.readFileSync(filePath, 'utf8') };
        } catch {
          return undefined;
        }
      };
      let confirmTouched = false;
      let aliasesTouched = false;
      try {
        if (confirmGains) {
          atomicWriteFileSync(confirmPath, serializeSidecar(unionConfirm));
          confirmTouched = true;
        }
        for (const [key, value, updated] of toWrite) {
          // Preserve `meta.created` from the existing wrapper if present; set it
          // to `updated` only on first write. Untracked entries (migrated without
          // a timestamp) stay bare — no `meta` block at all.
          const existingCreated = entryCache.get(key)?.wrapper.meta?.created;
          const wrapper: EntryWrapper = updated !== undefined
            ? { value, meta: { created: existingCreated ?? updated, updated } }
            : { value };
          const prior = priorOf(key);
          atomicWriteFileSync(entryFilePath(dir, key), serializeEntryWrapper(wrapper));
          written.push([key, wrapper]);
          replaced.push(prior);
        }
        if (rewriteAliases) {
          atomicWriteFileSync(aliasPath, serializeSidecar(data.aliases));
          aliasesTouched = true;
        }
        if (finalConfirmUndoable) atomicWriteFileSync(confirmPath, serializeSidecar(data.confirm));
      } catch (err) {
        // Put back what this commit wrote; delete nothing. Best effort: a
        // file that cannot be restored is left as written — and then the
        // confirmation list keeps the flags it gained, so that leftover is
        // gated too (a flag too many gates nothing that exists).
        // Last write first: two writes can land in one file (two spellings of
        // a key, folded), and the later one's prior state is the earlier
        // one's bytes. Undone in write order, the earlier write was taken
        // back first and then rewritten from the later one's copy.
        let undoFailed = false;
        let sidecarUndoFailed = false;
        for (let i = written.length - 1; i >= 0; i--) {
          const [key] = written[i];
          const prior = replaced[i];
          try {
            if (prior) atomicWriteFileSync(prior.path, prior.content);
            else fs.unlinkSync(entryFilePath(dir, key));
          } catch (undo) {
            undoFailed = true;
            debug(`Could not undo the write of ${key}: ${String(undo)}`);
          }
        }
        if (aliasesTouched) {
          try {
            if (priorAliases !== undefined) atomicWriteFileSync(aliasPath, serializeSidecar(priorAliases));
            else fs.unlinkSync(aliasPath);
          } catch (undo) {
            sidecarUndoFailed = true;
            debug(`Could not undo the alias map: ${String(undo)}`);
          }
        }
        if (confirmTouched && !undoFailed) {
          try {
            atomicWriteFileSync(confirmPath, serializeSidecar(oldConfirm));
          } catch (undo) {
            sidecarUndoFailed = true;
            debug(`Could not undo the confirmation list: ${String(undo)}`);
          }
        }
        // Every file put back: the store is as it was (#271's message says so).
        progress.changed = undoFailed || sidecarUndoFailed;
        throw err;
      }
      // #271: from here the message may not say "Nothing was written" —
      // unless this commit changed nothing yet, and then a failed delete
      // leaves the store as it was. A sidecar written where there was none,
      // with nothing in it, changes nothing: a missing one reads as empty.
      if (written.length > 0 || confirmTouched
        || (aliasesTouched && !shallowEquals(priorAliases ?? {}, data.aliases))
        || (finalConfirmUndoable && !shallowEquals(oldConfirm, data.confirm))) progress.changed = true;
      for (const [key, wrapper] of written) {
        entryCache.set(key, { wrapper, mtimeMs: fs.statSync(entryFilePath(dir, key)).mtimeMs });
        unreadableEntries.delete(key);
      }
      // A deleted key whose path is the file a written key now holds — the
      // same name in another normalization, or another fold of it (3d) —
      // is not deleted: that would delete what was just written.
      const writtenFiles = toDelete.length > 0 ? new Set(written.map(([k]) => fileIdentity(entryFilePath(dir, k)))) : new Set<string | undefined>();
      writtenFiles.delete(undefined);
      // #271: a file that cannot be deleted (immutable, no permission) was
      // logged and skipped, and the command reported the entry removed. The
      // rest are still deleted; then the commit fails, naming the first, and
      // the list keeps any flag it would have lost after them (step 5): the
      // entry is still there, and a flag too many gates nothing that is gone.
      let deleteFailure: { err: unknown } | undefined;
      for (const key of toDelete) {
        const filePath = entryFilePath(dir, key);
        if (!writtenFiles.has(fileIdentity(filePath))) {
          try {
            fs.unlinkSync(filePath);
            progress.changed = true;
          } catch (err) {
            if (!isENOENT(err)) {
              debug(`Failed to delete entry file for ${key}: ${String(err)}`);
              deleteFailure ??= { err };
              continue;   // still on disk: it stays cached
            }
          }
        }
        entryCache.delete(key);
      }
      if (deleteFailure) {
        // Neither sidecar cache can be trusted to match the disk now: re-read both.
        aliasesCache = null;
        confirmCache = null;
        throw deleteFailure.err;
      }

      // 5. Sidecar caches; the final confirmation list when it lost flags.
      //    After a write, pick up the new mtime from statSync so future
      //    scans can skip the re-read.
      if (rewriteAliases) {
        aliasesCache = { data: { ...data.aliases }, mtimeMs: fs.statSync(aliasPath).mtimeMs };
      }
      if (rewriteConfirm) {
        if (finalConfirm && !finalConfirmUndoable) atomicWriteFileSync(confirmPath, serializeSidecar(data.confirm));
        confirmCache = { data: { ...data.confirm }, mtimeMs: fs.statSync(confirmPath).mtimeMs };
      }

      // 6. End commit: underOddEpoch bumps the epoch to the next even
      //    value. Any reader that snapshots the epoch from then on will see
      //    a stable, committed state.
    }, () => {
      // 7. Refresh the dir-mtime fast-skip token. Our own writes bumped the
      //    dir mtime, and without this the next load() always pays a full
      //    rescan. Safe here: scanAndSync ran under this lock (step 1) and
      //    every later mutation was ours, the even epoch included.
      refreshDirToken(dir);
    }));
  }

  /**
   * Read the store as it stands under its lock, and decide something from
   * it while the lock is still held (#259). For a transaction that writes
   * another store and has to read this one consistently with that write: a
   * rename reads the other store's confirmation list, and no flag can be set
   * there until the rename is done.
   *
   * Writes nothing, so the epoch stays even and readers are not held up.
   * `fn` gets the same fresh state update() hands its caller (full scan,
   * both sidecars re-read) and `unreadable()` is current while it runs. It
   * must be synchronous and must not write this store. It may update
   * another store: that is how two locks are held at once — see
   * updateUnderBothLocks in store.ts, the only caller, for the lock order.
   */
  function inspect<T>(fn: (current: UnifiedData) => T): T {
    const dir = getDirPath();
    let entered = false;
    const read = (): T => {
      entered = true;
      dirMtimeMs = -1;
      scanAndSync();
      aliasesCache = rereadSidecar<Record<string, string>>(path.join(dir, ALIASES_FILE), 'aliases');
      confirmCache = rereadSidecar<Record<string, true>>(path.join(dir, CONFIRM_FILE), 'confirm');
      return fn(snapshot());
    };
    // The lock file sits beside the store directory. Where even its parent
    // is missing, no store has ever been written here and there is nothing
    // to hold still: read the empty store without the lock. Where this
    // process may not write that directory (a project checked out
    // read-only, a data dir owned by another user) it can neither take the
    // lock nor clear a stale one, nor write this store: read it as it is,
    // as a reader does, without waiting on a lock it can never have.
    const lockDir = path.dirname(path.resolve(getStoreLockKey(dir)));
    if (!fs.existsSync(lockDir) || !isWritableDir(lockDir)) return read();
    try {
      return withStoreLock(dir, read);
    } catch (err) {
      // The same, found out only on trying: the lock file could not be
      // created. Only a failure to take the lock is retried this way,
      // never one from `fn`.
      if (entered || !isUnwritableError(err)) throw err;
      debug(`inspect(${dir}): no lock (${String(err)}), reading without it`);
      return read();
    }
  }

  /**
   * Refresh the dir-mtime fast-skip token after writes of our own. Only
   * after a scan under the lock: then every later change was ours, and the
   * caches are authoritative.
   */
  function refreshDirToken(dir: string): void {
    try {
      dirMtimeMs = fs.statSync(dir).mtimeMs;
    } catch {
      dirMtimeMs = -1;
    }
  }

  /**
   * Fast-path single-entry read. Bypasses scanAndSync entirely — one stat +
   * one read + one parse, regardless of how many other entries exist. Used by
   * `getEntryFast` in `store.ts` for the common leaf-key lookup case.
   *
   * Returns `undefined` on ENOENT (no entry, or `key` is a parent of multiple
   * stored leaves — the slow path via `load()` is required to materialize a
   * subtree). Throws StoreUnreadableError when the file exists but does not
   * parse (#215): that is not a miss, and reporting it as one is what sends a
   * caller off to write a fresh entry over a git conflict.
   */
  function getOne(key: string): CodexValue | undefined {
    if (!isValidEntryKey(key)) return undefined;
    const dir = getDirPath();
    let filePath: string;
    try {
      filePath = entryFilePath(dir, key);
    } catch {
      return undefined;
    }
    let raw: string;
    try {
      raw = readStoreFile(filePath);
    } catch (err) {
      if (!isENOENT(err)) {
        debug(`getOne(${key}) failed: ${String(err)}`);
      }
      return undefined;
    }
    const wrapper = parseEntryWrapper(raw);
    if (!wrapper) {
      throw new StoreUnreadableError(
        [{ kind: 'entry', path: filePath, key, reason: classifyUnparseable(raw) }],
        'read',
      );
    }
    return wrapper.value;
  }

  /**
   * Fast-path single-entry write. Performs one cheap `readdirSync` for
   * collision detection, writes the wrapper file under the store lock, and
   * bumps the seqlock epoch — but skips the full `scanAndSync` that the
   * normal `save()` path performs.
   *
   * Returns `false` (without writing) if a collision is detected, comparing
   * keys case-insensitively:
   *   - **Parent-leaf collision:** any ancestor of `key` exists as a stored
   *     leaf (e.g. `key="a.b.c"` and `a.json` or `a.b.json` exists).
   *   - **Child collision:** any stored entry has `key + '.'` as a prefix
   *     (e.g. `key="a"` and `a.b.json` exists).
   *   - **Case collision:** a stored key differs from `key` only by case
   *     (#216) — the same file on a case-insensitive filesystem.
   *
   * In each case the caller (`storage.ts:setValue`) falls back to the slow
   * path, which loads the tree and refuses the write, naming the entries in
   * the way (#224). It used to restructure there, silently removing them.
   */
  function setOne(key: string, value: CodexValue, updated: number): boolean {
    const progress: CommitProgress = { changed: false };
    try {
      return writeOne(key, value, updated, progress);
    } catch (err) {
      // #271: a file operation the filesystem refused, named in one line.
      throw toStoreWriteError(err, !progress.changed);
    }
  }

  /** setOne()'s body. `progress.changed`: the entry file was written. */
  function writeOne(key: string, value: CodexValue, updated: number, progress: CommitProgress): boolean {
    if (!isValidEntryKey(key)) {
      throw new Error(`Invalid store key: ${JSON.stringify(key)}`);
    }
    const dir = getDirPath();
    assertNotTestCheckout(dir);
    ensureDir();
    ensureStoreSeeds(dir);

    return withStoreLock(dir, () => {
      // Whether the dir-mtime fast-skip token is current right now. Unlike
      // save(), this path never scans, so we may only refresh the token after
      // writing if it was already valid — refreshing a stale token would make
      // the next load() fast-skip past another process's earlier writes.
      let cacheWasCurrent = false;
      try {
        cacheWasCurrent = dirMtimeMs !== -1 && fs.statSync(dir).mtimeMs === dirMtimeMs;
      } catch { /* treat as stale */ }

      // Single readdir for collision detection. Cheap (one syscall) compared
      // to scanAndSync's per-entry stat + read.
      let dirEntries: string[];
      try {
        dirEntries = fs.readdirSync(dir);
      } catch (err) {
        if (isENOENT(err)) {
          dirEntries = [];
        } else {
          throw err;
        }
      }

      // Collision with another entry: an ancestor that is a leaf, an entry
      // under this key, or a key that differs only by case (#216 — one file
      // on a case-insensitive filesystem). Compared case-insensitively on
      // every filesystem. The caller falls back to the slow path, which
      // names the entries in the way and refuses (#224).
      const otherKeys = dirEntries.filter(isEntryFilename).map(keyFromFilename);
      if (collidesWithAny(key, otherKeys)) {
        return false;
      }
      // #246: a spelling the name check cannot see that opens another entry's
      // file. Refused here: the slow path compares names too, and its save()
      // would write the same file.
      if (!otherKeys.includes(key)) {
        const twin = foldTwin(dir, key, otherKeys);
        if (twin !== undefined) throw new KeyCollisionError({ kind: 'fold', key, existing: [twin] });
      }

      // Read the existing entry before anything is touched: to preserve
      // `meta.created`, and to refuse the write when the file is there but
      // does not parse (#215) — replacing it would discard both sides of a
      // git conflict and reset `created`. Refusing here, ahead of the epoch
      // bump, leaves the store byte-for-byte as it was.
      const filePath = entryFilePath(dir, key);
      let existingCreated: number | undefined;
      let existingRaw: string | undefined;
      try {
        // #159: reject a symlinked existing entry file rather than reading
        // its target. The atomicWriteFileSync below renames a tmp file over
        // filePath, replacing the symlink with a real file, so the write
        // still lands safely inside the (verified real) store dir.
        existingRaw = readStoreFile(filePath);
      } catch (err) {
        if (!isENOENT(err)) {
          debug(`setOne(${key}) read-existing failed: ${String(err)}`);
        }
      }
      if (existingRaw !== undefined) {
        const existing = parseEntryWrapper(existingRaw);
        if (!existing) {
          throw new StoreUnreadableError(
            [{ kind: 'entry', path: filePath, key, reason: classifyUnparseable(existingRaw) }],
            'write',
          );
        }
        existingCreated = existing.meta?.created;
      }

      // 0. Begin commit: bump epoch odd. Mirrors save()'s seqlock contract so
      //    concurrent readers see the in-progress state and retry their scan.
      //    6. End commit: underOddEpoch bumps it even on every way out, so a
      //    partially-failed write still leaves the seqlock in a stable state
      //    for readers (#262).
      underOddEpoch(dir, () => {
        const wrapper: EntryWrapper = {
          value,
          meta: { created: existingCreated ?? updated, updated },
        };
        atomicWriteFileSync(filePath, serializeEntryWrapper(wrapper));
        progress.changed = true;

        // Refresh the per-entry cache so a subsequent load() doesn't re-read
        // a file we just wrote ourselves.
        // The write went through, so the file parses: it was read fresh above.
        // Drop any record of it as unreadable left by an earlier scan (#215).
        unreadableEntries.delete(key);
        try {
          const mtimeMs = fs.statSync(filePath).mtimeMs;
          entryCache.set(key, { wrapper, mtimeMs });
        } catch (err) {
          debug(`setOne(${key}) post-write stat failed: ${String(err)}`);
        }
      });

      if (cacheWasCurrent) {
        try {
          dirMtimeMs = fs.statSync(dir).mtimeMs;
        } catch {
          dirMtimeMs = -1;
        }
      }

      return true;
    });
  }

  function storedKeys(): string[] {
    return [...entryCache.keys()];
  }

  return { load, save, update, inspect, storedKeys, clear, getOne, setOne, unreadable };
}

// ── Migration ──────────────────────────────────────────────────────────

/** Result of a migration attempt. */
export interface DirectoryMigrationResult {
  /**
   * - `no-op`: neither the old file nor the new directory exists (fresh install)
   * - `already-present`: the new directory already exists (nothing to do)
   * - `migrated`: successfully converted the old file to the new directory layout
   */
  status: 'no-op' | 'already-present' | 'migrated';
  entryCount: number;
  backupPath?: string;
}

/**
 * Migrate a unified-format store file to the file-per-entry directory layout.
 *
 * - If `newDirPath` already exists as a directory: no-op (returns `already-present`).
 *   If `oldFilePath` also exists alongside it, rename it to `.backup` as cleanup.
 * - If `oldFilePath` does not exist: no-op (returns `no-op`).
 * - Otherwise: read the unified file, write per-entry wrapper files and sidecars
 *   into `newDirPath`, then rename the old file to `<oldFilePath>.backup`.
 *
 * The migration preserves each entry's `_meta.updated` timestamp as
 * `meta.created` AND `meta.updated` in the new wrapper (see design decision #9
 * in the Phase 1 comment). Untracked entries (no `_meta` timestamp) migrate
 * with no `meta` block, preserving the `[untracked]` staleness label.
 *
 * Concurrency: wrapped in `withFileLock` using the same lock key as the
 * steady-state store (`<newDirPath>.lock`). This serializes concurrent
 * first-run migrations — the second process waits, then observes the new
 * directory and returns `already-present`. It also guarantees that a
 * migration never races a normal `save()` on the same store.
 *
 * The parent directory of `newDirPath` is guaranteed to exist before this
 * is called: for the global store, `getGlobalStore()` runs
 * `ensureDataDirectoryExists()` first; for the project store, the parent
 * is the project root which the user creates explicitly via `rvr init`.
 * If the parent is somehow missing, `withFileLock` will throw under the
 * v1.11 fail-closed semantics (set `RVR_DISABLE_LOCKING=1` for tests
 * that intentionally exercise the unlocked path).
 */
export function migrateFileToDirectory(
  oldFilePath: string,
  newDirPath: string
): DirectoryMigrationResult {
  // Every process asks this at startup, reads included. With the directory
  // in place and no old file there is nothing to migrate — the locked path
  // would answer the same — so don't wait on a lock another writer holds.
  if (!fs.existsSync(oldFilePath)) {
    try {
      if (fs.statSync(newDirPath).isDirectory()) return { status: 'already-present', entryCount: 0 };
    } catch { /* no directory yet: take the lock and look again */ }
  }
  assertNotTestCheckout(newDirPath);   // #274: the lock, the directory, the backup
  return withFileLock(getStoreLockKey(newDirPath), () =>
    migrateFileToDirectoryLocked(oldFilePath, newDirPath)
  );
}

/**
 * Core migration body. Invoked from {@link migrateFileToDirectory} while
 * holding the store lock. Not exported — callers should always go through
 * the locked entry point.
 */
function migrateFileToDirectoryLocked(
  oldFilePath: string,
  newDirPath: string
): DirectoryMigrationResult {
  // If the new directory already exists, it's authoritative. Clean up the
  // old file if it somehow lingers (e.g., aborted prior migration).
  if (fs.existsSync(newDirPath)) {
    try {
      const stat = fs.statSync(newDirPath);
      if (!stat.isDirectory()) {
        throw new Error(
          `Expected ${newDirPath} to be a directory, but found a file. ` +
          `Resolve this conflict manually before upgrading.`
        );
      }
    } catch (err) {
      if (!isENOENT(err)) throw err;
    }
    if (fs.existsSync(oldFilePath)) {
      try {
        fs.renameSync(oldFilePath, oldFilePath + '.backup');
        debug(`Cleaned up lingering ${oldFilePath} after previous migration`);
      } catch (err) {
        debug(`Failed to clean up ${oldFilePath}: ${String(err)}`);
      }
    }
    return { status: 'already-present', entryCount: 0 };
  }

  if (!fs.existsSync(oldFilePath)) {
    return { status: 'no-op', entryCount: 0 };
  }

  // Read and parse the old unified file.
  let parsed: Record<string, unknown>;
  try {
    const raw = readStoreFile(oldFilePath);
    parsed = (raw?.trim() ? JSON.parse(raw) : {}) as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      `Failed to parse old store file ${oldFilePath}: ${String(err)}. ` +
      `Fix the JSON manually or delete the file before upgrading.`,
      { cause: err }
    );
  }

  const entries = (parsed.entries ?? {}) as CodexData;
  const aliases = (parsed.aliases ?? {}) as Record<string, string>;
  const confirm = (parsed.confirm ?? {}) as Record<string, true>;
  const meta = (parsed._meta ?? {}) as Record<string, number>;

  // Write to a sibling temporary directory first, then atomically rename it to
  // newDirPath. This ensures that a crash or power loss mid-migration never
  // leaves a partially-populated newDirPath that would be treated as authoritative
  // on the next run (the existsSync guard at the top would skip migration if it
  // found a partially-written newDirPath).
  const tmpDirPath = newDirPath + '.tmp';

  // Clean up any leftover tmp dir from a previous failed attempt.
  if (fs.existsSync(tmpDirPath)) {
    fs.rmSync(tmpDirPath, { recursive: true, force: true });
  }
  fs.mkdirSync(tmpDirPath, { recursive: true, mode: 0o700 });

  // Write each entry as a wrapper file.
  const flat = flattenObject(entries);
  let entryCount = 0;
  try {
    for (const [key, value] of Object.entries(flat)) {
      if (!isValidEntryKey(key)) {
        debug(`Skipping entry with invalid key during migration: ${JSON.stringify(key)}`);
        continue;
      }
      const updated = meta[key];
      const wrapper: EntryWrapper = updated !== undefined
        ? { value, meta: { created: updated, updated } }
        : { value };  // untracked entries stay bare
      atomicWriteFileSync(entryFilePath(tmpDirPath, key), serializeEntryWrapper(wrapper));
      entryCount++;
    }

    // Write sidecars (even if empty — lets the store unambiguously report
    // "aliases: {}" vs "aliases: never-existed").
    atomicWriteFileSync(path.join(tmpDirPath, ALIASES_FILE), serializeSidecar(aliases));
    atomicWriteFileSync(path.join(tmpDirPath, CONFIRM_FILE), serializeSidecar(confirm));

    // Seed the epoch at 0 (stable/even). The first post-migration save()
    // will bump it to 1 → 2, and readers running concurrently with that
    // first save will correctly detect the in-progress commit.
    writeEpoch(tmpDirPath, 0);

    // Seed the hand-edit README and the per-clone .gitignore alongside the
    // data files, so the migrated directory matches a fresh store (#187).
    ensureStoreSeeds(tmpDirPath);

    // Atomic swap: rename the fully-written tmp directory to the final path.
    fs.renameSync(tmpDirPath, newDirPath);
  } catch (err) {
    // Clean up the incomplete tmp directory so the next run can retry.
    try { fs.rmSync(tmpDirPath, { recursive: true, force: true }); } catch { /* best-effort */ }
    throw err;
  }

  // Rename old file to .backup (idempotent if a prior .backup exists: overwrite it).
  const backupPath = oldFilePath + '.backup';
  try {
    if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath);
  } catch { /* best-effort */ }
  fs.renameSync(oldFilePath, backupPath);

  debug(`Migrated ${entryCount} entries from ${oldFilePath} to ${newDirPath}`);
  return { status: 'migrated', entryCount, backupPath };
}
