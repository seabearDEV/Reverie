/**
 * #259: a rename is one step — it completes, or it changes nothing.
 *
 * A rename moves the value, re-points the aliases and flags the new key of
 * every gated entry it moves. It used to do those as separate store writes,
 * and to decide what it moved and which entries were gated before taking any
 * lock. The review of #254 reproduced three consequences, every command
 * reporting success:
 *
 *   1. A `confirm set` of the old key racing the rename left the flag on the
 *      old name and the new key ungated — from either side: the rename asked
 *      which entries were gated before the flag was set, or `confirm set`
 *      checked that the entry existed before the rename moved it.
 *   2. A lock held by another process between two of the writes left the
 *      value moved and its flag behind.
 *   3. A `set` under the old namespace racing the rename was removed with it,
 *      under neither name.
 *
 * Process B (helpers/interleave.ts) commits a write at each point process A
 * goes for a store lock, and once before A's command reads anything. Every
 * interleaving is driven from the lock acquisitions themselves — no timing.
 */
import fs from 'fs';
import path from 'path';
import { flattenObject } from '../utils/objectPath';
import { clearProjectFileCache } from '../utils/paths';
import { clearStoreCaches } from '../store';
import { setConfirm } from '../confirm';
import { renameEntry, setEntry } from '../commands/entries';
import { importData } from '../commands/data-management';
import {
  useTempGlobalStore, otherProcess, onDisk, seed, entryKeys, interleave,
  bEntry, type BWrite,
} from './helpers/interleave';
import type { ScopedStore, UnifiedData } from '../store';

const tmp = useTempGlobalStore();
// A held lock is waited for in full (STORE_LOCK_WAIT_MS) before it fails.
const HELD_LOCK_TEST_MS = 20_000;

afterEach(() => { process.exitCode = 0; });

/** B's write at its first lock gap only (n >= 1: after A has read the store); an unrelated entry everywhere else. */
function onceAfterRead(write: (b: ScopedStore) => string): BWrite {
  let done = false;
  return (b, n) => {
    if (n === 0 || done) return bEntry(b, n);
    done = true;
    return write(b);
  };
}

const flagIn = (key: string) => (b: ScopedStore): string => {
  const d = b.load();
  d.confirm[key] = true;
  b.save(d);
  return key;
};

/** B's own rename of `from` to `to`, carrying nothing (at that point there is no flag to carry). */
const renameIn = (from: string, to: string) => (b: ScopedStore): string => {
  const d = b.load();
  const flat = flattenObject(d.entries);
  const [ns, leaf] = from.split('.');
  const [toNs, toLeaf] = to.split('.');
  delete (d.entries[ns] as Record<string, unknown>)[leaf];
  if (Object.keys(d.entries[ns] as object).length === 0) delete d.entries[ns];
  d.entries[toNs] = { ...(d.entries[toNs] as object ?? {}), [toLeaf]: flat[from] };
  b.save(d);
  return to;
};

/** Run `fn` with a project store at <root>/proj/.reverie, resolved the way the CLI does. */
async function inProject(fn: (projectDir: string) => Promise<void>): Promise<void> {
  const projectDir = path.join(tmp.root, 'proj', '.reverie');
  fs.mkdirSync(projectDir, { recursive: true });
  const saved = { noProject: process.env.RVR_NO_PROJECT, project: process.env.RVR_PROJECT };
  delete process.env.RVR_NO_PROJECT;
  process.env.RVR_PROJECT = projectDir;
  clearProjectFileCache();
  clearStoreCaches();
  try {
    await fn(projectDir);
  } finally {
    if (saved.project === undefined) delete process.env.RVR_PROJECT; else process.env.RVR_PROJECT = saved.project;
    if (saved.noProject !== undefined) process.env.RVR_NO_PROJECT = saved.noProject;
    clearProjectFileCache();
  }
}

function seedProject(projectDir: string, data: Partial<UnifiedData>): void {
  otherProcess(projectDir).save({ entries: {}, aliases: {}, confirm: {}, ...data });
  clearStoreCaches();
}

describe('#259: a rename racing a confirmation flag on the same key (race 1)', () => {
  it('a flag set on the old key after the rename started: the new key is flagged', async () => {
    // B flags g.x after A has read the store, just before A takes the lock.
    // A has to see it: the moved entry is gated.
    seed({ entries: { g: { x: 'true' } } });
    const written = await interleave(() => renameEntry('g.x', 'h.x', false, undefined, true), onceAfterRead(flagIn('g.x')));
    expect(written).toContain('g.x');
    const d = onDisk();
    expect(entryKeys(d)).toContain('h.x');
    expect(entryKeys(d)).not.toContain('g.x');
    expect(d.confirm['h.x']).toBe(true);
    expect(d.confirm['g.x']).toBe(true);
  });

  it('confirm set of a key renamed after it was looked up: refused, nothing written', async () => {
    // The other order: confirm set has seen g.x; B renames it before the
    // flag is written. A flag on g.x would gate nothing that moved, and
    // h.x would run unconfirmed while confirm set reported success.
    seed({ entries: { g: { x: 'true' } } });
    let result: boolean | undefined;
    const written = await interleave(() => { result = setConfirm('g.x', 'global') as boolean | undefined; }, onceAfterRead(renameIn('g.x', 'h.x')));
    expect(written).toContain('h.x');
    expect(result).toBe(false);
    expect(onDisk().confirm).toEqual({});
  });

  it('set <key> --confirm the same way: NOT_FOUND, exit 1, no flag', async () => {
    seed({ entries: { g: { x: 'true' } } });
    let out: unknown = 'not run';
    await interleave(async () => { out = await setEntry('g.x', undefined, false, false, undefined, true, true); }, onceAfterRead(renameIn('g.x', 'h.x')));
    expect(out).toBeUndefined();
    expect(process.exitCode).toBe(1);
    expect(onDisk().confirm).toEqual({});
    expect((console.error as ReturnType<typeof vi.fn>).mock.calls.flat().join('\n')).toContain("Entry 'g.x' not found");
  });

  it('a project rename racing a flag set in the GLOBAL list: the new key is flagged (both locks)', async () => {
    // The entry is the project's, the flag goes in the global list — set by
    // B as A goes for the project lock. The rename holds both stores' locks,
    // so the flag is either there when it decides or set after the entry
    // has moved.
    await inProject(async (projectDir) => {
      seedProject(projectDir, { entries: { g: { x: 'true' } } });
      const flagGlobal = onceAfterRead(() => flagIn('g.x')(otherProcess()));
      const written = await interleave(() => renameEntry('g.x', 'h.x'), flagGlobal, projectDir);
      expect(written).toContain('g.x');
      const project = onDisk(projectDir);
      expect(entryKeys(project)).toContain('h.x');
      expect(entryKeys(project)).not.toContain('g.x');
      expect(project.confirm['h.x']).toBe(true);
      expect(onDisk().confirm).toMatchObject({ 'g.x': true });
    });
  });

  it('confirm set -G of a project entry renamed after it was looked up: refused (both locks)', async () => {
    await inProject(async (projectDir) => {
      seedProject(projectDir, { entries: { g: { x: 'true' } } });
      let result: boolean | undefined;
      const written = await interleave(() => { result = setConfirm('g.x', 'global') as boolean | undefined; }, onceAfterRead(renameIn('g.x', 'h.x')), projectDir);
      expect(written).toContain('h.x');
      expect(result).toBe(false);
      expect(onDisk().confirm).toEqual({});
    });
  });
});

describe('#259: an entry written under the old namespace during the rename (race 3)', () => {
  it('is moved with it or stays under the old name — never lost', async () => {
    seed({ entries: { ren: { a: '1', b: '2' } } });
    const bIntoOld: BWrite = (b, n) => {
      const key = `ren.k${n}`;
      if (!b.setOne(key, `v${n}`, Date.now())) throw new Error(`setOne(${key}) declined`);
      return key;
    };
    const written = await interleave(() => renameEntry('ren', 'moved', false, undefined, true), bIntoOld);
    expect(written.length).toBeGreaterThan(1);
    const keys = entryKeys(onDisk());
    for (const k of written) expect(keys.includes(k) || keys.includes(k.replace(/^ren\./, 'moved.')), k).toBe(true);
    expect(keys).toEqual(expect.arrayContaining(['moved.a', 'moved.b']));
  });

  it('a destination written meanwhile is not overwritten: refused, nothing moved', async () => {
    seed({ entries: { g: { x: 'old' } } });
    const bTakesDestination = onceAfterRead((b) => {
      if (!b.setOne('h.x', 'theirs', Date.now())) throw new Error('setOne declined');
      return 'h.x';
    });
    await interleave(() => renameEntry('g.x', 'h.x', false, undefined, true), bTakesDestination);
    const flat = flattenObject(onDisk().entries);
    expect(flat['h.x']).toBe('theirs');
    expect(flat['g.x']).toBe('old');
    expect(process.exitCode).toBe(1);
  });

  it('a source removed meanwhile is not brought back under the new name', async () => {
    seed({ entries: { g: { x: 'old' }, keep: { me: '1' } } });
    const bRemoves = onceAfterRead((b) => {
      const d = b.load();
      delete d.entries.g;
      b.save(d);
      return 'keep.me';
    });
    await interleave(() => renameEntry('g.x', 'h.x', false, undefined, true), bRemoves);
    expect(entryKeys(onDisk())).not.toContain('h.x');
    expect(process.exitCode).toBe(1);
  });
});

/**
 * Another process holds a store lock at the `nth` time this process goes for
 * one — the locks of every store in `dirs` counted together. The lock file
 * appears just before that attempt, so the attempt waits the full
 * STORE_LOCK_WAIT_MS and fails; it is removed once `op` has returned.
 */
async function withLockHeldAt(nth: number, dirs: string[], op: () => unknown): Promise<{ error: unknown; acquisitions: number }> {
  const locks = new Set(dirs.map(d => `${d}.lock`));
  const realOpen = fs.openSync.bind(fs);
  let acquisitions = 0;
  let held: string | undefined;
  let error: unknown;
  vi.spyOn(fs, 'openSync').mockImplementation(((p: fs.PathLike, ...rest: unknown[]) => {
    const lockPath = String(p);
    if (held === undefined && locks.has(lockPath)) {
      acquisitions++;
      if (acquisitions === nth) {
        held = lockPath;
        fs.writeFileSync(lockPath, '999999');
      }
    }
    return (realOpen as (...args: unknown[]) => number)(p, ...rest);
  }) as typeof fs.openSync);
  try {
    await op();
  } catch (err) {
    error = err;
  } finally {
    vi.restoreAllMocks();
    if (held) fs.rmSync(held, { force: true });
  }
  return { error, acquisitions };
}

describe('#259: a lock held by another process at any step (race 2)', () => {
  /** Either the store is as it was, or the rename is complete — value, alias and flag. */
  function expectAllOrNothing(d: UnifiedData, label: string): 'untouched' | 'complete' {
    const keys = entryKeys(d);
    const untouched = keys.includes('g.x') && !keys.includes('h.x') && d.aliases.gx === 'g.x' && d.confirm['h.x'] === undefined;
    const complete = !keys.includes('g.x') && keys.includes('h.x') && d.aliases.gx === 'h.x' && d.confirm['h.x'] === true;
    expect(untouched || complete, `${label}: ${JSON.stringify({ keys, aliases: d.aliases, confirm: d.confirm })}`).toBe(true);
    return untouched ? 'untouched' : 'complete';
  }

  it('in one store: the rename completes or changes nothing, wherever the lock is held', async () => {
    const outcomes: string[] = [];
    for (let nth = 1; nth <= 4; nth++) {
      clearStoreCaches();
      fs.rmSync(tmp.storeDir, { recursive: true, force: true });
      seed({ entries: { g: { x: 'true' } }, aliases: { gx: 'g.x' }, confirm: { 'g.x': true } });
      const { error, acquisitions } = await withLockHeldAt(nth, [tmp.storeDir], () => renameEntry('g.x', 'h.x', false, undefined, true));
      const outcome = expectAllOrNothing(onDisk(), `lock held at acquisition ${nth}`);
      outcomes.push(outcome);
      // A refusal is reported, not thrown past the command.
      expect(error, `acquisition ${nth}`).toBeUndefined();
      expect(onDisk().confirm['g.x']).toBe(true);
      if (nth > acquisitions) expect(outcome).toBe('complete');
      process.exitCode = 0;
    }
    expect(outcomes[0]).toBe('untouched');
  }, HELD_LOCK_TEST_MS);

  it('across two stores: a held second lock releases the first, and nothing is written', async () => {
    await inProject(async (projectDir) => {
      for (let nth = 1; nth <= 3; nth++) {
        clearStoreCaches();
        for (const dir of [projectDir, tmp.storeDir]) fs.rmSync(dir, { recursive: true, force: true });
        seed({ confirm: { 'g.x': true } });
        seedProject(projectDir, { entries: { g: { x: 'true' } }, aliases: { gx: 'g.x' } });
        const { error } = await withLockHeldAt(nth, [projectDir, tmp.storeDir], () => renameEntry('g.x', 'h.x'));
        expect(error, `acquisition ${nth}`).toBeUndefined();
        const outcome = expectAllOrNothing(onDisk(projectDir), `lock held at acquisition ${nth}`);
        // The project lock first, then the global one; the third attempt is never made.
        expect(outcome, `acquisition ${nth}`).toBe(nth <= 2 ? 'untouched' : 'complete');
        expect(onDisk().confirm).toEqual({ 'g.x': true });
        // Neither lock is left behind.
        expect(fs.existsSync(`${projectDir}.lock`)).toBe(false);
        expect(fs.existsSync(`${tmp.storeDir}.lock`)).toBe(false);
        process.exitCode = 0;
      }
    });
  }, HELD_LOCK_TEST_MS);

  it('a held lock is reported as a failed rename, not thrown', async () => {
    seed({ entries: { g: { x: 'true' } } });
    const { error } = await withLockHeldAt(1, [tmp.storeDir], () => renameEntry('g.x', 'h.x', false, undefined, true));
    expect(error).toBeUndefined();
    expect(process.exitCode).toBe(1);
    const said = (console.error as ReturnType<typeof vi.fn>).mock.calls.flat().join('\n');
    // #261: the one-line refusal every write gives, not "Failed to rename entry".
    expect(said).toContain('Unable to acquire lock');
    expect(said).toContain('nothing was written');
    expect(said).not.toContain('Failed to');
    expect(entryKeys(onDisk())).toEqual(['g.x']);
  }, HELD_LOCK_TEST_MS);
});

// Review of #259: one store write that both writes and deletes must not
// delete before every write has landed.
describe('#259: a write that fails inside the rename leaves the source', () => {
  /** Put a directory where an entry file would go: the write to that key then fails (EISDIR). */
  const blockWrite = (key: string) => fs.mkdirSync(path.join(tmp.storeDir, `${key}.json`), { recursive: true });
  const fileKeys = () => fs.readdirSync(tmp.storeDir).filter(f => f.endsWith('.json') && !f.startsWith('_')).sort();

  it('a leaf: nothing deleted, nothing written, the flag where it was', async () => {
    seed({ entries: { g: { x: 'precious' } }, confirm: { 'g.x': true } });
    blockWrite('h.x');
    await renameEntry('g.x', 'h.x', false, undefined, true);
    expect(process.exitCode).toBe(1);
    expect(flattenObject(onDisk().entries)).toEqual({ 'g.x': 'precious' });
    expect(onDisk().confirm).toEqual({ 'g.x': true });
  });

  it('a namespace: the leaves already written are taken back, the source stays whole', async () => {
    seed({ entries: { a: { one: '1', two: 'echo two' } }, aliases: { a2: 'a.two' }, confirm: { 'a.two': true } });
    blockWrite('n.two');
    await renameEntry('a', 'n', false, undefined, true);
    expect(process.exitCode).toBe(1);
    expect(flattenObject(onDisk().entries)).toEqual({ 'a.one': '1', 'a.two': 'echo two' });
    expect(fileKeys()).toEqual(['a.one.json', 'a.two.json', 'n.two.json']);   // n.two.json is the directory
    expect(onDisk().aliases).toEqual({ a2: 'a.two' });
    expect(onDisk().confirm).toEqual({ 'a.two': true });
  });

  it('the confirmation list is written before the entries it gates', async () => {
    // A renamed command must never be on disk without its flag, even for
    // the moment between two writes.
    seed({ entries: { g: { x: 'echo hi' } }, confirm: { 'g.x': true } });
    const realRename = fs.renameSync.bind(fs);
    const order: string[] = [];
    vi.spyOn(fs, 'renameSync').mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
      if (String(to).startsWith(tmp.storeDir)) order.push(path.basename(String(to)));
      return realRename(from, to);
    }) as typeof fs.renameSync);
    await renameEntry('g.x', 'h.x', false, undefined, true);
    vi.restoreAllMocks();
    expect(order.indexOf('_confirm.json')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('_confirm.json')).toBeLessThan(order.indexOf('h.x.json'));
    expect(onDisk().confirm).toEqual({ 'g.x': true, 'h.x': true });
  });

  it.skipIf(process.platform !== 'darwin')('a confirmation list that cannot be written: nothing changes (chflags uchg)', async () => {
    seed({ entries: { g: { x: 'echo hi' } }, confirm: { 'g.x': true } });
    const list = path.join(tmp.storeDir, '_confirm.json');
    const { spawnSync } = await import('child_process');
    expect(spawnSync('chflags', ['uchg', list]).status).toBe(0);
    try {
      await renameEntry('g.x', 'h.x', false, undefined, true);
    } finally {
      spawnSync('chflags', ['nouchg', list]);
    }
    expect(process.exitCode).toBe(1);
    expect(flattenObject(onDisk().entries)).toEqual({ 'g.x': 'echo hi' });
    expect(onDisk().confirm).toEqual({ 'g.x': true });
  });
});

describe('#259: a source stored both as a leaf and as a namespace', () => {
  // A leaf `k` and an entry `k.sub` side by side on disk (a hand edit, a
  // merge). The tree a rename works on holds one of them; the write would
  // delete the other. Refused, writing nothing.
  const plant = () => {
    fs.mkdirSync(tmp.storeDir, { recursive: true });
    fs.writeFileSync(path.join(tmp.storeDir, 'k.json'), JSON.stringify({ value: 'echo leaf' }));
    fs.writeFileSync(path.join(tmp.storeDir, 'k.sub.json'), JSON.stringify({ value: 'echo sub' }));
    fs.writeFileSync(path.join(tmp.storeDir, '_confirm.json'), JSON.stringify({ k: true }));
    clearStoreCaches();
  };
  const files = () => fs.readdirSync(tmp.storeDir).filter(f => f.endsWith('.json') && f !== '_epoch.json').sort();

  it('is refused, naming both, and nothing is written', async () => {
    plant();
    const before = files();
    await renameEntry('k', 'k2', false, undefined, true);
    expect(process.exitCode).toBe(1);
    const said = (console.error as ReturnType<typeof vi.fn>).mock.calls.flat().join('\n');
    expect(said).toContain("'k' is stored both as an entry and as a namespace ('k.sub')");
    expect(files()).toEqual(before);
    expect(JSON.parse(fs.readFileSync(path.join(tmp.storeDir, '_confirm.json'), 'utf8'))).toEqual({ k: true });
  });

  it('another spelling of it is refused naming the stored key, where the filesystem folds case', async () => {
    plant();
    const folds = fs.existsSync(path.join(tmp.storeDir, 'K.json'));
    await renameEntry('K', 'k9', false, undefined, true);
    expect(process.exitCode).toBe(1);
    const said = (console.error as ReturnType<typeof vi.fn>).mock.calls.flat().join('\n');
    expect(said).toContain(folds ? "did you mean 'k'?" : 'not found');
    expect(fs.existsSync(path.join(tmp.storeDir, 'k9.json'))).toBe(false);
  });
});

// Recheck of the review fixes: the undo of a failed write.
describe('#259: undoing a write that failed part-way', () => {
  const blockWrite = (key: string) => fs.mkdirSync(path.join(tmp.storeDir, `${key}.json`), { recursive: true });
  /** Does the store's filesystem open `stored`'s entry file for `asked`? */
  const opens = (asked: string, stored: string) => {
    const a = path.join(tmp.storeDir, `${asked}.json`);
    const b = path.join(tmp.storeDir, `${stored}.json`);
    return fs.existsSync(a) && fs.statSync(a).ino === fs.statSync(b).ino;
  };

  it.each([
    ['another case', 'deploy', 'Deploy'],
    ['another Unicode normalization', `caf${String.fromCodePoint(0xe9)}`, `cafe${String.fromCodePoint(0x301)}`],
  ])('an entry stored under %s, written through the other spelling, is put back — not deleted', async (_kind, stored, asked) => {
    // The write of `asked` lands in `stored`'s file. Undoing it by removing
    // the path it wrote removed `stored`'s entry.
    seed({ entries: { [stored]: 'echo ORIGINAL', other: 'o' }, confirm: { [stored]: true } });
    if (!opens(asked, stored)) return;   // this filesystem keeps them apart: nothing to undo into
    const file = path.join(tmp.root, 'import.json');
    fs.writeFileSync(file, JSON.stringify({ [asked]: 'echo NEW', ['z'.repeat(240)]: 'v' }));
    await importData('entries', file, { force: true, global: true });
    expect(process.exitCode).toBe(1);
    const flat = flattenObject(onDisk().entries);
    expect(flat[stored]).toBe('echo ORIGINAL');
    expect(flat.other).toBe('o');
    expect(onDisk().confirm).toEqual({ [stored]: true });
  });

  it.each([
    ['another case', 'secret', `${String.fromCodePoint(0x17f)}ecret`],
    ['another Unicode normalization', `caf${String.fromCodePoint(0xe9)}`, `cafe${String.fromCodePoint(0x301)}`],
  ])('two new keys that land in one file (%s) are both taken back', async (_kind, first, second) => {
    // The second write's prior state is the first write's bytes. Undone in
    // write order, the first write was removed and the file then rewritten
    // from the second's copy, leaving an entry nobody had stored.
    seed({ entries: { other: 'o' } });
    const probe = path.join(tmp.storeDir, `${first}.json`);
    fs.writeFileSync(probe, JSON.stringify({ value: 'probe' }));
    const folds = opens(second, first);
    fs.unlinkSync(probe);
    if (!folds) return;   // this filesystem keeps them apart: two files, nothing shared
    clearStoreCaches();
    const file = path.join(tmp.root, 'import.json');
    fs.writeFileSync(file, JSON.stringify({ [first]: 'echo one', [second]: 'echo two', ['z'.repeat(240)]: 'v' }));
    await importData('entries', file, { merge: true, force: true, global: true });
    expect(process.exitCode).toBe(1);
    const files = fs.readdirSync(tmp.storeDir).filter(f => f.endsWith('.json') && !f.startsWith('_'));
    expect(files).toEqual(['other.json']);
    expect(flattenObject(onDisk().entries)).toEqual({ other: 'o' });
  });

  it('an undo that fails keeps the flags the list gained, so the leftover is gated', async () => {
    // a.one is written as n.one, n.two cannot be, and n.one cannot be taken
    // back. The list keeps n.one's flag: restoring the old list left a copy
    // of a flagged command that ran unasked.
    seed({ entries: { a: { one: 'echo one', two: 'echo two' } }, confirm: { 'a.one': true } });
    blockWrite('n.two');
    const leftover = path.join(tmp.storeDir, 'n.one.json');
    const realUnlink = fs.unlinkSync.bind(fs);
    vi.spyOn(fs, 'unlinkSync').mockImplementation(((p: fs.PathLike) => {
      if (String(p) === leftover) throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
      return realUnlink(p);
    }) as typeof fs.unlinkSync);
    await renameEntry('a', 'n', false, undefined, true);
    vi.restoreAllMocks();
    expect(process.exitCode).toBe(1);
    const d = onDisk();
    expect(flattenObject(d.entries)).toMatchObject({ 'a.one': 'echo one', 'a.two': 'echo two', 'n.one': 'echo one' });
    expect(d.confirm['n.one']).toBe(true);
    expect(d.confirm['a.one']).toBe(true);
  });

  it('a namespace holding a leaf and an entry under it is refused, writing nothing', async () => {
    fs.mkdirSync(tmp.storeDir, { recursive: true });
    fs.writeFileSync(path.join(tmp.storeDir, 'ns.k.json'), JSON.stringify({ value: 'echo k' }));
    fs.writeFileSync(path.join(tmp.storeDir, 'ns.k.sub.json'), JSON.stringify({ value: 'echo sub' }));
    fs.writeFileSync(path.join(tmp.storeDir, 'ns.other.json'), JSON.stringify({ value: 'o' }));
    clearStoreCaches();
    const before = fs.readdirSync(tmp.storeDir).filter(f => f.endsWith('.json') && f !== '_epoch.json').sort();
    await renameEntry('ns', 'moved', false, undefined, true);
    expect(process.exitCode).toBe(1);
    const said = (console.error as ReturnType<typeof vi.fn>).mock.calls.flat().join('\n');
    expect(said).toContain("'ns.k' is stored both as an entry and as a namespace ('ns.k.sub')");
    expect(fs.readdirSync(tmp.storeDir).filter(f => f.endsWith('.json') && f !== '_epoch.json').sort()).toEqual(before);
  });
});
