/**
 * #254: concurrent writers must not delete each other's entries and flags.
 *
 * Every store write is a read, a change and a write. These tests put a second
 * writer — process B, its own store instance over the same directory — at the
 * points where it can land: B commits one write just before EACH time
 * process A goes for the store lock (the lock is free then, as it would be
 * for a real second process), and one more after A last read the store and
 * before A's command starts. A's command runs through the real callers,
 * against a real store in a temp dir. See helpers/interleave.ts.
 *
 * Whatever A read before taking the lock is stale by the time it writes. The
 * rule under test: what A writes is decided from the store as it stands under
 * the lock, so every write of B's survives next to A's.
 */
import fs from 'fs';
import path from 'path';
import { flattenObject } from '../utils/objectPath';
import { clearProjectFileCache } from '../utils/paths';
import { clearStoreCaches } from '../store';
import { setConfirm, removeConfirm, removeConfirmForKey } from '../confirm';
import { setAlias, removeAlias, renameAlias, removeAliasesForKey } from '../alias';
import { removeValue } from '../storage';
import { copyEntry, renameEntry, removeEntry } from '../commands/entries';
import { importData } from '../commands/data-management';
import {
  useTempGlobalStore, otherProcess, onDisk, seed, entryKeys, interleave, survived,
  bEntry, bFlag, bAlias, bMixed, type BWrite,
} from './helpers/interleave';

const tmp = useTempGlobalStore();

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
      const bKeys = await interleave(() => removeEntry('a', true, true), bMixed);
      const d = onDisk();
      expect(bKeys.length).toBeGreaterThanOrEqual(3);
      for (const k of bKeys) expect(survived(d, k)).toBe(true);
      expect(entryKeys(d)).not.toContain('a.x');
      expect(d.aliases.ax).toBeUndefined();
      // #244: a removal leaves the removed key's flag listed.
      expect(d.confirm['a.x']).toBe(true);
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
      const bKeys = await interleave(() => renameEntry('g.x', 'h.x', false, undefined, true), bMixed);
      const d = onDisk();
      for (const k of bKeys) expect(survived(d, k)).toBe(true);
      expect(d.confirm['h.x']).toBe(true);
      expect(d.aliases.gx).toBe('h.x');
      expect(entryKeys(d)).toContain('h.x');
    });

    it('a merge import keeps the entries set meanwhile', async () => {
      seed({ entries: { old: { k: '1' } } });
      const file = path.join(tmp.root, 'import.json');
      fs.writeFileSync(file, JSON.stringify({ imported: { k: '2' } }));
      const bKeys = await interleave(() => importData('entries', file, { merge: true, force: true, global: true }), bEntry);
      const keys = entryKeys(onDisk());
      for (const k of bKeys) expect(keys).toContain(k);
      expect(keys).toEqual(expect.arrayContaining(['old.k', 'imported.k']));
    });
  });

  describe('the default scope in a project', () => {
    it('a rename re-points aliases in the project map as it stands, over the global layer', async () => {
      // In the default scope the rename reads the alias view that layers the
      // project map over the global one, and writes that view to the
      // project — global aliases included. Kept as main has it; only the
      // project layer is read again under the project store's lock.
      const projectDir = path.join(tmp.root, 'proj', '.reverie');
      fs.mkdirSync(projectDir, { recursive: true });
      const saved = { noProject: process.env.RVR_NO_PROJECT, project: process.env.RVR_PROJECT };
      delete process.env.RVR_NO_PROJECT;
      process.env.RVR_PROJECT = projectDir;
      clearProjectFileCache();
      clearStoreCaches();
      try {
        seed({ entries: { g: { k: 'gv' } }, aliases: { ga: 'ops.deploy', other: 'g.k' } });
        otherProcess(projectDir).save({ entries: { ops: { deploy: 'v' } }, aliases: { pa: 'ops.deploy' }, confirm: {} });
        clearStoreCaches();

        const bNames = await interleave(() => renameEntry('ops.deploy', 'ops.ship'), bAlias, projectDir);
        const project = onDisk(projectDir);
        for (const n of bNames) expect(project.aliases[n]).toBeDefined();
        expect(project.aliases).toMatchObject({ ga: 'ops.ship', pa: 'ops.ship', other: 'g.k' });
        expect(entryKeys(project)).toEqual(expect.arrayContaining(['ops.ship']));
        expect(onDisk().aliases).toEqual({ ga: 'ops.deploy', other: 'g.k' });
      } finally {
        if (saved.project === undefined) delete process.env.RVR_PROJECT; else process.env.RVR_PROJECT = saved.project;
        if (saved.noProject !== undefined) process.env.RVR_NO_PROJECT = saved.noProject;
        clearProjectFileCache();
      }
    });
  });

  describe('the store primitive', () => {
    it('reads a sidecar rewritten inside one mtime tick', () => {
      // A filesystem with coarse timestamps can give two writes of
      // _confirm.json one mtime. update() must not trust the cache keyed on
      // it: pinned here, so the rewrite looks unchanged by mtime.
      seed({ confirm: { 'x.a': true } });
      const confirmPath = path.join(tmp.storeDir, '_confirm.json');
      const tick = 1_700_000_000; // whole seconds round-trip to the cached mtimeMs
      fs.utimesSync(confirmPath, tick, tick);
      const a = otherProcess();
      a.load();

      const b = otherProcess();
      const d = b.load();
      d.confirm['x.b'] = true;
      b.save(d);
      fs.utimesSync(confirmPath, tick, tick);

      a.update(current => ({ ...current, confirm: { ...current.confirm, 'x.c': true } }));
      expect(onDisk().confirm).toEqual({ 'x.a': true, 'x.b': true, 'x.c': true });
    });
  });
});
