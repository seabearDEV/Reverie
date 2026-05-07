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
 * Design and decisions: see GitHub issue #54 and `arch.storeLayout` in the
 * project codex.
 */

import fs from 'fs';
import path from 'path';
import { CodexData, CodexValue } from '../types';
import type { ScopedStore, UnifiedData } from '../store';
import { atomicWriteFileSync } from './atomicWrite';
import { withFileLock } from './fileLock';
import { flattenObject, expandFlatKeys } from './objectPath';
import { debug } from './debug';

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
}

// ── File layout helpers ────────────────────────────────────────────────

const ALIASES_FILE = '_aliases.json';
const CONFIRM_FILE = '_confirm.json';
const EPOCH_FILE = '_epoch.json';
const README_FILE = '_README.md';
const ENTRY_FILE_SUFFIX = '.json';

/**
 * Hand-edit warning written to `<store>/_README.md` on store creation. The
 * `_` prefix means isEntryFilename ignores it; it exists purely as an
 * in-context nudge for developers browsing the directory who might
 * otherwise be tempted to open an entry file and tweak it. See the codex
 * entry `conventions.editSurface` for the rationale.
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
  mid-commit. You should never need to touch it.

**Edit via one of:**

- \`rvr set <key> <value>\` (and the rest of the CLI)
- The Reverie MCP tools (\`reverie_set\`, \`reverie_get\`, etc.)
- A future UI

Direct edits to these files desync per-entry metadata (created/updated
timestamps, future verified/agent fields) and silently break staleness
signals. The wrapper format \`{ value, meta }\` assumes only the official
tools touch it.

If you need to bulk-import or restructure, do it through the CLI.
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

/** Reads a sidecar file, returning an empty object on ENOENT or parse failure. */
function readSidecar<T>(filePath: string): T {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return (raw?.trim() ? JSON.parse(raw) : {}) as T;
  } catch (err) {
    if (!isENOENT(err)) {
      debug(`Failed to read sidecar ${filePath}: ${String(err)}`);
    }
    return {} as T;
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
    const raw = fs.readFileSync(path.join(dir, EPOCH_FILE), 'utf8');
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
 * Write the hand-edit warning README to the store directory if it doesn't
 * already exist. Idempotent and best-effort: a failure to write (read-only
 * filesystem, permissions) is logged via debug and swallowed so the store
 * itself keeps working.
 *
 * Use an atomic no-clobber create so a README that appears concurrently
 * (for example, a user-customized file) is preserved rather than replaced.
 */
function ensureReadme(dir: string): void {
  const readmePath = path.join(dir, README_FILE);
  try {
    fs.writeFileSync(readmePath, README_CONTENT, { flag: 'wx' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return;
    debug(`Failed to write ${README_FILE} in ${dir}: ${String(err)}`);
  }
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
    const data = readSidecar<T>(filePath);
    return { data, mtimeMs: stat.mtimeMs };
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
    // still authoritative. Skip the readdir + per-entry stat loop.
    try {
      const dirStat = fs.statSync(dir);
      if (dirMtimeMs !== -1 && dirStat.mtimeMs === dirMtimeMs) {
        return;
      }
      dirMtimeMs = dirStat.mtimeMs;
    } catch (err) {
      if (isENOENT(err)) {
        entryCache.clear();
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
      if (cached?.mtimeMs === mtimeMs) continue;
      try {
        const raw = fs.readFileSync(filePath, 'utf8');
        const wrapper = parseEntryWrapper(raw);
        if (wrapper) {
          entryCache.set(key, { wrapper, mtimeMs });
        } else {
          debug(`Skipping unparseable entry file: ${filePath}`);
        }
      } catch (err) {
        debug(`Failed to read entry file ${filePath}: ${String(err)}`);
      }
    }

    // Drop cache entries for files that no longer exist.
    for (const key of [...entryCache.keys()]) {
      if (!seen.has(key)) entryCache.delete(key);
    }

    // Refresh sidecar caches. refreshSidecar stats first and re-parses only
    // if the mtime changed, so an unchanged sidecar costs a single stat()
    // instead of a stat + read + JSON.parse.
    aliasesCache = refreshSidecar<Record<string, string>>(
      path.join(dir, ALIASES_FILE),
      aliasesCache
    );
    confirmCache = refreshSidecar<Record<string, true>>(
      path.join(dir, CONFIRM_FILE),
      confirmCache
    );
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

    // Assemble the nested `entries` tree from the flat per-key cache.
    const flat: Record<string, CodexValue> = {};
    const meta: Record<string, number> = {};
    for (const [key, cached] of entryCache) {
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
    return result;
  }

  function save(data: UnifiedData): void {
    const dir = getDirPath();
    ensureDir();
    ensureReadme(dir);

    withFileLock(getStoreLockKey(dir), () => {
      // 0. Begin commit: bump epoch to the next odd value. Readers that
      //    observe an odd epoch loop in their seqlock retry until we finish.
      //    readEpoch() returns 0 if the file is missing, so the first save
      //    on a fresh store transitions 0 → 1 → 2.
      const startEpoch = readEpoch(dir);
      const inProgressEpoch = startEpoch + (startEpoch % 2 === 0 ? 1 : 2);
      writeEpoch(dir, inProgressEpoch);

      // 1. Flatten new entries to leaves (authoritative new state).
      const newFlat = flattenObject(data.entries as Record<string, unknown>);

      // 2. Re-scan under the lock for authoritative current state.
      scanAndSync();

      // 3. Compute deltas.
      const toDelete: string[] = [];
      for (const key of entryCache.keys()) {
        if (!(key in newFlat)) toDelete.push(key);
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

      // 4. Apply deltas. Each atomicWriteFileSync is individually atomic;
      //    concurrent readers detect mid-commit state via the odd epoch we
      //    wrote in step 0 and retry their scan in load().
      for (const key of toDelete) {
        try {
          fs.unlinkSync(entryFilePath(dir, key));
        } catch (err) {
          if (!isENOENT(err)) {
            debug(`Failed to delete entry file for ${key}: ${String(err)}`);
          }
        }
        entryCache.delete(key);
      }
      for (const [key, value, updated] of toWrite) {
        // Preserve `meta.created` from the existing wrapper if present; set it
        // to `updated` only on first write. Untracked entries (migrated without
        // a timestamp) stay bare — no `meta` block at all.
        const existingCreated = entryCache.get(key)?.wrapper.meta?.created;
        const wrapper: EntryWrapper = updated !== undefined
          ? { value, meta: { created: existingCreated ?? updated, updated } }
          : { value };
        const filePath = entryFilePath(dir, key);
        atomicWriteFileSync(filePath, serializeEntryWrapper(wrapper));
        const mtimeMs = fs.statSync(filePath).mtimeMs;
        entryCache.set(key, { wrapper, mtimeMs });
      }

      // 5. Sidecars — rewrite only if changed. After a write, pick up the
      //    new mtime from statSync so future scans can skip the re-read.
      if (!aliasesCache || aliasesCache.mtimeMs === -1 || !shallowEquals(aliasesCache.data, data.aliases)) {
        const aliasPath = path.join(dir, ALIASES_FILE);
        atomicWriteFileSync(aliasPath, serializeSidecar(data.aliases));
        aliasesCache = { data: { ...data.aliases }, mtimeMs: fs.statSync(aliasPath).mtimeMs };
      }
      if (!confirmCache || confirmCache.mtimeMs === -1 || !shallowEquals(confirmCache.data, data.confirm)) {
        const confirmPath = path.join(dir, CONFIRM_FILE);
        atomicWriteFileSync(confirmPath, serializeSidecar(data.confirm));
        confirmCache = { data: { ...data.confirm }, mtimeMs: fs.statSync(confirmPath).mtimeMs };
      }

      // 6. End commit: bump epoch to the next even value. Any reader that
      //    snapshots the epoch from here on will see a stable, committed state.
      writeEpoch(dir, inProgressEpoch + 1);
    });
  }

  /**
   * Fast-path single-entry read. Bypasses scanAndSync entirely — one stat +
   * one read + one parse, regardless of how many other entries exist. Used by
   * `getEntryFast` in `store.ts` for the common leaf-key lookup case.
   *
   * Returns `undefined` on ENOENT (no entry, or `key` is a parent of multiple
   * stored leaves — the slow path via `load()` is required to materialize a
   * subtree).
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
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const wrapper = parseEntryWrapper(raw);
      return wrapper?.value;
    } catch (err) {
      if (!isENOENT(err)) {
        debug(`getOne(${key}) failed: ${String(err)}`);
      }
      return undefined;
    }
  }

  /**
   * Fast-path single-entry write. Performs one cheap `readdirSync` for
   * collision detection, writes the wrapper file under the store lock, and
   * bumps the seqlock epoch — but skips the full `scanAndSync` that the
   * normal `save()` path performs.
   *
   * Returns `false` (without writing) if a collision is detected:
   *   - **Parent-leaf collision:** any ancestor of `key` exists as a stored
   *     leaf (e.g. `key="a.b.c"` and `a.json` or `a.b.json` exists). The
   *     write would require restructuring the parent into a subtree.
   *   - **Child collision:** any stored entry has `key + '.'` as a prefix
   *     (e.g. `key="a"` and `a.b.json` exists). The write would require
   *     unlinking the children to keep the in-memory tree consistent.
   *
   * In either case the caller (`storage.ts:setValue`) falls back to the full
   * `save()` path, which already handles these conversions correctly via its
   * delete/write delta computation.
   */
  function setOne(key: string, value: CodexValue, updated: number): boolean {
    if (!isValidEntryKey(key)) {
      throw new Error(`Invalid store key: ${JSON.stringify(key)}`);
    }
    const dir = getDirPath();
    ensureDir();
    ensureReadme(dir);

    return withFileLock(getStoreLockKey(dir), () => {
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

      // Parent-leaf collision: walk up the dotted prefixes.
      const parts = key.split('.');
      for (let i = 1; i < parts.length; i++) {
        const parent = parts.slice(0, i).join('.');
        if (dirEntries.includes(parent + ENTRY_FILE_SUFFIX)) {
          return false;  // caller falls back to slow path
        }
      }

      // Child collision: any existing entry whose key starts with `${key}.`.
      const childPrefix = key + '.';
      for (const f of dirEntries) {
        if (!isEntryFilename(f)) continue;
        const otherKey = keyFromFilename(f);
        if (otherKey.startsWith(childPrefix)) {
          return false;  // caller falls back to slow path
        }
      }

      // 0. Begin commit: bump epoch odd. Mirrors save()'s seqlock contract so
      //    concurrent readers see the in-progress state and retry their scan.
      const startEpoch = readEpoch(dir);
      const inProgressEpoch = startEpoch + (startEpoch % 2 === 0 ? 1 : 2);
      writeEpoch(dir, inProgressEpoch);

      try {
        const filePath = entryFilePath(dir, key);

        // Preserve `meta.created` if the entry already exists.
        let existingCreated: number | undefined;
        try {
          const existingRaw = fs.readFileSync(filePath, 'utf8');
          existingCreated = parseEntryWrapper(existingRaw)?.meta?.created;
        } catch (err) {
          if (!isENOENT(err)) {
            debug(`setOne(${key}) read-existing failed: ${String(err)}`);
          }
        }

        const wrapper: EntryWrapper = {
          value,
          meta: { created: existingCreated ?? updated, updated },
        };
        atomicWriteFileSync(filePath, serializeEntryWrapper(wrapper));

        // Refresh the per-entry cache so a subsequent load() doesn't re-read
        // a file we just wrote ourselves.
        try {
          const mtimeMs = fs.statSync(filePath).mtimeMs;
          entryCache.set(key, { wrapper, mtimeMs });
        } catch (err) {
          debug(`setOne(${key}) post-write stat failed: ${String(err)}`);
        }
      } finally {
        // 6. End commit: bump epoch even. In a `finally` so a partially-failed
        //    write still leaves the seqlock in a stable state for readers.
        writeEpoch(dir, inProgressEpoch + 1);
      }

      return true;
    });
  }

  return { load, save, clear, getOne, setOne };
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
    const raw = fs.readFileSync(oldFilePath, 'utf8');
    parsed = (raw?.trim() ? JSON.parse(raw) : {}) as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      `Failed to parse old store file ${oldFilePath}: ${String(err)}. ` +
      `Fix the JSON manually or delete the file before upgrading.`
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
  const flat = flattenObject(entries as Record<string, unknown>);
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

    // Seed the hand-edit warning README alongside the data files, so the
    // migrated directory gets the same nudge a fresh store does.
    ensureReadme(tmpDirPath);

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
