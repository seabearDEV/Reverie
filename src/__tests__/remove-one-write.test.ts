/**
 * #268 (the `remove` half): removing an entry is one store write.
 *
 * `remove` deleted the entry in one write, then dropped the aliases that
 * pointed at it in a second. A failure or a lock timeout between the two left
 * the aliases pointing at nothing, and a writer landing between them could
 * see, or lose, the half-done state. The entry and its aliases now go in one
 * update() of the store written: all of it or none of it. The CLI and MCP
 * both remove through removeValue, so each is checked here.
 */
import fs from 'fs';
import path from 'path';
import { flattenObject } from '../utils/objectPath';
import { removeValue } from '../storage';
import { removeEntry } from '../commands/entries';
import { useTempGlobalStore, onDisk, seed } from './helpers/interleave';

const tmp = useTempGlobalStore();

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = 0;
});

/** Make the atomic rename onto `basename` in the store fail, as a full disk or a lost permission would. */
function failRenameOnto(basename: string): void {
  const realRename = fs.renameSync.bind(fs);
  vi.spyOn(fs, 'renameSync').mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
    if (String(to) === path.join(tmp.storeDir, basename)) throw Object.assign(new Error(`EIO: i/o error, rename '${String(to)}'`), { code: 'EIO' });
    return realRename(from, to);
  }) as typeof fs.renameSync);
}

/** The store's commit counter: each write moves it by two. */
function epoch(): number {
  return (JSON.parse(fs.readFileSync(path.join(tmp.storeDir, '_epoch.json'), 'utf8')) as { epoch: number }).epoch;
}

const removeGlobal = (key: string) => removeEntry(key, true, true);

function seedWithAliases(): void {
  seed({
    entries: { g: { deploy: 'echo deploy', sub: { a: 'x' } }, other: 'o' },
    aliases: { gd: 'g.deploy', ga: 'g.sub.a', go: 'other' },
  });
}

describe('#268: remove takes the entry and its aliases in one store write', () => {
  it('the entry and every alias pointing at it or under it go together, in one write', async () => {
    seedWithAliases();
    const before = epoch();
    expect(await removeGlobal('g')).toEqual({ key: 'g', removed: true });
    const d = onDisk();
    expect(flattenObject(d.entries)).toEqual({ other: 'o' });
    expect(d.aliases).toEqual({ go: 'other' });
    expect(epoch() - before).toBe(2);
  });

  it('an alias map that cannot be written: the entry stays, and so do its aliases', async () => {
    seedWithAliases();
    failRenameOnto('_aliases.json');
    // The store's I/O error goes up to the command wrapper, which reports it.
    await expect(removeGlobal('g.deploy')).rejects.toThrow('EIO');
    vi.restoreAllMocks();
    const d = onDisk();
    expect(flattenObject(d.entries)['g.deploy']).toBe('echo deploy');
    expect(d.aliases).toEqual({ gd: 'g.deploy', ga: 'g.sub.a', go: 'other' });
  });

  it('removeValue (the MCP path): an alias map that cannot be written leaves the entry and its aliases', () => {
    seedWithAliases();
    failRenameOnto('_aliases.json');
    expect(() => removeValue('g.deploy', 'global')).toThrow('EIO');
    vi.restoreAllMocks();
    const d = onDisk();
    expect(flattenObject(d.entries)['g.deploy']).toBe('echo deploy');
    expect(d.aliases.gd).toBe('g.deploy');
  });

  it('removeValue drops the aliases with the entry, in one write', () => {
    seedWithAliases();
    const before = epoch();
    expect(removeValue('g.deploy', 'global')).toBe(true);
    const d = onDisk();
    expect(flattenObject(d.entries)['g.deploy']).toBeUndefined();
    expect(d.aliases).toEqual({ ga: 'g.sub.a', go: 'other' });
    expect(epoch() - before).toBe(2);
  });

  it('a key with nothing under it writes nothing; an entry with one alias, one write', async () => {
    seedWithAliases();
    const before = epoch();
    await removeGlobal('other.missing');
    expect(epoch()).toBe(before);
    await removeGlobal('other');
    expect(epoch() - before).toBe(2);
    expect(onDisk().aliases).toEqual({ gd: 'g.deploy', ga: 'g.sub.a' });
  });
});
