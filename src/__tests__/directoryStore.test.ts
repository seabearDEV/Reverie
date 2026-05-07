import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  createDirectoryStore,
  migrateFileToDirectory,
  parseEntryWrapper,
  serializeEntryWrapper,
  entryFilePath,
  getStoreLockKey,
  type EntryWrapper,
} from '../utils/directoryStore';
import type { UnifiedData } from '../store';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-dirstore-'));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// ── Helpers ────────────────────────────────────────────────────────────

function makeStore(dir: string) {
  return createDirectoryStore(
    () => dir,
    () => {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
  );
}

function readJson<T = unknown>(p: string): T {
  return JSON.parse(fs.readFileSync(p, 'utf8')) as T;
}

// ── createDirectoryStore: load ─────────────────────────────────────────

describe('createDirectoryStore.load', () => {
  it('returns empty UnifiedData when directory does not exist', () => {
    const store = makeStore(path.join(tmpRoot, 'nope'));
    const data = store.load();
    expect(data).toEqual({ entries: {}, aliases: {}, confirm: {} });
  });

  it('returns empty UnifiedData for an empty directory', () => {
    const dir = path.join(tmpRoot, 'empty');
    fs.mkdirSync(dir);
    const store = makeStore(dir);
    const data = store.load();
    expect(data).toEqual({ entries: {}, aliases: {}, confirm: {} });
  });

  it('reads entry files and reconstructs nested entries', () => {
    const dir = path.join(tmpRoot, 'store');
    fs.mkdirSync(dir);
    fs.writeFileSync(
      path.join(dir, 'arch.storage.json'),
      JSON.stringify({ value: 'unified data.json', meta: { updated: 1000, created: 1000 } })
    );
    fs.writeFileSync(
      path.join(dir, 'arch.scope.json'),
      JSON.stringify({ value: 'three scopes', meta: { updated: 2000, created: 2000 } })
    );
    fs.writeFileSync(
      path.join(dir, 'commands.test.json'),
      JSON.stringify({ value: 'npm test' })
    );

    const store = makeStore(dir);
    const data = store.load();

    expect(data.entries).toEqual({
      arch: { storage: 'unified data.json', scope: 'three scopes' },
      commands: { test: 'npm test' },
    });
    expect(data._meta).toEqual({
      'arch.storage': 1000,
      'arch.scope': 2000,
      // commands.test is untracked — not in _meta
    });
  });

  it('reads sidecars for aliases and confirm', () => {
    const dir = path.join(tmpRoot, 'store');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, '_aliases.json'), JSON.stringify({ rel: 'commands.release' }));
    fs.writeFileSync(path.join(dir, '_confirm.json'), JSON.stringify({ 'commands.release': true }));

    const store = makeStore(dir);
    const data = store.load();

    expect(data.aliases).toEqual({ rel: 'commands.release' });
    expect(data.confirm).toEqual({ 'commands.release': true });
  });

  it('skips unparseable entry files without crashing', () => {
    const dir = path.join(tmpRoot, 'store');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'good.json'), JSON.stringify({ value: 'ok' }));
    fs.writeFileSync(path.join(dir, 'bad.json'), 'not json');
    fs.writeFileSync(path.join(dir, 'also.bad.json'), JSON.stringify({ not: 'a wrapper' }));

    const store = makeStore(dir);
    const data = store.load();

    expect(data.entries).toEqual({ good: 'ok' });
  });

  it('ignores files without .json extension and underscore-prefixed files', () => {
    const dir = path.join(tmpRoot, 'store');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'entry.json'), JSON.stringify({ value: 'v' }));
    fs.writeFileSync(path.join(dir, 'README.md'), '# notes');
    fs.writeFileSync(path.join(dir, '_aliases.json'), JSON.stringify({ a: 'b' }));

    const store = makeStore(dir);
    const data = store.load();

    expect(Object.keys(data.entries)).toEqual(['entry']);
  });
});

// ── createDirectoryStore: save ─────────────────────────────────────────

describe('createDirectoryStore.save', () => {
  it('writes per-entry files and sidecars on first save', () => {
    const dir = path.join(tmpRoot, 'store');
    const store = makeStore(dir);
    const data: UnifiedData = {
      entries: { arch: { storage: 'one', scope: 'two' } },
      aliases: { s: 'arch.storage' },
      confirm: { 'arch.storage': true },
      _meta: { 'arch.storage': 1000, 'arch.scope': 2000 },
    };
    store.save(data);

    expect(fs.existsSync(path.join(dir, 'arch.storage.json'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'arch.scope.json'))).toBe(true);
    expect(fs.existsSync(path.join(dir, '_aliases.json'))).toBe(true);
    expect(fs.existsSync(path.join(dir, '_confirm.json'))).toBe(true);

    const storageWrapper = readJson<EntryWrapper>(path.join(dir, 'arch.storage.json'));
    expect(storageWrapper.value).toBe('one');
    expect(storageWrapper.meta).toEqual({ created: 1000, updated: 1000 });
  });

  it('round-trips cleanly: save then load returns equivalent data', () => {
    const dir = path.join(tmpRoot, 'store');
    const store = makeStore(dir);
    const data: UnifiedData = {
      entries: { foo: { bar: 'baz', qux: 'quux' }, top: 'level' },
      aliases: { b: 'foo.bar' },
      confirm: {},
      _meta: { 'foo.bar': 500, 'foo.qux': 600, top: 700 },
    };
    store.save(data);

    // Fresh store (no shared cache) to verify disk state is the source of truth
    const fresh = makeStore(dir);
    const loaded = fresh.load();

    expect(loaded.entries).toEqual(data.entries);
    expect(loaded.aliases).toEqual(data.aliases);
    expect(loaded.confirm).toEqual(data.confirm);
    expect(loaded._meta).toEqual(data._meta);
  });

  it('preserves created on subsequent saves, bumps updated', () => {
    const dir = path.join(tmpRoot, 'store');
    const store = makeStore(dir);

    store.save({
      entries: { foo: 'v1' },
      aliases: {},
      confirm: {},
      _meta: { foo: 100 },
    });

    store.save({
      entries: { foo: 'v2' },
      aliases: {},
      confirm: {},
      _meta: { foo: 200 },
    });

    const wrapper = readJson<EntryWrapper>(path.join(dir, 'foo.json'));
    expect(wrapper.value).toBe('v2');
    expect(wrapper.meta).toEqual({ created: 100, updated: 200 });
  });

  it('dirty tracking: unchanged files are not rewritten', () => {
    const dir = path.join(tmpRoot, 'store');
    const store = makeStore(dir);

    store.save({
      entries: { a: '1', b: '2', c: '3' },
      aliases: {},
      confirm: {},
      _meta: { a: 100, b: 200, c: 300 },
    });

    const beforeMtimes = {
      a: fs.statSync(path.join(dir, 'a.json')).mtimeMs,
      b: fs.statSync(path.join(dir, 'b.json')).mtimeMs,
      c: fs.statSync(path.join(dir, 'c.json')).mtimeMs,
    };

    // Wait long enough for any in-place write to bump mtime
    const target = Date.now() + 20;
    while (Date.now() < target) { /* spin */ }

    // Save with only `b` changed (new value and new timestamp)
    store.save({
      entries: { a: '1', b: 'changed', c: '3' },
      aliases: {},
      confirm: {},
      _meta: { a: 100, b: 999, c: 300 },
    });

    const afterMtimes = {
      a: fs.statSync(path.join(dir, 'a.json')).mtimeMs,
      b: fs.statSync(path.join(dir, 'b.json')).mtimeMs,
      c: fs.statSync(path.join(dir, 'c.json')).mtimeMs,
    };

    expect(afterMtimes.a).toBe(beforeMtimes.a);  // unchanged
    expect(afterMtimes.c).toBe(beforeMtimes.c);  // unchanged
    expect(afterMtimes.b).toBeGreaterThan(beforeMtimes.b);  // rewritten
  });

  it('removes entry files for keys that disappear from the new state', () => {
    const dir = path.join(tmpRoot, 'store');
    const store = makeStore(dir);

    store.save({
      entries: { a: '1', b: '2' },
      aliases: {},
      confirm: {},
      _meta: { a: 100, b: 200 },
    });

    store.save({
      entries: { a: '1' },  // b removed
      aliases: {},
      confirm: {},
      _meta: { a: 100 },
    });

    expect(fs.existsSync(path.join(dir, 'a.json'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'b.json'))).toBe(false);
  });

  it('empty entries {} removes all entry files but keeps sidecars', () => {
    const dir = path.join(tmpRoot, 'store');
    const store = makeStore(dir);

    store.save({
      entries: { a: '1', b: '2' },
      aliases: { x: 'a' },
      confirm: {},
      _meta: { a: 100, b: 200 },
    });

    store.save({
      entries: {},
      aliases: { x: 'a' },
      confirm: {},
    });

    expect(fs.existsSync(path.join(dir, 'a.json'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'b.json'))).toBe(false);
    expect(fs.existsSync(path.join(dir, '_aliases.json'))).toBe(true);
  });

  it('untracked entries (no _meta timestamp) are written without a meta block', () => {
    const dir = path.join(tmpRoot, 'store');
    const store = makeStore(dir);
    store.save({
      entries: { untracked: 'value' },
      aliases: {},
      confirm: {},
    });

    const wrapper = readJson<EntryWrapper>(path.join(dir, 'untracked.json'));
    expect(wrapper.value).toBe('value');
    expect(wrapper.meta).toBeUndefined();
  });
});

// ── migrateFileToDirectory ─────────────────────────────────────────────

describe('migrateFileToDirectory', () => {
  it('is a no-op when neither old file nor new dir exists', () => {
    const result = migrateFileToDirectory(
      path.join(tmpRoot, 'nothing.json'),
      path.join(tmpRoot, 'nothing')
    );
    expect(result.status).toBe('no-op');
    expect(fs.existsSync(path.join(tmpRoot, 'nothing'))).toBe(false);
  });

  it('returns already-present when new directory exists', () => {
    const oldFile = path.join(tmpRoot, 'data.json');
    const newDir = path.join(tmpRoot, 'store');
    fs.mkdirSync(newDir);
    // No old file, but new dir exists → already-present, no-op
    const result = migrateFileToDirectory(oldFile, newDir);
    expect(result.status).toBe('already-present');
  });

  it('cleans up lingering old file when new directory already exists', () => {
    const oldFile = path.join(tmpRoot, 'data.json');
    const newDir = path.join(tmpRoot, 'store');
    fs.mkdirSync(newDir);
    fs.writeFileSync(oldFile, '{"entries":{"stale":"value"}}');

    const result = migrateFileToDirectory(oldFile, newDir);

    expect(result.status).toBe('already-present');
    expect(fs.existsSync(oldFile)).toBe(false);
    expect(fs.existsSync(oldFile + '.backup')).toBe(true);
  });

  it('migrates a unified file to per-entry wrappers', () => {
    const oldFile = path.join(tmpRoot, '.codexcli.json');
    const newDir = path.join(tmpRoot, '.codexcli');
    fs.writeFileSync(oldFile, JSON.stringify({
      entries: {
        arch: { storage: 'unified', scope: 'three' },
        commands: { test: 'npm test' },
      },
      aliases: { t: 'commands.test' },
      confirm: { 'commands.test': true },
      _meta: { 'arch.storage': 1000, 'arch.scope': 2000, 'commands.test': 3000 },
    }));

    const result = migrateFileToDirectory(oldFile, newDir);

    expect(result.status).toBe('migrated');
    expect(result.entryCount).toBe(3);
    expect(result.backupPath).toBe(oldFile + '.backup');

    // Old file gone, backup exists
    expect(fs.existsSync(oldFile)).toBe(false);
    expect(fs.existsSync(oldFile + '.backup')).toBe(true);

    // Entry files written with wrappers
    const storageWrapper = readJson<EntryWrapper>(path.join(newDir, 'arch.storage.json'));
    expect(storageWrapper.value).toBe('unified');
    expect(storageWrapper.meta).toEqual({ created: 1000, updated: 1000 });

    const testWrapper = readJson<EntryWrapper>(path.join(newDir, 'commands.test.json'));
    expect(testWrapper.value).toBe('npm test');
    expect(testWrapper.meta).toEqual({ created: 3000, updated: 3000 });

    // Sidecars written
    expect(readJson(path.join(newDir, '_aliases.json'))).toEqual({ t: 'commands.test' });
    expect(readJson(path.join(newDir, '_confirm.json'))).toEqual({ 'commands.test': true });
  });

  it('preserves untracked entries (missing from _meta) as bare wrappers', () => {
    const oldFile = path.join(tmpRoot, '.codexcli.json');
    const newDir = path.join(tmpRoot, '.codexcli');
    fs.writeFileSync(oldFile, JSON.stringify({
      entries: { tracked: 'a', untracked: 'b' },
      aliases: {},
      confirm: {},
      _meta: { tracked: 1000 },  // only `tracked` has a timestamp
    }));

    migrateFileToDirectory(oldFile, newDir);

    const trackedWrapper = readJson<EntryWrapper>(path.join(newDir, 'tracked.json'));
    expect(trackedWrapper.meta).toEqual({ created: 1000, updated: 1000 });

    const untrackedWrapper = readJson<EntryWrapper>(path.join(newDir, 'untracked.json'));
    expect(untrackedWrapper.value).toBe('b');
    expect(untrackedWrapper.meta).toBeUndefined();
  });

  it('migrates a file with empty entries/aliases/confirm', () => {
    const oldFile = path.join(tmpRoot, '.codexcli.json');
    const newDir = path.join(tmpRoot, '.codexcli');
    fs.writeFileSync(oldFile, JSON.stringify({ entries: {}, aliases: {}, confirm: {} }));

    const result = migrateFileToDirectory(oldFile, newDir);

    expect(result.status).toBe('migrated');
    expect(result.entryCount).toBe(0);
    expect(fs.existsSync(path.join(newDir, '_aliases.json'))).toBe(true);
    expect(fs.existsSync(path.join(newDir, '_confirm.json'))).toBe(true);
  });

  it('throws a helpful error on corrupt JSON in the old file', () => {
    const oldFile = path.join(tmpRoot, '.codexcli.json');
    const newDir = path.join(tmpRoot, '.codexcli');
    fs.writeFileSync(oldFile, '{not json');

    expect(() => migrateFileToDirectory(oldFile, newDir)).toThrow(/Failed to parse/);
    // New dir should not exist after a failed migration
    expect(fs.existsSync(newDir)).toBe(false);
  });

  it('overwrites a pre-existing .backup if another migration was interrupted', () => {
    const oldFile = path.join(tmpRoot, '.codexcli.json');
    const newDir = path.join(tmpRoot, '.codexcli');
    fs.writeFileSync(oldFile, JSON.stringify({ entries: { a: '1' }, aliases: {}, confirm: {} }));
    fs.writeFileSync(oldFile + '.backup', 'stale backup from aborted migration');

    const result = migrateFileToDirectory(oldFile, newDir);

    expect(result.status).toBe('migrated');
    // The backup should now reflect the freshly-migrated old file, not the stale text
    const backupContent = fs.readFileSync(oldFile + '.backup', 'utf8');
    expect(backupContent).toContain('"entries"');
  });
});

// ── Helper functions ───────────────────────────────────────────────────

describe('parseEntryWrapper', () => {
  it('parses a minimal wrapper', () => {
    expect(parseEntryWrapper('{"value":"hello"}')).toEqual({ value: 'hello' });
  });

  it('parses a wrapper with meta', () => {
    const raw = '{"value":"hi","meta":{"created":1,"updated":2}}';
    expect(parseEntryWrapper(raw)).toEqual({
      value: 'hi',
      meta: { created: 1, updated: 2 },
    });
  });

  it('returns null for missing value field', () => {
    expect(parseEntryWrapper('{"other":"thing"}')).toBeNull();
  });

  it('returns null for invalid JSON', () => {
    expect(parseEntryWrapper('{not json')).toBeNull();
  });

  it('parses a nested-object value', () => {
    const raw = '{"value":{"nested":"string"}}';
    expect(parseEntryWrapper(raw)).toEqual({ value: { nested: 'string' } });
  });
});

describe('serializeEntryWrapper', () => {
  it('produces pretty-printed JSON', () => {
    const out = serializeEntryWrapper({ value: 'hi', meta: { updated: 100 } });
    expect(out).toContain('\n');  // pretty-printed
    expect(JSON.parse(out)).toEqual({ value: 'hi', meta: { updated: 100 } });
  });

  it('omits meta when not provided', () => {
    const out = serializeEntryWrapper({ value: 'hi' });
    expect(JSON.parse(out)).toEqual({ value: 'hi' });
  });
});

describe('entryFilePath', () => {
  it('appends .json to the key within the directory', () => {
    expect(entryFilePath('/store', 'arch.storage')).toBe(path.join('/store', 'arch.storage.json'));
  });
});

describe('getStoreLockKey', () => {
  it('returns the directory path unchanged (withFileLock appends .lock)', () => {
    expect(getStoreLockKey('/a/b/.codexcli')).toBe('/a/b/.codexcli');
  });
});

// ── Epoch seqlock (torn-read protection) ──────────────────────────────

function readEpochFile(dir: string): number {
  const raw = fs.readFileSync(path.join(dir, '_epoch.json'), 'utf8');
  return (JSON.parse(raw) as { epoch: number }).epoch;
}

describe('epoch seqlock', () => {
  it('first save bumps epoch from 0 to 2 (stable even)', () => {
    const dir = path.join(tmpRoot, 'store');
    const store = makeStore(dir);

    store.save({ entries: { a: '1' }, aliases: {}, confirm: {} });

    expect(readEpochFile(dir)).toBe(2);
  });

  it('subsequent saves advance epoch by 2 each time', () => {
    const dir = path.join(tmpRoot, 'store');
    const store = makeStore(dir);

    store.save({ entries: { a: '1' }, aliases: {}, confirm: {} });
    expect(readEpochFile(dir)).toBe(2);

    store.save({ entries: { a: '2' }, aliases: {}, confirm: {} });
    expect(readEpochFile(dir)).toBe(4);

    store.save({ entries: { a: '3' }, aliases: {}, confirm: {} });
    expect(readEpochFile(dir)).toBe(6);
  });

  it('load() tolerates a missing epoch file (legacy dirs without _epoch.json)', () => {
    // Simulate a store directory that was created before the epoch file existed.
    const dir = path.join(tmpRoot, 'store');
    fs.mkdirSync(dir);
    fs.writeFileSync(
      path.join(dir, 'only.json'),
      JSON.stringify({ value: 'preserved' })
    );

    const store = makeStore(dir);
    const data = store.load();
    expect(data.entries).toEqual({ only: 'preserved' });
  });

  it('load() recovers from a bogus/garbled epoch file', () => {
    const dir = path.join(tmpRoot, 'store');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, '_epoch.json'), 'not json');
    fs.writeFileSync(
      path.join(dir, 'x.json'),
      JSON.stringify({ value: 'still readable' })
    );

    const store = makeStore(dir);
    const data = store.load();
    expect(data.entries).toEqual({ x: 'still readable' });
  });

  it('load() returns a consistent snapshot when epoch is even and unchanged across scan', () => {
    // This is the happy path: no concurrent writer, load() completes on attempt 0.
    const dir = path.join(tmpRoot, 'store');
    const store = makeStore(dir);
    store.save({
      entries: { a: '1', b: '2' },
      aliases: { x: 'a' },
      confirm: { a: true },
      _meta: { a: 100, b: 200 },
    });

    const fresh = makeStore(dir);
    const loaded = fresh.load();

    expect(loaded.entries).toEqual({ a: '1', b: '2' });
    expect(loaded.aliases).toEqual({ x: 'a' });
    expect(loaded.confirm).toEqual({ a: true });
  });

  it('load() detects an odd (in-progress) epoch and still returns best-effort data', () => {
    // Simulate a crashed writer that left an odd epoch on disk. load() should
    // exhaust retries, log via debug, and return whatever it can scan —
    // rather than hanging or throwing.
    const dir = path.join(tmpRoot, 'store');
    const store = makeStore(dir);
    store.save({ entries: { a: '1' }, aliases: {}, confirm: {} });

    // Stamp an odd epoch to simulate a crashed mid-commit writer.
    fs.writeFileSync(path.join(dir, '_epoch.json'), JSON.stringify({ epoch: 7 }) + '\n');

    const fresh = makeStore(dir);
    const loaded = fresh.load();

    // We should still get the entry data that was durably written.
    expect(loaded.entries).toEqual({ a: '1' });
  });
});

// ── Migration lock (concurrent first-run) ──────────────────────────────

describe('migrateFileToDirectory concurrency', () => {
  it('is safe to call twice in a row (second call is already-present)', () => {
    // Sequential calls exercise the same idempotency guarantee the lock
    // provides for concurrent callers: the winner migrates, the loser
    // finds the directory already populated.
    const oldFile = path.join(tmpRoot, '.codexcli.json');
    const newDir = path.join(tmpRoot, '.codexcli');
    fs.writeFileSync(oldFile, JSON.stringify({
      entries: { a: '1', b: '2' },
      aliases: {},
      confirm: {},
      _meta: { a: 100, b: 200 },
    }));

    const first = migrateFileToDirectory(oldFile, newDir);
    expect(first.status).toBe('migrated');
    expect(first.entryCount).toBe(2);

    // The "lingering old file" cleanup branch runs if the old file reappears,
    // so put it back to verify the second call takes the already-present path.
    fs.writeFileSync(oldFile, JSON.stringify({ entries: { a: '1' } }));
    const second = migrateFileToDirectory(oldFile, newDir);
    expect(second.status).toBe('already-present');
    // Old file was renamed to .backup as cleanup.
    expect(fs.existsSync(oldFile)).toBe(false);
  });

  it('seeds _epoch.json at 0 during migration', () => {
    const oldFile = path.join(tmpRoot, '.codexcli.json');
    const newDir = path.join(tmpRoot, '.codexcli');
    fs.writeFileSync(oldFile, JSON.stringify({
      entries: { a: '1' },
      aliases: {},
      confirm: {},
    }));

    migrateFileToDirectory(oldFile, newDir);

    expect(fs.existsSync(path.join(newDir, '_epoch.json'))).toBe(true);
    expect(readEpochFile(newDir)).toBe(0);
  });

  it('first save after migration bumps epoch to 2', () => {
    const oldFile = path.join(tmpRoot, '.codexcli.json');
    const newDir = path.join(tmpRoot, '.codexcli');
    fs.writeFileSync(oldFile, JSON.stringify({
      entries: { a: '1' },
      aliases: {},
      confirm: {},
    }));

    migrateFileToDirectory(oldFile, newDir);
    const store = makeStore(newDir);
    store.save({
      entries: { a: '1', b: 'new' },
      aliases: {},
      confirm: {},
    });

    expect(readEpochFile(newDir)).toBe(2);
  });

  it('removes the tmp dir on a throwing migration, leaving no partial state', () => {
    const oldFile = path.join(tmpRoot, '.codexcli.json');
    const newDir = path.join(tmpRoot, '.codexcli');
    // Malformed JSON causes migrateFileToDirectory to throw before the tmp→final rename.
    fs.writeFileSync(oldFile, '{corrupt');

    expect(() => migrateFileToDirectory(oldFile, newDir)).toThrow();
    expect(fs.existsSync(newDir)).toBe(false);
    expect(fs.existsSync(newDir + '.tmp')).toBe(false);
  });
});

// ── Sidecar mtime tracking ─────────────────────────────────────────────

describe('sidecar mtime cache', () => {
  it('does not re-read _aliases.json when its mtime is unchanged', () => {
    const dir = path.join(tmpRoot, 'store');
    const store = makeStore(dir);
    store.save({
      entries: { a: '1' },
      aliases: { x: 'a' },
      confirm: {},
    });

    // Prime the cache.
    store.load();

    // Spy on fs.readFileSync after priming, counting reads of the aliases sidecar.
    const readFileSync = fs.readFileSync;
    let aliasReads = 0;
    const aliasPath = path.join(dir, '_aliases.json');
    // @ts-expect-error -- intentional test-only monkey patch
    fs.readFileSync = function spyRead(p: fs.PathOrFileDescriptor, ...rest: unknown[]) {
      if (typeof p === 'string' && path.resolve(p) === path.resolve(aliasPath)) {
        aliasReads++;
      }
      // @ts-expect-error -- spread through to the real impl
      return readFileSync.call(this, p, ...rest);
    };
    try {
      // Several loads with no disk changes → sidecar should not be re-read.
      store.load();
      store.load();
      store.load();
    } finally {
      fs.readFileSync = readFileSync;
    }

    expect(aliasReads).toBe(0);
  });

  it('re-reads _aliases.json when its mtime changes (external write)', () => {
    const dir = path.join(tmpRoot, 'store');
    const store = makeStore(dir);
    store.save({
      entries: { a: '1' },
      aliases: { x: 'a' },
      confirm: {},
    });
    store.load();  // prime

    // Simulate an external atomic rewrite. Atomic rename (the realistic
    // pattern used by editors, Reverie's own writes, etc.) bumps both
    // file and parent-directory mtime, which is what scanAndSync's
    // dir-mtime fast-skip invalidates on.
    const aliasesPath = path.join(dir, '_aliases.json');
    const previousStat = fs.statSync(aliasesPath);
    const tmpPath = aliasesPath + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify({ y: 'a' }, null, 2));
    fs.renameSync(tmpPath, aliasesPath);
    const newerMtime = new Date(previousStat.mtimeMs + 1000);
    fs.utimesSync(aliasesPath, newerMtime, newerMtime);
    // Bump dir mtime explicitly so the dir-mtime fast-skip detects the
    // change even within a single fs mtime quantum.
    const dirStat = fs.statSync(dir);
    fs.utimesSync(dir, new Date(), new Date(dirStat.mtimeMs + 1000));

    const reloaded = store.load();
    expect(reloaded.aliases).toEqual({ y: 'a' });
  });

  it('load() returns defensive copies of sidecars so caller-mutation does not pollute the cache', () => {
    // Regression: setAlias and friends call loadAliasMap, mutate the returned
    // object in place, then call saveAliasMap with the mutated reference. If
    // load() handed out the cached object by reference, the dirty-check in
    // save() would see "cache === caller's data" via shallowEquals and skip
    // the write — silently dropping the alias.
    const dir = path.join(tmpRoot, 'store');
    const store = makeStore(dir);
    store.save({
      entries: { a: '1' },
      aliases: { existing: 'a' },
      confirm: {},
    });

    const first = store.load();
    // Simulate a caller mutating loadAliasMap's return value.
    (first.aliases as Record<string, string>)['added'] = 'a';

    // Now save the mutated data. If the cache was shared by reference, the
    // dirty-check would conclude "no change" and skip writing the new alias.
    store.save(first);

    // Fresh store reading straight from disk — the added alias must be there.
    const fresh = makeStore(dir);
    const reloaded = fresh.load();
    expect(reloaded.aliases).toEqual({ existing: 'a', added: 'a' });
  });

  it('picks up a sidecar that appears after initial load (missing → present)', () => {
    const dir = path.join(tmpRoot, 'store');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'x.json'), JSON.stringify({ value: 'v' }));

    const store = makeStore(dir);
    let data = store.load();
    expect(data.aliases).toEqual({});

    // Write a sidecar that wasn't there on the first scan.
    fs.writeFileSync(path.join(dir, '_aliases.json'), JSON.stringify({ z: 'x' }));

    data = store.load();
    expect(data.aliases).toEqual({ z: 'x' });
  });
});

// ── Hand-edit warning README ───────────────────────────────────────────

describe('_README.md hand-edit nudge', () => {
  it('save() writes _README.md on first invocation', () => {
    const dir = path.join(tmpRoot, 'store');
    const store = makeStore(dir);

    expect(fs.existsSync(path.join(dir, '_README.md'))).toBe(false);

    store.save({ entries: { a: '1' }, aliases: {}, confirm: {} });

    const readmePath = path.join(dir, '_README.md');
    expect(fs.existsSync(readmePath)).toBe(true);
    const contents = fs.readFileSync(readmePath, 'utf8');
    expect(contents).toContain('do not hand-edit');
  });

  it('does not overwrite a user-customized _README.md', () => {
    const dir = path.join(tmpRoot, 'store');
    fs.mkdirSync(dir);
    const custom = '# My custom store README\n';
    fs.writeFileSync(path.join(dir, '_README.md'), custom);

    const store = makeStore(dir);
    store.save({ entries: { a: '1' }, aliases: {}, confirm: {} });

    const contents = fs.readFileSync(path.join(dir, '_README.md'), 'utf8');
    expect(contents).toBe(custom);
  });

  it('_README.md is not picked up as an entry file', () => {
    const dir = path.join(tmpRoot, 'store');
    const store = makeStore(dir);
    store.save({ entries: { a: '1' }, aliases: {}, confirm: {} });

    const data = store.load();
    // Only the real entry "a" is visible.
    expect(data.entries).toEqual({ a: '1' });
  });

  it('migration seeds _README.md alongside the migrated entries', () => {
    const oldFile = path.join(tmpRoot, '.codexcli.json');
    const newDir = path.join(tmpRoot, '.codexcli');
    fs.writeFileSync(oldFile, JSON.stringify({
      entries: { a: '1' },
      aliases: {},
      confirm: {},
    }));

    migrateFileToDirectory(oldFile, newDir);

    expect(fs.existsSync(path.join(newDir, '_README.md'))).toBe(true);
  });
});

// ── Lock failure propagation (v1.11 fail-closed) ───────────────────────

describe('save() under lock failure', () => {
  it('throws when lock acquisition fails (fail-closed default)', () => {
    const dir = path.join(tmpRoot, 'store');
    const store = makeStore(dir);
    // Prime the store so the directory exists.
    store.save({ entries: { a: '1' }, aliases: {}, confirm: {} });

    // Plant a fresh non-stale lock at the sibling path so all retries fail.
    const lockPath = getStoreLockKey(dir) + '.lock';
    fs.writeFileSync(lockPath, '99999');
    // mtime defaults to now → not stale → acquireLock exhausts retries

    const previousEnv = process.env.CODEX_DISABLE_LOCKING;
    delete process.env.CODEX_DISABLE_LOCKING;
    try {
      expect(() =>
        store.save({ entries: { a: '2' }, aliases: {}, confirm: {} })
      ).toThrow(/Unable to acquire lock/);
      // The thrown error means the second save did NOT clobber the first.
      // Verify by reading from a fresh store: the original value is intact.
      const fresh = makeStore(dir);
      expect(fresh.load().entries).toEqual({ a: '1' });
    } finally {
      if (previousEnv !== undefined) process.env.CODEX_DISABLE_LOCKING = previousEnv;
      try { fs.unlinkSync(lockPath); } catch { /* may not exist */ }
    }
  });

  it('falls back to lockless save when CODEX_DISABLE_LOCKING=1', () => {
    const dir = path.join(tmpRoot, 'store');
    const store = makeStore(dir);
    store.save({ entries: { a: '1' }, aliases: {}, confirm: {} });

    // Same lock-blocking setup as the test above.
    const lockPath = getStoreLockKey(dir) + '.lock';
    fs.writeFileSync(lockPath, '99999');

    const previousEnv = process.env.CODEX_DISABLE_LOCKING;
    process.env.CODEX_DISABLE_LOCKING = '1';
    try {
      // With the env var set, the save proceeds despite the blocking lock.
      store.save({ entries: { a: '2' }, aliases: {}, confirm: {} });
      const fresh = makeStore(dir);
      expect(fresh.load().entries).toEqual({ a: '2' });
    } finally {
      if (previousEnv !== undefined) process.env.CODEX_DISABLE_LOCKING = previousEnv;
      else delete process.env.CODEX_DISABLE_LOCKING;
      try { fs.unlinkSync(lockPath); } catch { /* may not exist */ }
    }
  });
});
