/**
 * #268 (the `set` half): `set <key> <value> --confirm` is one store write.
 *
 * It wrote the value, then the alias, then the flag, each its own write. A
 * failure or a lock timeout after the first left the command stored and
 * ungated, the command reporting an error that did not say the value had
 * landed. Now the value, its flag and its alias are one update() on the
 * store written: all of it lands or none of it does. The store writes the
 * confirmation list first when it gains a flag, and takes back what it wrote
 * if a later file fails — so the failures below are forced on the files that
 * come after the list (the entry, the alias map) and on the list itself.
 *
 * #257: a flag-only `set --no-confirm -a` clears the flag and sets the alias
 * in one write too, so it does not leave half of itself behind on failure.
 */
import fs from 'fs';
import path from 'path';
import { flattenObject } from '../utils/objectPath';
import { clearStoreCaches } from '../store';
import { setEntry } from '../commands/entries';
import { useTempGlobalStore, onDisk, seed, entryKeys } from './helpers/interleave';
import type { UnifiedData } from '../store';

const tmp = useTempGlobalStore();
// A held lock is waited for in full (STORE_LOCK_WAIT_MS) before it fails.
const HELD_LOCK_TEST_MS = 20_000;

afterEach(() => { process.exitCode = 0; });

/** `set <key> <value> --confirm -G [-a alias]`, as the CLI calls it. */
const setFlagged = (key: string, value: string, alias?: string) => setEntry(key, value, true, false, alias, true, true);

/** Make the atomic rename onto `basename` in the store fail, as a full disk or a lost permission would. */
function failRenameOnto(basename: string): void {
  const realRename = fs.renameSync.bind(fs);
  vi.spyOn(fs, 'renameSync').mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
    if (String(to) === path.join(tmp.storeDir, basename)) throw Object.assign(new Error(`EIO: i/o error, rename '${String(to)}'`), { code: 'EIO' });
    return realRename(from, to);
  }) as typeof fs.renameSync);
}

/** Neither the entry, nor its flag, nor its alias. */
function expectNothingOf(key: string, d: UnifiedData = onDisk()): void {
  expect(entryKeys(d)).not.toContain(key);
  expect(d.confirm[key]).toBeUndefined();
  expect(Object.values(d.aliases)).not.toContain(key);
}

describe('#268: set <key> <value> --confirm is one store write', () => {
  it('a confirmation list that cannot be written: neither the entry nor the flag', async () => {
    seed({ entries: { other: 'o' } });
    failRenameOnto('_confirm.json');
    const out = await setFlagged('g.deploy', 'echo deploy');
    vi.restoreAllMocks();
    expect(out).toBeUndefined();
    expect(process.exitCode).toBe(1);
    expectNothingOf('g.deploy');
    expect(flattenObject(onDisk().entries)).toEqual({ other: 'o' });
  });

  it('an alias map that cannot be written, after the list and the entry: all of it taken back', async () => {
    seed({ entries: { other: 'o' } });
    failRenameOnto('_aliases.json');
    await setFlagged('g.deploy', 'echo deploy', 'gd');
    vi.restoreAllMocks();
    expect(process.exitCode).toBe(1);
    const d = onDisk();
    expectNothingOf('g.deploy', d);
    expect(d.aliases).toEqual({});
    expect(d.confirm).toEqual({});
    expect(fs.existsSync(path.join(tmp.storeDir, 'g.deploy.json'))).toBe(false);
  });

  it('an entry file that cannot be written: no flag, no alias', async () => {
    seed({ entries: { other: 'o' } });
    fs.mkdirSync(path.join(tmp.storeDir, 'g.deploy.json'));   // a directory where the file would go
    await setFlagged('g.deploy', 'echo deploy', 'gd');
    expect(process.exitCode).toBe(1);
    const d = onDisk();
    expect(d.confirm).toEqual({});
    expect(d.aliases).toEqual({});
  });

  it('an alias name that cannot be stored: refused before the value lands', async () => {
    seed({ entries: { other: 'o' } });
    await setFlagged('g.deploy', 'echo deploy', '_reserved');
    expect(process.exitCode).toBe(1);
    expectNothingOf('g.deploy');
    expect((console.error as ReturnType<typeof vi.fn>).mock.calls.flat().join('\n')).toContain('Invalid alias name');
  });

  it('the value, the flag and the alias land together, the flag under the key as written', async () => {
    seed({ entries: { other: 'o' } });
    expect(await setFlagged('g.deploy', 'echo deploy', 'gd')).toEqual({ key: 'g.deploy', alias: 'gd' });
    const d = onDisk();
    expect(flattenObject(d.entries)['g.deploy']).toBe('echo deploy');
    expect(d.confirm).toEqual({ 'g.deploy': true });
    expect(d.aliases).toEqual({ gd: 'g.deploy' });
    // One alias per entry, as `alias set` keeps it.
    await setFlagged('g.deploy', 'echo again', 'gd2');
    expect(onDisk().aliases).toEqual({ gd2: 'g.deploy' });
  });

  it('an entry in the way is refused, and nothing is written (#224 inside the one write)', async () => {
    seed({ entries: { g: { deploy: { sub: 'x' } } } });
    await setFlagged('g.deploy', 'echo deploy');
    expect(process.exitCode).toBe(1);
    expect(onDisk().confirm).toEqual({});
    expect(flattenObject(onDisk().entries)).toEqual({ 'g.deploy.sub': 'x' });
  });
});

/**
 * Another process holds the store lock at the `nth` time this process goes
 * for it. The lock file appears just before that attempt, so the attempt
 * waits the full STORE_LOCK_WAIT_MS and fails; it is removed afterwards.
 */
async function withLockHeldAt(nth: number, op: () => unknown): Promise<number> {
  const lockPath = `${tmp.storeDir}.lock`;
  const realOpen = fs.openSync.bind(fs);
  let acquisitions = 0;
  let held = false;
  vi.spyOn(fs, 'openSync').mockImplementation(((p: fs.PathLike, ...rest: unknown[]) => {
    if (!held && String(p) === lockPath) {
      acquisitions++;
      if (acquisitions === nth) {
        held = true;
        fs.writeFileSync(lockPath, '999999');
      }
    }
    return (realOpen as (...args: unknown[]) => number)(p, ...rest);
  }) as typeof fs.openSync);
  try {
    await op();
  } finally {
    vi.restoreAllMocks();
    if (held) fs.rmSync(lockPath, { force: true });
  }
  return acquisitions;
}

describe('#268: a lock held by another process at any step', () => {
  it('the entry and its flag land together or not at all', async () => {
    for (let nth = 1; nth <= 3; nth++) {
      clearStoreCaches();
      fs.rmSync(tmp.storeDir, { recursive: true, force: true });
      seed({ entries: { other: 'o' } });
      const acquisitions = await withLockHeldAt(nth, () => setFlagged('g.deploy', 'echo deploy', 'gd'));
      const d = onDisk();
      const stored = entryKeys(d).includes('g.deploy');
      const label = `lock held at acquisition ${nth}: ${JSON.stringify({ keys: entryKeys(d), confirm: d.confirm, aliases: d.aliases })}`;
      // Never the command without its flag, nor the flag's alias without either.
      expect(stored ? d.confirm['g.deploy'] === true && d.aliases.gd === 'g.deploy' : d.confirm['g.deploy'] === undefined && d.aliases.gd === undefined, label).toBe(true);
      if (nth === 1) expect(stored, label).toBe(false);
      if (nth > acquisitions) expect(stored, label).toBe(true);
      process.exitCode = 0;
    }
  }, HELD_LOCK_TEST_MS);
});

describe('#257: set <key> --no-confirm -a is one write', () => {
  const clearWithAlias = (key: string, alias: string) => setEntry(key, undefined, false, false, alias, false, true);

  it('an alias map that cannot be written: the flag stays', async () => {
    seed({ entries: { g: { deploy: 'echo deploy' } }, confirm: { 'g.deploy': true } });
    failRenameOnto('_aliases.json');
    await clearWithAlias('g.deploy', 'gd');
    vi.restoreAllMocks();
    expect(process.exitCode).toBe(1);
    expect(onDisk().confirm).toEqual({ 'g.deploy': true });
    expect(onDisk().aliases).toEqual({});
  });

  it('an alias name that cannot be stored: the flag stays', async () => {
    seed({ entries: { g: { deploy: 'echo deploy' } }, confirm: { 'g.deploy': true } });
    await clearWithAlias('g.deploy', '_reserved');
    expect(process.exitCode).toBe(1);
    expect(onDisk().confirm).toEqual({ 'g.deploy': true });
  });

  it('both, when both can be written', async () => {
    seed({ entries: { g: { deploy: 'echo deploy' } }, confirm: { 'g.deploy': true } });
    expect(await clearWithAlias('g.deploy', 'gd')).toEqual({ key: 'g.deploy', confirm: false, alias: 'gd' });
    expect(onDisk().confirm).toEqual({});
    expect(onDisk().aliases).toEqual({ gd: 'g.deploy' });
  });
});
