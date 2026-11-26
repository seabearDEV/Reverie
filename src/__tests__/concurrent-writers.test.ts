/**
 * #254: concurrent writers must not delete each other's entries and flags.
 *
 * Every store write is a read, a change and a write. These tests put a second
 * writer — process B, modelled as its own store instance over the same
 * directory, so with its own caches — at the points where it can land: B
 * commits one write just before EACH time process A goes for the store lock
 * (the lock is free then, as it would be for a real second process), and one
 * more after A last read the store and before A's command starts. A's
 * command runs through the real callers, against a real store in a temp dir.
 *
 * Whatever A read before taking the lock is stale by the time it writes. The
 * rule under test: what A writes is decided from the store as it stands under
 * the lock, so every write of B's survives next to A's.
 *
 * No timing: the interleaving is driven from the lock acquisition itself.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createDirectoryStore } from '../utils/directoryStore';
import { clearDataDirectoryCache } from '../utils/paths';
import { flattenObject } from '../utils/objectPath';
import { clearStoreCaches, loadAliasMap, loadConfirmMap, loadEntries } from '../store';
import type { ScopedStore, UnifiedData } from '../store';
import { setConfirm, removeConfirm, removeConfirmForKey, moveConfirm } from '../confirm';
import { setAlias, removeAlias, renameAlias, removeAliasesForKey } from '../alias';
import { removeValue } from '../storage';
import { copyEntry, renameEntry, removeEntry } from '../commands/entries';
import { importData } from '../commands/data-management';

let root: string;
let storeDir: string;
const savedEnv = { data: process.env.RVR_DATA_DIR, noProject: process.env.RVR_NO_PROJECT };
const originalLog = console.log;
const originalError = console.error;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'rvr-254-'));
  storeDir = path.join(root, 'store');
  // The global store under a temp data dir; no project resolves from the cwd.
  process.env.RVR_DATA_DIR = root;
  process.env.RVR_NO_PROJECT = '1';
  clearDataDirectoryCache();
  clearStoreCaches();
  console.log = vi.fn();
  console.error = vi.fn();
});

afterEach(() => {
  vi.restoreAllMocks();
  console.log = originalLog;
  console.error = originalError;
  if (savedEnv.data === undefined) delete process.env.RVR_DATA_DIR; else process.env.RVR_DATA_DIR = savedEnv.data;
  if (savedEnv.noProject === undefined) delete process.env.RVR_NO_PROJECT; else process.env.RVR_NO_PROJECT = savedEnv.noProject;
  clearDataDirectoryCache();
  clearStoreCaches();
  fs.rmSync(root, { recursive: true, force: true });
});

/** Another process: a store instance of its own over the same directory. */
function otherProcess(): ScopedStore {
  return createDirectoryStore(() => storeDir, () => { fs.mkdirSync(storeDir, { recursive: true }); });
}

/** The store as a fresh reader sees it. */
function onDisk(): UnifiedData {
  return otherProcess().load();
}

function seed(data: Partial<UnifiedData>): void {
  otherProcess().save({ entries: {}, aliases: {}, confirm: {}, ...data });
  clearStoreCaches();
}

/** One write by B, under a name of its own (`n` counts B's writes). */
type BWrite = (b: ScopedStore, n: number) => string;

const bEntry: BWrite = (b, n) => {
  const key = `b.entry${n}`;
  if (!b.setOne(key, `v${n}`, Date.now())) throw new Error(`setOne(${key}) declined`);
  return key;
};
const bFlag: BWrite = (b, n) => {
  const key = `b.flag${n}`;
  const d = b.load();
  d.confirm[key] = true;
  b.save(d);
  return key;
};
const bAlias: BWrite = (b, n) => {
  const name = `balias${n}`;
  const d = b.load();
  d.aliases[name] = `b.target${n}`;
  b.save(d);
  return name;
};

/**
 * Run A's command with B writing in every gap: once after A last read the
 * store (A's caches are then stale), and once just before each of A's lock
 * acquisitions. Returns the names B wrote.
 */
async function interleave(op: () => unknown, bWrite: BWrite): Promise<string[]> {
  const b = otherProcess();
  const written: string[] = [];

  // A has read the store — as the caller of any command has — and B writes.
  loadEntries('global');
  loadAliasMap('global');
  loadConfirmMap('global');
  written.push(bWrite(b, written.length));

  const lockPath = storeDir + '.lock';
  const realOpen = fs.openSync.bind(fs);
  let inB = false;
  vi.spyOn(fs, 'openSync').mockImplementation(((p: fs.PathLike, ...rest: unknown[]) => {
    if (!inB && String(p) === lockPath) {
      inB = true;
      try { written.push(bWrite(b, written.length)); } finally { inB = false; }
    }
    return (realOpen as (...args: unknown[]) => number)(p, ...rest);
  }) as typeof fs.openSync);
  try {
    await op();
  } finally {
    vi.restoreAllMocks();
  }
  return written;
}

const entryKeys = (d: UnifiedData): string[] => Object.keys(flattenObject(d.entries)).sort();

describe('#254: a write by another process survives', () => {
  describe('the confirmation list', () => {
    it('confirm set keeps the entries written meanwhile', async () => {
      seed({ entries: { ops: { deploy: 'true' } } });
      const bKeys = await interleave(() => setConfirm('ops.deploy', 'global'), bEntry);
      const d = onDisk();
      expect(bKeys.length).toBeGreaterThan(1);
      for (const k of bKeys) expect(entryKeys(d)).toContain(k);
      expect(d.confirm['ops.deploy']).toBe(true);
    });

    it('confirm set keeps the flags set meanwhile', async () => {
      seed({ entries: { ops: { deploy: 'true' } } });
      const bKeys = await interleave(() => setConfirm('ops.deploy', 'global'), bFlag);
      const d = onDisk();
      for (const k of bKeys) expect(d.confirm[k]).toBe(true);
      expect(d.confirm['ops.deploy']).toBe(true);
    });

    it('confirm remove keeps the flags set meanwhile', async () => {
      seed({ entries: { ops: { deploy: 'true' } }, confirm: { 'ops.deploy': true } });
      const bKeys = await interleave(() => { expect(removeConfirm('ops.deploy', 'global')).toBe(true); }, bFlag);
      const d = onDisk();
      for (const k of bKeys) expect(d.confirm[k]).toBe(true);
      expect(d.confirm['ops.deploy']).toBeUndefined();
    });

    it('the remove cascade keeps the flags set meanwhile', async () => {
      seed({ confirm: { 'ops.deploy': true, 'ops.build': true } });
      const bKeys = await interleave(() => removeConfirmForKey('ops', 'global'), bFlag);
      const d = onDisk();
      for (const k of bKeys) expect(d.confirm[k]).toBe(true);
      expect(Object.keys(d.confirm).filter(k => k.startsWith('ops.'))).toEqual([]);
    });

    it('moveConfirm keeps the flags set meanwhile', async () => {
      seed({ entries: { h: { x: 'true' } }, confirm: { 'g.x': true } });
      const bKeys = await interleave(() => moveConfirm([['g.x', 'h.x']], 'global'), bFlag);
      const d = onDisk();
      for (const k of bKeys) expect(d.confirm[k]).toBe(true);
      expect(d.confirm['h.x']).toBe(true);
      expect(d.confirm['g.x']).toBe(true);
    });

    it('a flag set while a rename moves another flag keeps both (the issue\'s third case)', async () => {
      // B renames g.x to h.x, carrying its flag, while A's confirm set is
      // between reading the list and writing it.
      seed({ entries: { g: { x: 'true' }, other: { k: 'true' } }, confirm: { 'g.x': true } });
      let renamed = false;
      const bRename: BWrite = (b, n) => {
        if (renamed) return bFlag(b, n);
        renamed = true;
        const d = b.load();
        const flat = flattenObject(d.entries);
        delete (d.entries.g as Record<string, string>).x;
        delete d.entries.g;
        d.entries.h = { x: flat['g.x'] };
        d.confirm['h.x'] = true;
        b.save(d);
        return 'h.x';
      };
      const bKeys = await interleave(() => setConfirm('other.k', 'global'), bRename);
      const d = onDisk();
      for (const k of bKeys) expect(d.confirm[k]).toBe(true);
      expect(d.confirm['h.x']).toBe(true);
      expect(d.confirm['other.k']).toBe(true);
      expect(entryKeys(d)).toContain('h.x');
    });
  });

  describe('the alias map', () => {
    it('alias set keeps the aliases set meanwhile', async () => {
      seed({ entries: { x: { y: 'v' } } });
      const bNames = await interleave(() => setAlias('a1', 'x.y', 'global'), bAlias);
      const d = onDisk();
      for (const n of bNames) expect(d.aliases[n]).toBeDefined();
      expect(d.aliases.a1).toBe('x.y');
    });

    it('alias remove keeps the aliases set meanwhile', async () => {
      seed({ entries: { x: { y: 'v' } }, aliases: { a1: 'x.y' } });
      const bNames = await interleave(() => { expect(removeAlias('a1', 'global')).toBe(true); }, bAlias);
      const d = onDisk();
      for (const n of bNames) expect(d.aliases[n]).toBeDefined();
      expect(d.aliases.a1).toBeUndefined();
    });

    it('alias rename keeps the aliases set meanwhile', async () => {
      seed({ entries: { x: { y: 'v' } }, aliases: { a1: 'x.y' } });
      const bNames = await interleave(() => { expect(renameAlias('a1', 'a2', 'global')).toBe(true); }, bAlias);
      const d = onDisk();
      for (const n of bNames) expect(d.aliases[n]).toBeDefined();
      expect(d.aliases.a2).toBe('x.y');
      expect(d.aliases.a1).toBeUndefined();
    });

    it('the remove cascade keeps the aliases set meanwhile', async () => {
      seed({ aliases: { a1: 'x.y', a2: 'x.z' } });
      const bNames = await interleave(() => removeAliasesForKey('x', 'global'), bAlias);
      const d = onDisk();
      for (const n of bNames) expect(d.aliases[n]).toBeDefined();
      expect(d.aliases.a1).toBeUndefined();
      expect(d.aliases.a2).toBeUndefined();
    });
  });

  describe('a full entry save', () => {
    it('removeValue keeps the entries set meanwhile', async () => {
      seed({ entries: { a: { x: '1', y: '2' } } });
      const bKeys = await interleave(() => { expect(removeValue('a.x', 'global')).toBe(true); }, bEntry);
      const keys = entryKeys(onDisk());
      for (const k of bKeys) expect(keys).toContain(k);
      expect(keys).not.toContain('a.x');
      expect(keys).toContain('a.y');
    });

    it('rm keeps the entries, aliases and flags written meanwhile', async () => {
      seed({ entries: { a: { x: '1' }, keep: { me: '1' } }, aliases: { ax: 'a.x' }, confirm: { 'a.x': true } });
      const mixed: BWrite = (b, n) => [bEntry, bFlag, bAlias][n % 3](b, n);
      const bKeys = await interleave(() => removeEntry('a', true, true), mixed);
      const d = onDisk();
      const keys = entryKeys(d);
      expect(bKeys.length).toBeGreaterThanOrEqual(3);
      for (const k of bKeys) {
        expect(keys.includes(k) || d.confirm[k] === true || d.aliases[k] !== undefined).toBe(true);
      }
      expect(keys).not.toContain('a.x');
      expect(d.aliases.ax).toBeUndefined();
      expect(d.confirm['a.x']).toBeUndefined();
    });

    it('a namespace copy keeps the entries set meanwhile', async () => {
      seed({ entries: { src: { a: '1', b: '2' } } });
      const bKeys = await interleave(() => copyEntry('src', 'dst', true, true), bEntry);
      const keys = entryKeys(onDisk());
      for (const k of bKeys) expect(keys).toContain(k);
      expect(keys).toEqual(expect.arrayContaining(['src.a', 'src.b', 'dst.a', 'dst.b']));
    });

    it('a namespace rename keeps the entries set meanwhile', async () => {
      seed({ entries: { src: { a: '1', b: '2' } } });
      const bKeys = await interleave(() => renameEntry('src', 'moved', false, undefined, true), bEntry);
      const keys = entryKeys(onDisk());
      for (const k of bKeys) expect(keys).toContain(k);
      expect(keys).toEqual(expect.arrayContaining(['moved.a', 'moved.b']));
      expect(keys.filter(k => k.startsWith('src.'))).toEqual([]);
    });

    it('a rename keeps the flags and aliases set meanwhile, and carries its own', async () => {
      seed({ entries: { g: { x: 'true' } }, aliases: { gx: 'g.x' }, confirm: { 'g.x': true } });
      const mixed: BWrite = (b, n) => (n % 2 === 0 ? bFlag : bAlias)(b, n);
      const bKeys = await interleave(() => renameEntry('g.x', 'h.x', false, undefined, true), mixed);
      const d = onDisk();
      for (const k of bKeys) expect(d.confirm[k] === true || d.aliases[k] !== undefined).toBe(true);
      expect(d.confirm['h.x']).toBe(true);
      expect(d.aliases.gx).toBe('h.x');
      expect(entryKeys(d)).toContain('h.x');
    });

    it('a merge import keeps the entries set meanwhile', async () => {
      seed({ entries: { old: { k: '1' } } });
      const file = path.join(root, 'import.json');
      fs.writeFileSync(file, JSON.stringify({ imported: { k: '2' } }));
      const bKeys = await interleave(() => importData('entries', file, { merge: true, force: true, global: true }), bEntry);
      const keys = entryKeys(onDisk());
      for (const k of bKeys) expect(keys).toContain(k);
      expect(keys).toEqual(expect.arrayContaining(['old.k', 'imported.k']));
    });
  });
});
