import fs from 'fs';
import path from 'path';
import os from 'os';
import { writeDirectoryStore, readDirectoryStore } from './helpers/readStoreState';

let tmpDir: string;
let storeDir: string;
let dataPath: string;

vi.mock('../utils/paths', () => ({
  getDataDirectory: () => tmpDir,
  getUnifiedDataFilePath: () => path.join(tmpDir, 'data.json'),
  getAliasFilePath: () => path.join(tmpDir, 'aliases.json'),
  getConfirmFilePath: () => path.join(tmpDir, 'confirm.json'),
  getGlobalStoreDirPath: () => path.join(tmpDir, 'store'),
  ensureDataDirectoryExists: () => {
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
  },
  findProjectFile: () => null,
  findProjectStoreDir: () => null,
  clearProjectFileCache: () => {},
}));

import {
  loadEntries, saveEntries, loadAliasMap, saveAliasMap,
  loadConfirmMap, saveConfirmMap, loadEntriesMerged,
  loadAliasMapMerged, loadConfirmMapMerged,
  clearStoreCaches, loadMeta, touchMeta, removeMeta,
  saveEntriesAndTouchMeta, saveEntriesAndRemoveMeta,
  loadMetaMerged, getStalenessTag, STALE_DAYS, STALE_MS,
  saveAll,
} from '../store';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-store-'));
  storeDir = path.join(tmpDir, 'store');
  dataPath = path.join(tmpDir, 'data.json');
  clearStoreCaches();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Helpers ───────────────────────────────────────────────────────────
//
// v1.10.0: `writeData`/`readData` interact with the new file-per-entry store
// directory so tests can continue asserting against a legacy-shaped object
// without caring about the wrapper-file format. Tests that specifically
// exercise the legacy→directory migration path write raw `data.json` directly
// (bypassing these helpers) and assert against the resulting store directory.

function writeData(data: Record<string, unknown>): void {
  writeDirectoryStore(storeDir, data);
}

function readData(): Record<string, unknown> {
  return readDirectoryStore(storeDir) as Record<string, unknown>;
}

// ── ScopedStore: load/save cycle ─────────────────────────────────────

describe('ScopedStore load/save cycle', () => {
  it('returns empty data when file does not exist', () => {
    const entries = loadEntries('global');
    expect(entries).toEqual({});
  });

  it('loads entries from valid data.json', () => {
    writeData({ entries: { foo: 'bar' }, aliases: {}, confirm: {} });
    clearStoreCaches();
    expect(loadEntries('global')).toEqual({ foo: 'bar' });
  });

  it('saves and reloads entries', () => {
    writeData({ entries: {}, aliases: {}, confirm: {} });
    clearStoreCaches();

    saveEntries({ project: { name: 'test' } }, 'global');
    clearStoreCaches();

    expect(loadEntries('global')).toEqual({ project: { name: 'test' } });
  });

  it('preserves aliases and confirm when saving entries', () => {
    writeData({
      entries: { a: '1' },
      aliases: { short: 'long.key' },
      confirm: { 'commands.deploy': true },
    });
    clearStoreCaches();

    saveEntries({ a: '2' }, 'global');
    const raw = readData();
    expect(raw.aliases).toEqual({ short: 'long.key' });
    expect(raw.confirm).toEqual({ 'commands.deploy': true });
  });

  it('sorts keys in saved JSON', () => {
    writeData({ entries: {}, aliases: {}, confirm: {} });
    clearStoreCaches();

    saveAliasMap({ zulu: 'z.key', alpha: 'a.key' }, 'global');
    // v1.10.0: aliases now live in a sidecar `_aliases.json` inside store/
    const raw = fs.readFileSync(path.join(storeDir, '_aliases.json'), 'utf8');
    const alphaIdx = raw.indexOf('"alpha"');
    const zuluIdx = raw.indexOf('"zulu"');
    expect(alphaIdx).toBeLessThan(zuluIdx);
  });
});

// ── saveAll: transactional multi-section writes (#77) ─────────────────

describe('saveAll', () => {
  it('writes every provided section in a single cycle', () => {
    writeData({ entries: {}, aliases: {}, confirm: {} });
    clearStoreCaches();

    saveAll(
      {
        entries: { proj: { name: 'x' } },
        aliases: { short: 'proj.name' },
        confirm: { 'commands.dangerous': true },
      },
      'global',
    );
    clearStoreCaches();

    expect(loadEntries('global')).toEqual({ proj: { name: 'x' } });
    expect(loadAliasMap('global')).toEqual({ short: 'proj.name' });
    expect(loadConfirmMap('global')).toEqual({ 'commands.dangerous': true });
  });

  it('preserves untouched sections when only some are provided', () => {
    writeData({
      entries: { a: '1' },
      aliases: { preserved: 'a' },
      confirm: { 'keep.this': true },
    });
    clearStoreCaches();

    saveAll({ entries: { a: '2' } }, 'global');
    clearStoreCaches();

    expect(loadEntries('global')).toEqual({ a: '2' });
    expect(loadAliasMap('global')).toEqual({ preserved: 'a' });
    expect(loadConfirmMap('global')).toEqual({ 'keep.this': true });
  });

  // #87 — imported entries used to land bare (no meta block), surfacing as
  // [untracked] after every backup restore. saveAll now stamps _meta.
  it('stamps _meta for new leaves arriving from an import (replace)', () => {
    writeData({ entries: {}, aliases: {}, confirm: {} });
    clearStoreCaches();

    const before = Date.now();
    saveAll({ entries: { fresh: { import: 'value' } } }, 'global');
    clearStoreCaches();
    const after = Date.now();

    const meta = loadMeta('global');
    expect(meta['fresh.import']).toBeGreaterThanOrEqual(before);
    expect(meta['fresh.import']).toBeLessThanOrEqual(after);
    expect(getStalenessTag('fresh.import', meta)).toBe('');
  });

  it('preserves _meta for leaves whose value is unchanged (merge import)', () => {
    const oldTs = Date.now() - 10 * 86400000;
    writeData({
      entries: { kept: 'same', changed: 'old' },
      aliases: {},
      confirm: {},
      _meta: { kept: oldTs, changed: oldTs },
    });
    clearStoreCaches();

    saveAll({ entries: { kept: 'same', changed: 'new', added: 'value' } }, 'global');
    clearStoreCaches();

    const meta = loadMeta('global');
    // Unchanged value → old timestamp preserved.
    expect(meta.kept).toBe(oldTs);
    // Changed value → stamped now.
    expect(meta.changed).toBeGreaterThan(oldTs);
    // New leaf → stamped now.
    expect(meta.added).toBeGreaterThan(oldTs);
  });

  it('drops _meta entries for leaves no longer present after a replace', () => {
    const oldTs = Date.now() - 10 * 86400000;
    writeData({
      entries: { retained: '1', removed: '2' },
      aliases: {},
      confirm: {},
      _meta: { retained: oldTs, removed: oldTs },
    });
    clearStoreCaches();

    saveAll({ entries: { retained: '1' } }, 'global');
    clearStoreCaches();

    const meta = loadMeta('global');
    expect(meta.retained).toBe(oldTs);
    expect(meta.removed).toBeUndefined();
  });
});

// ── Mtime caching ────────────────────────────────────────────────────

describe('mtime caching', () => {
  it('returns cached data on repeated loads without file change', () => {
    writeData({ entries: { x: '1' }, aliases: {}, confirm: {} });
    clearStoreCaches();

    // v1.10.0: the directory store assembles a fresh UnifiedData object on
    // each load(), so reference equality no longer holds. What matters is
    // that repeated loads return structurally equal data without re-reading
    // entry files whose mtimes haven't changed.
    const first = loadEntries('global');
    const second = loadEntries('global');
    expect(second).toEqual(first);
  });

  it('invalidates cache when file is externally modified', () => {
    writeData({ entries: { x: '1' }, aliases: {}, confirm: {} });
    clearStoreCaches();

    loadEntries('global');

    // External modification (simulate another process) — atomically rename
    // a fresh wrapper file into place. Atomic rename is what realistic
    // writers use (editors, Reverie itself, etc.) and it bumps both the
    // file mtime and the parent directory mtime, which is what the
    // dir-mtime fast-skip in scanAndSync invalidates on. In-place
    // overwrite would not bump dir mtime and is an unsupported edit
    // surface (see conventions.editSurface).
    const entryPath = path.join(storeDir, 'x.json');
    const tmpPath = entryPath + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify({ value: '2' }));
    fs.renameSync(tmpPath, entryPath);
    const originalMtime = fs.statSync(entryPath).mtimeMs;
    const fd = fs.openSync(entryPath, 'r+');
    fs.futimesSync(fd, new Date(), new Date(originalMtime + 1000));
    fs.closeSync(fd);
    // Bump the directory mtime explicitly so the fast-skip in scanAndSync
    // sees the change even when the rename happens within the same fs
    // mtime quantum as the prior write.
    const dirStat = fs.statSync(storeDir);
    fs.utimesSync(storeDir, new Date(), new Date(dirStat.mtimeMs + 1000));

    const reloaded = loadEntries('global');
    expect(reloaded).toEqual({ x: '2' });
  });

  it('clearStoreCaches forces a fresh read', () => {
    writeData({ entries: { x: '1' }, aliases: {}, confirm: {} });
    clearStoreCaches();

    const first = loadEntries('global');
    expect(first).toEqual({ x: '1' });

    // Overwrite the file without changing mtime would normally cache-hit,
    // but clearStoreCaches should force a fresh read
    writeData({ entries: { x: 'changed' }, aliases: {}, confirm: {} });
    clearStoreCaches();

    const second = loadEntries('global');
    expect(second).toEqual({ x: 'changed' });
  });
});

// ── Error recovery ───────────────────────────────────────────────────

describe('error recovery', () => {
  it('returns empty data for corrupt JSON', () => {
    fs.writeFileSync(dataPath, '{ not valid json !!!');
    clearStoreCaches();

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const entries = loadEntries('global');
    expect(entries).toEqual({});
    consoleSpy.mockRestore();
  });

  it('returns empty data for empty file', () => {
    fs.writeFileSync(dataPath, '');
    clearStoreCaches();

    const entries = loadEntries('global');
    expect(entries).toEqual({});
  });

  it('returns empty data for file with only whitespace', () => {
    fs.writeFileSync(dataPath, '   \n\n  ');
    clearStoreCaches();

    const entries = loadEntries('global');
    expect(entries).toEqual({});
  });

  it('returns empty data for truncated JSON without logging to console', () => {
    fs.writeFileSync(dataPath, '{"entries":');
    clearStoreCaches();

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    loadEntries('global');
    // SyntaxError with "Unexpected end" should not log
    expect(consoleSpy).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('treats file without entries key as legacy and migrates it', () => {
    // A unified file without an "entries" key is treated as legacy
    // (entries-only format from the pre-unified era). The entire content
    // becomes the entries. The v1.10.0 migration then converts the resulting
    // unified file to the per-entry directory layout in a second step. Note
    // that the flatten→unflatten roundtrip prunes empty subtrees like
    // `confirm: {}`, so only string-leaf branches survive — this matches the
    // documented file-per-entry semantics.
    fs.writeFileSync(dataPath, JSON.stringify({ aliases: { x: 'y' }, confirm: {} }));
    clearStoreCaches();

    const entries = loadEntries('global');
    expect(entries).toEqual({ aliases: { x: 'y' } });
  });
});

// ── Alias/confirm sections ───────────────────────────────────────────

describe('alias and confirm sections', () => {
  it('loads and saves alias maps', () => {
    writeData({ entries: {}, aliases: { a: 'b' }, confirm: {} });
    clearStoreCaches();

    expect(loadAliasMap('global')).toEqual({ a: 'b' });

    saveAliasMap({ c: 'd' }, 'global');
    clearStoreCaches();

    expect(loadAliasMap('global')).toEqual({ c: 'd' });
  });

  it('loads and saves confirm maps', () => {
    writeData({ entries: {}, aliases: {}, confirm: { 'x.y': true } });
    clearStoreCaches();

    expect(loadConfirmMap('global')).toEqual({ 'x.y': true });

    saveConfirmMap({ 'a.b': true }, 'global');
    clearStoreCaches();

    expect(loadConfirmMap('global')).toEqual({ 'a.b': true });
  });
});

// ── Meta operations ──────────────────────────────────────────────────

describe('meta operations', () => {
  it('saveEntriesAndTouchMeta writes both in one save', () => {
    writeData({ entries: {}, aliases: {}, confirm: {} });
    clearStoreCaches();

    saveEntriesAndTouchMeta({ foo: 'bar' }, 'foo', 'global');

    const raw = readData();
    expect(raw.entries).toEqual({ foo: 'bar' });
    expect((raw._meta as Record<string, number>).foo).toBeGreaterThan(0);
  });

  it('saveEntriesAndRemoveMeta removes key and children', () => {
    // v1.10.0: meta lives inside entry wrapper files, so there's no such
    // thing as "meta for a key that has no entry". Every meta key must have
    // a corresponding leaf entry. Added `other` as a real leaf so its meta
    // has a home.
    writeData({
      entries: { srv: { ip: '1' }, other: 'val' },
      aliases: {},
      confirm: {},
      _meta: { 'srv.ip': 200, 'other': 300 },
    });
    clearStoreCaches();

    // Keep `other` in the new entries state so its meta is preserved
    saveEntriesAndRemoveMeta({ other: 'val' }, 'srv', 'global');

    const meta = loadMeta('global');
    expect(meta['srv']).toBeUndefined();
    expect(meta['srv.ip']).toBeUndefined();
    expect(meta['other']).toBe(300);
  });

  it('saveEntriesAndRemoveMeta is safe when no _meta exists', () => {
    writeData({ entries: { a: 'b' }, aliases: {}, confirm: {} });
    clearStoreCaches();

    saveEntriesAndRemoveMeta({ c: 'd' }, 'a', 'global');

    const raw = readData();
    expect(raw.entries).toEqual({ c: 'd' });
    expect(raw._meta).toBeUndefined();
  });

  it('touchMeta updates timestamp for existing key', () => {
    const old = Date.now() - 100000;
    writeData({
      entries: { foo: 'bar' },
      aliases: {},
      confirm: {},
      _meta: { foo: old },
    });
    clearStoreCaches();

    touchMeta('foo', 'global');

    const meta = loadMeta('global');
    expect(meta.foo).toBeGreaterThan(old);
  });
});

// ── Merged accessors ─────────────────────────────────────────────────

describe('merged accessors (global-only, no project)', () => {
  it('loadEntriesMerged returns global entries when no project', () => {
    writeData({ entries: { g: 'global' }, aliases: {}, confirm: {} });
    clearStoreCaches();

    expect(loadEntriesMerged()).toEqual({ g: 'global' });
  });

  it('loadAliasMapMerged returns global aliases when no project', () => {
    writeData({ entries: {}, aliases: { a: 'b' }, confirm: {} });
    clearStoreCaches();

    expect(loadAliasMapMerged()).toEqual({ a: 'b' });
  });

  it('loadConfirmMapMerged returns global confirm when no project', () => {
    writeData({ entries: {}, aliases: {}, confirm: { x: true } });
    clearStoreCaches();

    expect(loadConfirmMapMerged()).toEqual({ x: true });
  });

  it('loadMetaMerged returns global meta when no project', () => {
    // v1.10.0: meta lives inside entry files, so `k` needs a real entry.
    writeData({ entries: { k: 'v' }, aliases: {}, confirm: {}, _meta: { k: 123 } });
    clearStoreCaches();

    expect(loadMetaMerged()).toEqual({ k: 123 });
  });
});

// ── getStalenessTag ──────────────────────────────────────────────────

describe('getStalenessTag', () => {
  it('returns empty for fresh entry', () => {
    expect(getStalenessTag('k', { k: Date.now() })).toBe('');
  });

  it('returns day count for stale entry', () => {
    const old = Date.now() - 60 * 86400000;
    const tag = getStalenessTag('k', { k: old });
    expect(tag).toMatch(/^\s\[60d\]$/);
  });

  it('returns [untracked] for missing entry', () => {
    expect(getStalenessTag('k', {})).toBe(' [untracked]');
  });

  it('reports correct day count at various ages', () => {
    for (const days of [31, 45, 90, 365]) {
      const ts = Date.now() - days * 86400000;
      const tag = getStalenessTag('k', { k: ts });
      expect(tag).toBe(` [${days}d]`);
    }
  });
});

// ── Migration ────────────────────────────────────────────────────────

describe('migration from legacy formats', () => {
  it('migrates separate entries.json + aliases.json + confirm.json', () => {
    // Create legacy files
    fs.writeFileSync(path.join(tmpDir, 'entries.json'), JSON.stringify({ project: { name: 'test' } }));
    fs.writeFileSync(path.join(tmpDir, 'aliases.json'), JSON.stringify({ a: 'b.c' }));
    fs.writeFileSync(path.join(tmpDir, 'confirm.json'), JSON.stringify({ cmd: true }));
    clearStoreCaches();

    // Access triggers migration
    const entries = loadEntries('global');
    expect(entries).toEqual({ project: { name: 'test' } });

    // Verify unified file was created
    const raw = readData();
    expect(raw.entries).toEqual({ project: { name: 'test' } });
    expect(raw.aliases).toEqual({ a: 'b.c' });
    expect(raw.confirm).toEqual({ cmd: true });

    // Old files should be renamed to .backup
    expect(fs.existsSync(path.join(tmpDir, 'entries.json.backup'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'aliases.json.backup'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'confirm.json.backup'))).toBe(true);
  });

  it('migrates legacy data.json (entries-only, no "entries" wrapper)', () => {
    // Legacy data.json had flat entries without the { entries: ... } wrapper
    fs.writeFileSync(dataPath, JSON.stringify({ project: { name: 'legacy' } }));
    clearStoreCaches();

    const entries = loadEntries('global');
    expect(entries).toEqual({ project: { name: 'legacy' } });

    // After migration the file should have the new format
    clearStoreCaches();
    const raw = readData();
    expect(raw.entries).toBeDefined();
  });

  it('skips migration when unified file already exists in new format', () => {
    writeData({ entries: { x: '1' }, aliases: {}, confirm: {} });
    clearStoreCaches();

    const entries = loadEntries('global');
    expect(entries).toEqual({ x: '1' });
    // No backup files should exist
    expect(fs.existsSync(path.join(tmpDir, 'data.json.backup'))).toBe(false);
  });

  it('handles fresh install with no files at all', () => {
    clearStoreCaches();
    const entries = loadEntries('global');
    expect(entries).toEqual({});
  });

  it('migrates old data.json when entries.json does not exist', () => {
    const oldDataPath = path.join(tmpDir, 'data.json');
    fs.writeFileSync(oldDataPath, JSON.stringify({ old: 'data' }));
    clearStoreCaches();

    loadEntries('global');

    // The file should now be in unified format
    const raw = readData();
    expect(raw.entries).toBeDefined();
    // And the old file is backed up (it is data.json itself, so check format)
  });
});

// ── Constants ────────────────────────────────────────────────────────

describe('constants', () => {
  it('STALE_DAYS is 30', () => {
    expect(STALE_DAYS).toBe(30);
  });

  it('STALE_MS equals STALE_DAYS * 86400000', () => {
    expect(STALE_MS).toBe(STALE_DAYS * 86400000);
  });
});
