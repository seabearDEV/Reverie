import fs from 'fs';
import path from 'path';
import { CodexData, CodexValue } from './types';
import {
  getUnifiedDataFilePath,
  getDataDirectory,
  getAliasFilePath,
  getConfirmFilePath,
  getGlobalStoreDirPath,
  ensureDataDirectoryExists,
  findProjectFile,
  findProjectStoreDir,
  clearProjectFileCache,
} from './utils/paths';

export { findProjectFile, clearProjectFileCache } from './utils/paths';
import { saveJsonSorted } from './utils/saveJsonSorted';
import { createDirectoryStore, migrateFileToDirectory } from './utils/directoryStore';
import { flattenObject } from './utils/objectPath';
import { debug } from './utils/debug';
import { resolveScopeForWrite } from './projectResolution';

// ── Types ──────────────────────────────────────────────────────────────

export interface UnifiedData {
  entries: CodexData;
  aliases: Record<string, string>;
  confirm: Record<string, true>;
  _meta?: Record<string, number> | undefined;
}

export type Scope = 'project' | 'global' | 'auto';


// ── ScopedStore ────────────────────────────────────────────────────────

export interface ScopedStore {
  load(): UnifiedData;
  save(data: UnifiedData): void;
  clear(): void;
  /**
   * Fast-path single-entry read. Reads exactly one entry file (no directory
   * scan). Returns `undefined` on miss — including the case where `key` is a
   * parent of multiple stored entries (the slow path via `load()` is required
   * to materialize a subtree).
   */
  getOne(key: string): CodexValue | undefined;
  /**
   * Fast-path single-entry write. Writes exactly one entry file (no full
   * pre-load + diff). Returns `false` if a collision is detected that would
   * require restructuring multiple files (parent-leaf conflict, or existing
   * children that would need to be removed) — the caller must fall back to
   * the full `save()` path in that case.
   */
  setOne(key: string, value: CodexValue, updated: number): boolean;
}

// ── Global store singleton ─────────────────────────────────────────────
//
// Note: the old `createScopedStore` factory (single-file, mtime-cached) was
// removed when the file-per-entry layout landed. The store is now always a
// directory (`createDirectoryStore`). The legacy file migration path remains
// below — `migrateToUnifiedFile` handles pre-v1.0 layouts, then
// `migrateFileToDirectory` converts the unified file into the directory.

let globalStore: ScopedStore | null = null;
let migrationDone = false;

/** Ensure the v1.10.0 global store directory exists. */
function ensureGlobalStoreDirExists(): void {
  ensureDataDirectoryExists();  // parent (~/.codexcli/) must exist first
  const storeDir = getGlobalStoreDirPath();
  if (!fs.existsSync(storeDir)) {
    fs.mkdirSync(storeDir, { recursive: true, mode: 0o700 });
  }
}

function getGlobalStore(): ScopedStore {
  if (!globalStore) {
    if (!migrationDone) {
      // Two-stage migration chain:
      //   1. Legacy → unified: handles pre-v1.0 data (entries.json + aliases.json + confirm.json)
      //      and the pre-rename data.json format. Produces a unified .codexcli/data.json.
      //   2. Unified → directory (v1.10.0): converts the unified file to the file-per-entry
      //      layout at ~/.codexcli/store/. This is the new canonical layout.
      //
      // Ensure the parent directory (~/.codexcli/) exists before the
      // directory migration runs, so its file lock (placed at
      // `<storeDir>.lock`, a sibling of the store dir) can be created.
      // Without this, pristine installs would fall through to the
      // unlocked fallback in withFileLock — still safe on a truly-fresh
      // system, but we prefer locked from the start.
      try {
        ensureDataDirectoryExists();
      } catch (err) {
        debug(`Failed to ensure global data directory before migration: ${String(err)}`);
      }
      try {
        migrateToUnifiedFile();
      } catch (err) {
        debug(`Legacy→unified migration error: ${String(err)}`);
      }
      try {
        migrateFileToDirectory(getUnifiedDataFilePath(), getGlobalStoreDirPath());
      } catch (err) {
        debug(`Unified→directory migration error (global): ${String(err)}`);
        // If migration failed and the store directory doesn't exist, the user's
        // existing data.json would be invisible to the directory store. Warn so
        // the failure is actionable rather than silently presenting an empty store.
        if (!fs.existsSync(getGlobalStoreDirPath())) {
          console.warn(
            `[Reverie] Warning: store migration failed and no store directory was created. ` +
            `Your existing data may be inaccessible until migration succeeds. ` +
            `Error: ${String(err)}`
          );
        }
      }
      migrationDone = true;
    }
    globalStore = createDirectoryStore(getGlobalStoreDirPath, ensureGlobalStoreDirExists);
  }
  return globalStore;
}

// ── Project store singleton ────────────────────────────────────────────

let projectStore: ScopedStore | null = null;
let projectStoreDirPath: string | null = null;

function getProjectStore(): ScopedStore | null {
  // v1.10.0 on-demand migration: if no `.codexcli/` directory is found but a
  // legacy `.codexcli.json` file exists at the same logical location, convert
  // it in place before resolving the store.
  let projectDir = findProjectStoreDir();

  if (!projectDir) {
    const legacyPath = findProjectFile();
    // findProjectFile may return either a file or a directory. We only want to
    // trigger migration if it's specifically a legacy `.codexcli.json` file.
    if (legacyPath && path.basename(legacyPath) === '.codexcli.json') {
      const newDir = path.join(path.dirname(legacyPath), '.codexcli');
      try {
        const result = migrateFileToDirectory(legacyPath, newDir);
        if (result.status === 'migrated') {
          debug(`Migrated project store: ${legacyPath} -> ${newDir}`);
        }
        clearProjectFileCache();
        projectDir = findProjectStoreDir();
      } catch (err) {
        debug(`Project store migration failed for ${legacyPath}: ${String(err)}`);
      }
    }
  }

  if (!projectDir) {
    projectStore = null;
    projectStoreDirPath = null;
    return null;
  }

  // Recreate the store if the resolved directory changed (rare within one process).
  if (projectStoreDirPath !== projectDir) {
    const resolved = projectDir;  // local const so closures capture a non-null string
    projectStore = createDirectoryStore(
      () => resolved,
      () => {
        if (!fs.existsSync(resolved)) {
          fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
        }
      }
    );
    projectStoreDirPath = resolved;
  }

  return projectStore;
}

// ── Scope resolution ───────────────────────────────────────────────────

function getEffectiveScope(scope?: Scope  ): 'project' | 'global' {
  if (scope === 'project') return 'project';
  if (scope === 'global') return 'global';
  // auto: use project if available
  return findProjectFile() ? 'project' : 'global';
}

function resolveStore(scope?: Scope  ): ScopedStore {
  const effective = getEffectiveScope(scope);
  if (effective === 'project') {
    const ps = getProjectStore();
    if (ps) return ps;
    // Fallback to global if project file doesn't exist (shouldn't happen with getEffectiveScope)
  }
  return getGlobalStore();
}

// ── Section accessors ──────────────────────────────────────────────────

export function loadEntries(scope?: Scope  ): CodexData {
  return resolveStore(scope).load().entries;
}

export function saveEntries(data: CodexData, scope?: Scope  ): void {
  const store = resolveStore(scope);
  const current = store.load();
  store.save({ ...current, entries: data });
}

/** Fast-path leaf read. Returns undefined on miss; caller falls back to loadEntries. */
export function getEntryFast(key: string, scope?: Scope): CodexValue | undefined {
  return resolveStore(scope).getOne(key);
}

/**
 * Fast-path leaf write. Returns true on success. Returns false if a parent /
 * child collision means the slow path (full load + diff in `save()`) is needed
 * to keep the on-disk store consistent.
 */
export function setEntryFast(key: string, value: CodexValue, scope?: Scope): boolean {
  return resolveStore(scope).setOne(key, value, Date.now());
}

export function loadAliasMap(scope?: Scope  ): Record<string, string> {
  return resolveStore(scope).load().aliases;
}

export function saveAliasMap(data: Record<string, string>, scope?: Scope  ): void {
  const store = resolveStore(scope);
  const current = store.load();
  store.save({ ...current, aliases: data });
}

export function loadConfirmMap(scope?: Scope  ): Record<string, true> {
  return resolveStore(scope).load().confirm;
}

export function saveConfirmMap(data: Record<string, true>, scope?: Scope  ): void {
  const store = resolveStore(scope);
  const current = store.load();
  store.save({ ...current, confirm: data });
}

/**
 * Write one or more sections inside a single store.save cycle so multi-
 * section imports are atomic. Section keys left undefined preserve the
 * current on-disk value. Closes the torn-store window that existed when
 * callers ran saveEntries/saveAliasMap/saveConfirmMap sequentially — each
 * of those is its own load+save pair, leaving a tear between sections on
 * process death or disk error.
 *
 * See #77 for the failure modes this guards against.
 */
export function saveAll(
  sections: {
    entries?: CodexData | undefined;
    aliases?: Record<string, string> | undefined;
    confirm?: Record<string, true> | undefined;
  },
  scope?: Scope,
): void {
  // Bulk transactional write (#77): import handlers + reset paths route here.
  const effectiveScope = resolveScopeForWrite(scope);
  const store = resolveStore(effectiveScope);
  const current = store.load();

  // Stamp _meta for new/changed leaves when entries are written. Without
  // this, imported entries land bare and surface as [untracked]. Preserve
  // the existing timestamp when the value is unchanged so --merge imports
  // don't bump every untouched entry. See #87.
  const nextMeta = sections.entries !== undefined
    ? stampImportMeta(sections.entries, current.entries ?? {}, current._meta ?? {})
    : undefined;

  store.save({
    ...current,
    ...(sections.entries !== undefined && {
      entries: sections.entries,
      _meta: nextMeta,
    }),
    ...(sections.aliases !== undefined && { aliases: sections.aliases }),
    ...(sections.confirm !== undefined && { confirm: sections.confirm }),
  });
}

function stampImportMeta(
  next: CodexData,
  current: CodexData,
  existing: Record<string, number>,
): Record<string, number> {
  const now = Date.now();
  const newFlat = flattenObject(next as Record<string, unknown>);
  const currentFlat = flattenObject(current as Record<string, unknown>);
  const fresh: Record<string, number> = {};
  for (const [key, value] of Object.entries(newFlat)) {
    const prev = existing[key];
    fresh[key] = (prev !== undefined && currentFlat[key] === value) ? prev : now;
  }
  return fresh;
}

// ── Merged accessors (project + global fallthrough) ────────────────────

export function loadEntriesMerged(): CodexData {
  const project = getProjectStore();
  const global = getGlobalStore();
  if (!project) return global.load().entries;

  const globalEntries = global.load().entries;
  const projectEntries = project.load().entries;
  // Shallow merge: project top-level keys override global
  return { ...globalEntries, ...projectEntries };
}

export function loadAliasMapMerged(): Record<string, string> {
  const project = getProjectStore();
  const global = getGlobalStore();
  if (!project) return global.load().aliases;

  return { ...global.load().aliases, ...project.load().aliases };
}

export function loadConfirmMapMerged(): Record<string, true> {
  const project = getProjectStore();
  const global = getGlobalStore();
  if (!project) return global.load().confirm;

  return { ...global.load().confirm, ...project.load().confirm };
}

// ── Cache management ───────────────────────────────────────────────────

export function clearStoreCaches(): void {
  globalStore?.clear();
  projectStore?.clear();
  // Reset singletons so migration re-runs on next access
  globalStore = null;
  projectStore = null;
  projectStoreDirPath = null;
  migrationDone = false;
  clearProjectFileCache();
}

// ── Meta (staleness tracking) ─────────────────────────────────────────

export function loadMeta(scope?: Scope  ): Record<string, number> {
  return resolveStore(scope).load()._meta ?? {};
}

export function touchMeta(key: string, scope?: Scope  ): void {
  const store = resolveStore(scope);
  const current = store.load();
  const meta = { ...(current._meta ?? {}), [key]: Date.now() };
  store.save({ ...current, _meta: meta });
}

export function removeMeta(key: string, scope?: Scope  ): void {
  const store = resolveStore(scope);
  const current = store.load();
  if (!current._meta) return;
  const meta = { ...current._meta };
  // Remove exact key and any children (e.g., removing "server" also removes "server.ip")
  const prefix = key + '.';
  for (const k of Object.keys(meta)) {
    if (k === key || k.startsWith(prefix)) delete meta[k];
  }
  store.save({ ...current, _meta: meta });
}

/** Save entries and touch _meta[key] in a single write. */
export function saveEntriesAndTouchMeta(data: CodexData, key: string, scope?: Scope  ): void {
  const store = resolveStore(scope);
  const current = store.load();
  const meta = { ...(current._meta ?? {}), [key]: Date.now() };
  store.save({ ...current, entries: data, _meta: meta });
}

/** Save entries and remove _meta keys (and children) in a single write. */
export function saveEntriesAndRemoveMeta(data: CodexData, key: string, scope?: Scope  ): void {
  const store = resolveStore(scope);
  const current = store.load();
  if (!current._meta) {
    store.save({ ...current, entries: data });
    return;
  }
  const meta = { ...current._meta };
  const prefix = key + '.';
  for (const k of Object.keys(meta)) {
    if (k === key || k.startsWith(prefix)) delete meta[k];
  }
  store.save({ ...current, entries: data, _meta: meta });
}

export function loadMetaMerged(): Record<string, number> {
  const project = getProjectStore();
  const global = getGlobalStore();
  if (!project) return global.load()._meta ?? {};
  return { ...(global.load()._meta ?? {}), ...(project.load()._meta ?? {}) };
}

// ── Staleness helpers ─────────────────────────────────────────────────

export const STALE_DAYS = 30;
export const STALE_MS = STALE_DAYS * 86400000;

/**
 * Returns a staleness tag for an entry key based on its _meta timestamp.
 * - Fresh (within STALE_DAYS): returns ''
 * - Stale (older than STALE_DAYS): returns ' [Nd]'
 * - Untracked (no timestamp): returns ' [untracked]'
 */
export function getStalenessTag(key: string, meta: Record<string, number>): string {
  const ts = meta[key];
  if (ts === undefined) return ' [untracked]';
  if (ts < Date.now() - STALE_MS) return ` [${Math.floor((Date.now() - ts) / 86400000)}d]`;
  return '';
}

// ── Migration ──────────────────────────────────────────────────────────

function migrateToUnifiedFile(): { data: UnifiedData; mtime: number } | null {
  const unifiedPath = getUnifiedDataFilePath();

  // If unified file already exists, check if it's the new format
  try {
    const stat = fs.statSync(unifiedPath);
    const raw = fs.readFileSync(unifiedPath, 'utf8');
    const parsed = (raw?.trim() ? JSON.parse(raw) : {}) as Record<string, unknown>;
    if ('entries' in parsed && typeof parsed.entries === 'object') {
      // Already in new format — return parsed data to prime the store cache
      return {
        data: {
          entries: (parsed.entries ?? {}) as CodexData,
          aliases: (parsed.aliases ?? {}) as Record<string, string>,
          confirm: (parsed.confirm ?? {}) as Record<string, true>,
          _meta: (parsed._meta ?? undefined) as Record<string, number> | undefined,
        },
        mtime: stat.mtimeMs,
      };
    }
    // Legacy data.json (entries-only from pre-rename era)
    // Treat entire content as entries
    debug('Migrating legacy data.json (entries-only) to unified format');
    const legacyEntries = parsed as CodexData;
    const unified: UnifiedData = {
      entries: legacyEntries,
      aliases: readJsonFileOr<Record<string, string>>(getAliasFilePath()),
      confirm: readJsonFileOr<Record<string, true>>(getConfirmFilePath()),
    };
    ensureDataDirectoryExists();
    saveJsonSorted(unifiedPath, unified as unknown as Record<string, unknown>);
    backupOldFile(getAliasFilePath());
    backupOldFile(getConfirmFilePath());
    return null;
  } catch (error) {
    // File doesn't exist — fall through to check old separate files
    if (!(error && typeof error === 'object' && 'code' in error && (error as { code: string }).code === 'ENOENT')) {
      // Non-ENOENT error (parse failure, etc.) — fall through to migration
    }
  }

  // Check for old separate files
  const dataDir = getDataDirectory();
  const entriesPath = path.join(dataDir, 'entries.json');
  const oldDataPath = path.join(dataDir, 'data.json'); // pre-rename era
  const aliasPath = getAliasFilePath();
  const confirmPath = getConfirmFilePath();

  const hasEntries = fs.existsSync(entriesPath);
  const hasOldData = fs.existsSync(oldDataPath);
  const hasAliases = fs.existsSync(aliasPath);
  const hasConfirm = fs.existsSync(confirmPath);

  if (!hasEntries && !hasOldData && !hasAliases && !hasConfirm) {
    // Fresh install, nothing to migrate
    return null;
  }

  debug('Migrating separate files to unified data.json');

  let entries: CodexData = {};
  if (hasEntries) {
    entries = readJsonFileOr<CodexData>(entriesPath);
  } else if (hasOldData) {
    entries = readJsonFileOr<CodexData>(oldDataPath);
  }

  const unified: UnifiedData = {
    entries,
    aliases: hasAliases ? readJsonFileOr<Record<string, string>>(aliasPath) : {},
    confirm: hasConfirm ? readJsonFileOr<Record<string, true>>(confirmPath) : {},
  };

  ensureDataDirectoryExists();
  saveJsonSorted(unifiedPath, unified as unknown as Record<string, unknown>);

  // Backup old files
  if (hasEntries) backupOldFile(entriesPath);
  if (hasOldData && !hasEntries) backupOldFile(oldDataPath);
  if (hasAliases) backupOldFile(aliasPath);
  if (hasConfirm) backupOldFile(confirmPath);
  return null;
}

function readJsonFileOr<T>(filePath: string): T {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return (content?.trim() ? JSON.parse(content) : {}) as T;
  } catch {
    return {} as T;
  }
}

function backupOldFile(filePath: string): void {
  const backupPath = filePath + '.backup';
  try {
    if (fs.existsSync(filePath)) {
      fs.renameSync(filePath, backupPath);
      debug(`Backed up ${filePath} -> ${backupPath}`);
    }
  } catch (err) {
    debug(`Failed to backup ${filePath}: ${String(err)}`);
  }
}
