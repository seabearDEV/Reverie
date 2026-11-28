/**
 * #305 PR 4, store files and messages: the items that need a fault injected
 * inside one process.
 *
 * - L19 (#277 item 1): a commit whose deletes all find their file gone, then
 *   writes the confirmation list and fails on the even epoch, said "Nothing
 *   was written." although the list had changed.
 * - L21 (#277 item 3): `rm ns` whose delete of one member fails drops the
 *   aliases of the members actually deleted, and keeps the aliases of the
 *   member still on disk.
 * - L24 (#277 item 6): a system error from the other store's inspect()
 *   inside updateUnderBothLocks is a StoreWriteError (IO), not a raw error.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createDirectoryStore } from '../utils/directoryStore';
import { StoreWriteError } from '../utils/storeWriteError';
import { flattenObject } from '../utils/objectPath';
import { removeEntry } from '../commands/entries';
import { useTempGlobalStore, onDisk, seed } from './helpers/interleave';

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = 0;
});

function caught(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error('expected a throw');
}

describe('L19 (#277 item 1): a changed confirmation list is never "Nothing was written"', () => {
  let tmpRoot: string;
  beforeEach(() => { tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'reverie-l19-')); });
  afterEach(() => { fs.rmSync(tmpRoot, { recursive: true, force: true }); });

  it('every delete finds its file gone, the list loses a flag, then the even epoch cannot be written', () => {
    const dir = path.join(tmpRoot, 'store');
    const store = createDirectoryStore(() => dir, () => { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); });
    store.save({ entries: { a: '1', k: 'v' }, aliases: {}, confirm: { k: true } });
    const confirmPath = path.join(dir, '_confirm.json');
    const epochPath = path.join(dir, '_epoch.json');

    // Another process removed `a` under the lock: the delete finds it gone.
    const unlink = fs.unlinkSync.bind(fs);
    vi.spyOn(fs, 'unlinkSync').mockImplementation(((p: fs.PathLike) => {
      if (String(p) === path.join(dir, 'a.json')) unlink(p);
      return unlink(p);
    }) as typeof fs.unlinkSync);
    // The list is written after the deletes; then the epoch's place holds a directory.
    const rename = fs.renameSync.bind(fs);
    vi.spyOn(fs, 'renameSync').mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
      rename(from, to);
      if (String(to) === confirmPath) {
        fs.rmSync(epochPath);
        fs.mkdirSync(epochPath);
      }
    }) as typeof fs.renameSync);

    const err = caught(() => store.update(current => ({ ...current, entries: { k: 'v' }, confirm: {} })));
    vi.restoreAllMocks();

    expect(err).toBeInstanceOf(StoreWriteError);
    expect(JSON.parse(fs.readFileSync(confirmPath, 'utf8'))).toEqual({});
    expect((err as Error).message).not.toContain('Nothing was written');
  });
});

describe('L21 (#277 item 3): a partial namespace rm cascades the aliases of what it deleted', () => {
  const tmp = useTempGlobalStore();

  it('one member cannot be deleted: its alias stays, the deleted member\'s alias goes', async () => {
    seed({
      entries: { g: { deploy: 'echo deploy', stuck: 's' }, other: 'o' },
      aliases: { gd: 'g.deploy', gs: 'g.stuck', go: 'other' },
    });
    const stuck = path.join(tmp.storeDir, 'g.stuck.json');
    const unlink = fs.unlinkSync.bind(fs);
    vi.spyOn(fs, 'unlinkSync').mockImplementation(((p: fs.PathLike) => {
      if (String(p) === stuck) throw Object.assign(new Error(`EPERM: operation not permitted, unlink '${stuck}'`), { code: 'EPERM', syscall: 'unlink', path: stuck });
      return unlink(p);
    }) as typeof fs.unlinkSync);

    await expect(removeEntry('g', true, true)).rejects.toThrow('EPERM');
    vi.restoreAllMocks();

    const d = onDisk();
    expect(flattenObject(d.entries)).toEqual({ 'g.stuck': 's', other: 'o' });
    expect(d.aliases).toEqual({ gs: 'g.stuck', go: 'other' });
  });
});

describe('L24 (#277 item 6): the other store\'s system error inside updateUnderBothLocks is IO', () => {
  let tmpRoot: string;
  const saved: Record<string, string | undefined> = {};
  const names = ['RVR_DATA_DIR', 'RVR_PROJECT', 'RVR_NO_PROJECT', 'RVR_PROJECT_DIR'];

  beforeEach(() => {
    tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'reverie-l24-')));
    for (const n of names) saved[n] = process.env[n];
    for (const n of names) delete process.env[n];
    process.env.RVR_DATA_DIR = path.join(tmpRoot, 'data');
    process.env.RVR_PROJECT = path.join(tmpRoot, 'proj');
    fs.mkdirSync(path.join(tmpRoot, 'proj', '.reverie'), { recursive: true });
    fs.mkdirSync(path.join(tmpRoot, 'data', 'store'), { recursive: true });
  });
  afterEach(async () => {
    const store = await import('../store');
    store.clearStoreCaches();
    for (const n of names) { if (saved[n] === undefined) delete process.env[n]; else process.env[n] = saved[n]; }
    store.clearStoreCaches();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  for (const scope of ['project', 'global'] as const) {
    it(`writing the ${scope} store: the other store cannot be listed`, async () => {
      const store = await import('../store');
      store.clearStoreCaches();
      // Both stores opened before the fault, so it is met by the transaction alone.
      store.loadEntries('project');
      store.loadEntries('global');
      const otherDir = scope === 'project' ? path.join(tmpRoot, 'data', 'store') : path.join(tmpRoot, 'proj', '.reverie');
      const readdir = fs.readdirSync.bind(fs);
      vi.spyOn(fs, 'readdirSync').mockImplementation(((p: fs.PathLike, o?: unknown) => {
        if (path.resolve(String(p)) === otherDir) throw Object.assign(new Error(`EACCES: permission denied, scandir '${otherDir}'`), { code: 'EACCES', syscall: 'scandir', path: otherDir });
        return (readdir as (p: fs.PathLike, o?: unknown) => unknown)(p, o);
      }) as typeof fs.readdirSync);

      const err = caught(() => store.updateUnderBothLocks(scope, () => null));
      vi.restoreAllMocks();

      expect(err).toBeInstanceOf(StoreWriteError);
      expect((err as StoreWriteError).code).toBe('EACCES');
      expect((err as Error).message).toContain('Nothing was written');
    });
  }
});
