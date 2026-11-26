import {
  loadConfirmKeys,
  saveConfirmKeys,
  setConfirm,
  removeConfirm,
  hasConfirm,
  removeConfirmForKey,
  flagsGating,
  gatedAmong,
} from '../confirm';
import { keysOpeningSameEntry, entriesOpenedBy, opensEntryFile, storedSpellingOf } from '../utils/entryIdentity';

vi.mock('../store', () => {
  let confirmKeys: Record<string, true> = {};
  const loadConfirmMap = vi.fn(() => ({ ...confirmKeys }));
  const saveConfirmMap = vi.fn((data: Record<string, true>) => { confirmKeys = { ...data }; });
  return {
    loadConfirmMap,
    saveConfirmMap,
    // #254: the transactional form, over this mock's own load and save — so
    // what a change writes still shows up as a saveConfirmMap call.
    updateConfirmMap: vi.fn((fn: (c: Record<string, true>) => Record<string, true> | null, scope?: string) => {
      const next = fn(loadConfirmMap(scope));
      if (next !== null) saveConfirmMap(next, scope);
    }),
    loadConfirmMapMerged: vi.fn(() => ({ ...confirmKeys })),
    // #259: setConfirm decides under both stores' locks; here one store with
    // no entries, so whether the key names one is opensEntryFile's answer.
    updateUnderBothLocks: vi.fn((scope: string, fn: (target: unknown, other: unknown) => { confirm: Record<string, true> } | null) => {
      const next = fn({ scope, dir: '/mock/store', data: { entries: {}, aliases: {}, confirm: loadConfirmMap(scope) }, keys: [], unreadable: [] }, undefined);
      if (next !== null) saveConfirmMap(next.confirm, scope);
    }),
    // #256: setConfirm decides from a read of both stores; here the one store, as the global one.
    inspectBothStores: vi.fn((fn: (project: unknown, global: unknown) => unknown) =>
      fn(undefined, { scope: 'global', dir: '/mock/store', data: { entries: {}, aliases: {}, confirm: loadConfirmMap('global') }, keys: [], unreadable: [] })),
    clearStoreCaches: vi.fn(() => { confirmKeys = {}; }),
    findProjectFile: vi.fn(() => null),
    clearProjectFileCache: vi.fn(),
  };
});

// Which keys open the same entry file is the filesystem's answer; these tests
// supply it. entryIdentity.test.ts asks a real one.
vi.mock('../utils/entryIdentity', () => ({
  keysOpeningSameEntry: vi.fn(() => []),
  entriesOpenedBy: vi.fn(() => new Map()),
  opensEntryFile: vi.fn(() => true),
  storedSpellingOf: vi.fn(() => undefined),
}));

import { loadConfirmMap, saveConfirmMap, loadConfirmMapMerged, findProjectFile, updateUnderBothLocks, inspectBothStores } from '../store';
import { StoreUnreadableError } from '../utils/unreadable';
import { LockTimeoutError } from '../utils/fileLock';

describe('Confirm Metadata', () => {
  const originalConsoleLog = console.log;
  const originalConsoleError = console.error;

  beforeEach(() => {
    vi.clearAllMocks();
    const defaultConfirm = {
      'commands.deploy': true as const,
      'commands.rm-logs': true as const,
    };
    (loadConfirmMap as Mock).mockReturnValue({ ...defaultConfirm });
    (loadConfirmMapMerged as Mock).mockReturnValue({ ...defaultConfirm });
    (keysOpeningSameEntry as Mock).mockReturnValue([]);
    (entriesOpenedBy as Mock).mockReturnValue(new Map());
    (opensEntryFile as Mock).mockReturnValue(true);
    console.log = vi.fn();
    console.error = vi.fn();
  });

  afterEach(() => {
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
  });

  describe('loadConfirmKeys', () => {
    it('loads confirm keys from store (merged)', () => {
      const keys = loadConfirmKeys();

      expect(keys['commands.deploy']).toBe(true);
      expect(keys['commands.rm-logs']).toBe(true);
    });

    it('returns empty object if no confirm keys exist', () => {
      (loadConfirmMapMerged as Mock).mockReturnValue({});

      const keys = loadConfirmKeys();
      expect(Object.keys(keys).length).toBe(0);
    });
  });

  describe('saveConfirmKeys', () => {
    it('resolves auto scope before delegating (#99)', () => {
      // Auto/undefined collapses to a concrete scope at the guard chokepoint;
      // saveConfirmMap always receives 'project' or 'global', never undefined.
      saveConfirmKeys({ 'z.key': true, 'a.key': true }, 'global');
      expect(saveConfirmMap).toHaveBeenCalledWith(
        { 'z.key': true, 'a.key': true },
        'global'
      );
    });
  });

  describe('setConfirm', () => {
    it('adds a key to confirm set', () => {
      // #255/#256: it says where the flag went — the name and the list.
      expect(setConfirm('commands.new')).toMatchObject({ key: 'commands.new' });

      expect(saveConfirmMap).toHaveBeenCalled();
      const savedData = (saveConfirmMap as Mock).mock.calls[0][0];
      expect(savedData['commands.new']).toBe(true);
      expect(savedData['commands.deploy']).toBe(true);
    });

    it('#259: writes nothing, and says so, when the key names no entry where the flag is written', () => {
      // The caller looked the key up before any lock; by the time the list is
      // written, a rename may have moved the entry.
      (opensEntryFile as Mock).mockReturnValue(false);
      expect(setConfirm('commands.new')).toBe(false);
      expect(saveConfirmMap).not.toHaveBeenCalled();
    });

    describe('#255, #256: the list and the name, decided from a read of both stores', () => {
      // A project store (or none) and the global one, as both the read
      // (inspectBothStores) and the write under the locks see them. Which
      // spelling opens which file is the filesystem's answer: here a key
      // opens a store's file when it is one of its keys or listed in `folds`.
      interface Side { keys?: string[]; unreadable?: string[]; folds?: Record<string, string>; confirm?: Record<string, true> }
      type Fn = (a: unknown, b: unknown) => { confirm: Record<string, true> } | null;
      const view = (scope: 'project' | 'global', side: Side) => ({
        scope, dir: `/mock/${scope}`,
        data: { entries: {}, aliases: {}, confirm: { ...(side.confirm ?? {}) } },
        keys: side.keys ?? [],
        unreadable: (side.unreadable ?? []).map(key => ({ kind: 'entry', key, path: `/mock/${scope}/${key}.json`, reason: 'conflict' })),
      });
      let written: { scope: string; confirm: Record<string, true> }[] = [];
      let writes: string[] = [];
      const stores = (project: Side | undefined, global: Side, opts: { globalWrite?: Error; beforeWrite?: (scope: string) => void } = {}) => {
        written = [];
        writes = [];
        const sides: Record<string, Side | undefined> = { '/mock/project': project, '/mock/global': global };
        (opensEntryFile as Mock).mockImplementation((dir: string, key: string) => {
          const side = sides[dir];
          return !!side && ([...(side.keys ?? []), ...(side.unreadable ?? [])].includes(key) || Object.hasOwn(side.folds ?? {}, key));
        });
        (storedSpellingOf as Mock).mockImplementation((dir: string, key: string, names: string[]) => names.includes(key) ? undefined : sides[dir]?.folds?.[key]);
        (inspectBothStores as Mock).mockImplementation((fn: Fn) => fn(project && view('project', project), view('global', global)));
        (updateUnderBothLocks as Mock).mockImplementation((scope: string, fn: Fn) => {
          writes.push(scope);
          opts.beforeWrite?.(scope);
          if (scope === 'global' && opts.globalWrite) throw opts.globalWrite;
          const target = scope === 'project' && project ? view('project', project) : view('global', global);
          const other = target.scope === 'project' ? view('global', global) : project && view('project', project);
          const next = fn(target, other);
          if (next !== null) written.push({ scope: target.scope, confirm: next.confirm });
        });
      };
      const errno = (code: string) => Object.assign(new Error(`${code}: permission denied, open '/mock/global/_epoch.json.1.tmp'`), { code });
      afterEach(() => {
        (storedSpellingOf as Mock).mockImplementation(() => undefined);
        (inspectBothStores as Mock).mockImplementation((fn: Fn) =>
          fn(undefined, { scope: 'global', dir: '/mock/store', data: { entries: {}, aliases: {}, confirm: loadConfirmMap('global') }, keys: [], unreadable: [] }));
        (updateUnderBothLocks as Mock).mockImplementation((scope: string, fn: Fn) => {
          const next = fn({ scope, dir: '/mock/store', data: { entries: {}, aliases: {}, confirm: loadConfirmMap(scope) }, keys: [], unreadable: [] }, undefined);
          if (next !== null) saveConfirmMap(next.confirm, scope);
        });
      });

      it('the exact key, when it is stored', () => {
        stores(undefined, { keys: ['ops.fix', 'OPS.fix'] });
        expect(setConfirm('ops.fix')).toMatchObject({ key: 'ops.fix' });
        expect(written).toEqual([{ scope: 'global', confirm: { 'ops.fix': true } }]);
      });

      it('the stored key whose file the spelling opens (a fold the filesystem makes)', () => {
        stores(undefined, { keys: ['ops.fix'], folds: { 'ops.\ufb01x': 'ops.fix' } });
        expect(setConfirm('ops.\ufb01x')).toMatchObject({ key: 'ops.fix' });
        expect(written).toEqual([{ scope: 'global', confirm: { 'ops.fix': true } }]);
      });

      it('an unreadable entry is a candidate too: its file is there', () => {
        stores(undefined, { unreadable: ['ops.fix'], folds: { 'ops.\ufb01x': 'ops.fix' } });
        expect(setConfirm('ops.\ufb01x')).toMatchObject({ key: 'ops.fix' });
      });

      it('the one stored key that differs only by case, where no file is shared (a case-sensitive volume)', () => {
        stores(undefined, { keys: ['ops.Deploy'] });
        expect(setConfirm('OPS.deploy')).toMatchObject({ key: 'ops.Deploy' });
      });

      it('several stored keys differing only by case, none of them the key: the spelling typed', () => {
        stores(undefined, { keys: ['ops.Deploy', 'OPS.DEPLOY'] });
        expect(setConfirm('ops.deploy')).toMatchObject({ key: 'ops.deploy' });
        expect(written).toEqual([{ scope: 'global', confirm: { 'ops.deploy': true } }]);
      });

      describe('the two stores spell the entry differently: every spelling is listed (review F2, N1)', () => {
        // The project holds `opſ.start`, the global store `ops.start`: one
        // file each, which APFS lets either name open. Where nothing folds
        // (a case-sensitive volume, Linux) each name opens only its own, so a
        // flag under one gates nothing of the other: both are listed, the
        // written store's first.
        const LONG = 'op\u017f.start';
        const twins = () => stores(
          { keys: [LONG], folds: { 'ops.start': LONG } },
          { keys: ['ops.start'], folds: { [LONG]: 'ops.start' } },
        );

        it('-G with the global store\'s name (F2)', () => {
          twins();
          expect(setConfirm('ops.start', 'global')).toEqual({ key: 'ops.start', also: [LONG], scope: 'global' });
          expect(written).toEqual([{ scope: 'global', confirm: { 'ops.start': true, [LONG]: true } }]);
        });

        it('-G with the project\'s name (N1)', () => {
          twins();
          expect(setConfirm(LONG, 'global')).toEqual({ key: 'ops.start', also: [LONG], scope: 'global' });
          expect(written).toEqual([{ scope: 'global', confirm: { 'ops.start': true, [LONG]: true } }]);
        });

        it('without -G, the global store\'s name: the project list gets both (N1)', () => {
          twins();
          expect(setConfirm('ops.start')).toEqual({ key: LONG, also: ['ops.start'], scope: 'project' });
          expect(written).toEqual([{ scope: 'project', confirm: { [LONG]: true, 'ops.start': true } }]);
        });

        it('one already listed: the other is added', () => {
          stores(
            { keys: [LONG], folds: { 'ops.start': LONG } },
            { keys: ['ops.start'], folds: { [LONG]: 'ops.start' }, confirm: { 'ops.start': true } },
          );
          expect(setConfirm(LONG, 'global')).toEqual({ key: 'ops.start', also: [LONG], scope: 'global' });
          expect(written).toEqual([{ scope: 'global', confirm: { 'ops.start': true, [LONG]: true } }]);
        });

        it('names that differ only by case are listed once', () => {
          stores({ keys: ['ops.Deploy'], folds: { 'ops.deploy': 'ops.Deploy' } }, { keys: ['ops.deploy'] });
          expect(setConfirm('ops.deploy')).toEqual({ key: 'ops.Deploy', scope: 'project' });
        });
      });

      it('another store\'s spelling only when the written one names no entry: -G on a project entry', () => {
        stores({ keys: ['ops.fix'], folds: { 'ops.\ufb01x': 'ops.fix' } }, { keys: [] });
        expect(setConfirm('ops.\ufb01x', 'global')).toMatchObject({ key: 'ops.fix', scope: 'global' });
      });

      it('#256: an entry stored only in the global store goes in the global list; only that store is written', () => {
        stores({ keys: ['other.x'] }, { keys: ['ops.deploy'] });
        expect(setConfirm('ops.deploy')).toEqual({ key: 'ops.deploy', scope: 'global', moved: 'globalOnly' });
        expect(writes).toEqual(['global']);
        expect(written).toEqual([{ scope: 'global', confirm: { 'ops.deploy': true } }]);
      });

      it('#256: a project entry, alone or over a global one, takes the list asked for', () => {
        stores({ keys: ['ops.deploy'] }, { keys: ['ops.deploy'] });
        expect(setConfirm('ops.deploy')).toEqual({ key: 'ops.deploy', scope: 'project' });
        expect(writes).toEqual(['project']);
        stores({ keys: ['ops.deploy'] }, { keys: [] });
        expect(setConfirm('ops.deploy', 'global')).toEqual({ key: 'ops.deploy', scope: 'global' });
      });

      it('the key opens the global entry and the project holds only another case of it: the global list, said why', () => {
        stores({ keys: ['OPS.deploy'] }, { keys: ['ops.deploy'] });
        expect(setConfirm('ops.deploy')).toEqual({ key: 'ops.deploy', scope: 'global', moved: 'opensGlobal' });
      });

      it.each(['EACCES', 'EPERM', 'EROFS'])('the global store cannot be written (%s): the project list, said so (review F1)', (code) => {
        stores({ keys: [] }, { keys: ['ops.deploy'] }, { globalWrite: errno(code) });
        expect(setConfirm('ops.deploy')).toEqual({ key: 'ops.deploy', scope: 'project', moved: 'globalUnwritable' });
        expect(writes).toEqual(['global', 'project']);
        expect(written).toEqual([{ scope: 'project', confirm: { 'ops.deploy': true } }]);
      });

      it('with -G it fails as asked: no fallback to the project list', () => {
        stores({ keys: [] }, { keys: ['ops.deploy'] }, { globalWrite: errno('EACCES') });
        expect(() => setConfirm('ops.deploy', 'global')).toThrow('EACCES');
        expect(written).toEqual([]);
      });

      it('an unreadable global list, seen in the read: the project list, naming the file, nothing opened in the global store (N2)', () => {
        const global: Side & { unreadableList?: boolean } = { keys: ['ops.deploy'] };
        stores({ keys: [] }, global);
        (inspectBothStores as Mock).mockImplementation((fn: Fn) => fn(view('project', { keys: [] }), {
          ...view('global', global),
          unreadable: [{ kind: 'confirm', path: '/mock/global/_confirm.json', reason: 'conflict' }],
        }));
        expect(setConfirm('ops.deploy')).toEqual({ key: 'ops.deploy', scope: 'project', moved: 'globalUnreadable', detail: '/mock/global/_confirm.json' });
        expect(writes).toEqual(['project']);
        expect(written).toEqual([{ scope: 'project', confirm: { 'ops.deploy': true } }]);
      });

      it('an unreadable global list found by the write: the same (N2)', () => {
        const unreadable = new StoreUnreadableError([{ kind: 'confirm', path: '/mock/global/_confirm.json', reason: 'conflict' }], 'write');
        stores({ keys: [] }, { keys: ['ops.deploy'] }, { globalWrite: unreadable });
        expect(setConfirm('ops.deploy')).toEqual({ key: 'ops.deploy', scope: 'project', moved: 'globalUnreadable', detail: '/mock/global/_confirm.json' });
        expect(written).toEqual([{ scope: 'project', confirm: { 'ops.deploy': true } }]);
      });

      it.each(['ENOSPC', 'EIO'])('any failure of the global write (%s): the project list, with the error (N2)', (code) => {
        stores({ keys: [] }, { keys: ['ops.deploy'] }, { globalWrite: errno(code) });
        expect(setConfirm('ops.deploy')).toMatchObject({ key: 'ops.deploy', scope: 'project', moved: 'globalUnwritable', detail: expect.stringContaining(code) });
        expect(written).toEqual([{ scope: 'project', confirm: { 'ops.deploy': true } }]);
      });

      it('a lock another process holds is not a fallback: it fails as any write does', () => {
        stores({ keys: [] }, { keys: ['ops.deploy'] }, { globalWrite: new LockTimeoutError('Unable to acquire lock') });
        expect(() => setConfirm('ops.deploy')).toThrow(LockTimeoutError);
        expect(written).toEqual([]);
      });

      it('with -G an unreadable global list still refuses', () => {
        const unreadable = new StoreUnreadableError([{ kind: 'confirm', path: '/mock/global/_confirm.json', reason: 'conflict' }], 'write');
        stores({ keys: [] }, { keys: ['ops.deploy'] }, { globalWrite: unreadable });
        expect(() => setConfirm('ops.deploy', 'global')).toThrow(StoreUnreadableError);
        expect(written).toEqual([]);
      });

      it('already listed where it goes: answered from the read, nothing opened for writing', () => {
        stores({ keys: [] }, { keys: ['ops.deploy'], confirm: { 'ops.deploy': true } }, { globalWrite: errno('EACCES') });
        expect(setConfirm('ops.deploy')).toEqual({ key: 'ops.deploy', scope: 'global', moved: 'globalOnly' });
        expect(writes).toEqual([]);
      });

      it('the project\'s entry gone by the time its list is written: decided again, and the global list gets it', () => {
        const project: Side = { keys: ['ops.deploy'] };
        stores(project, { keys: ['ops.deploy'] }, { beforeWrite: scope => { if (scope === 'project') project.keys = []; } });
        expect(setConfirm('ops.deploy')).toEqual({ key: 'ops.deploy', scope: 'global', moved: 'globalOnly' });
        expect(writes).toEqual(['project', 'global']);
        expect(written).toEqual([{ scope: 'global', confirm: { 'ops.deploy': true } }]);
      });
    });
  });

  describe('removeConfirm', () => {
    it('removes a key from confirm set', () => {
      removeConfirm('commands.deploy');

      expect(saveConfirmMap).toHaveBeenCalled();
      const savedData = (saveConfirmMap as Mock).mock.calls[0][0];
      expect(savedData['commands.deploy']).toBeUndefined();
      expect(savedData['commands.rm-logs']).toBe(true);
    });

    it('#257: a name every object has is not a flag (constructor, toString)', () => {
      for (const key of ['constructor', 'toString', 'hasOwnProperty']) {
        expect(removeConfirm(key), key).toBe(false);
      }
      expect(saveConfirmMap).not.toHaveBeenCalled();
    });

    it('does nothing when key is not in confirm set', () => {
      removeConfirm('nonexistent.key');

      // With no project file, checks global scope only
      // nonexistent.key is not in the mock, so no save
      expect(saveConfirmMap).not.toHaveBeenCalled();
    });
  });

  describe('hasConfirm', () => {
    it('returns true for a key with confirm set', () => {
      expect(hasConfirm('commands.deploy')).toBe(true);
    });

    it('returns false for a key without confirm', () => {
      expect(hasConfirm('commands.greet')).toBe(false);
    });
  });

  describe('removeConfirmForKey', () => {
    it('removes the exact key', () => {
      removeConfirmForKey('commands.deploy');

      expect(saveConfirmMap).toHaveBeenCalled();
      const savedData = (saveConfirmMap as Mock).mock.calls[0][0];
      expect(savedData['commands.deploy']).toBeUndefined();
      expect(savedData['commands.rm-logs']).toBe(true);
    });

    it('cascade-deletes children of a parent key', () => {
      removeConfirmForKey('commands');

      expect(saveConfirmMap).toHaveBeenCalled();
      const savedData = (saveConfirmMap as Mock).mock.calls[0][0];
      expect(Object.keys(savedData).length).toBe(0);
    });

    it('does nothing when no matching keys exist', () => {
      removeConfirmForKey('nonexistent');

      // Global store is checked; no matching keys, no save
      expect(saveConfirmMap).not.toHaveBeenCalled();
    });
  });

  // Asking is generous; changing the list is exact.
  //
  // A key maps to its filename, and on a filesystem that folds names another
  // spelling opens the flagged entry's file: matching the exact spelling only
  // let that command run unasked. But anything that drops a flag by a looser
  // match than its own name takes the flag of an entry that is still there.
  describe('asking: a key is gated by its name, case aside, or by a name that opens the same entry file', () => {
    const list = (data: Record<string, true>) => {
      (loadConfirmMap as Mock).mockReturnValue({ ...data });
      (loadConfirmMapMerged as Mock).mockReturnValue({ ...data });
    };

    it('hasConfirm: a key spelled in another case is the flagged entry', () => {
      expect(hasConfirm('commands.Deploy')).toBe(true);
      expect(hasConfirm('COMMANDS.DEPLOY')).toBe(true);
    });

    it('hasConfirm: a flag listed in another case than the entry still gates it', () => {
      list({ 'commands.DEPLOY': true });
      expect(hasConfirm('commands.deploy')).toBe(true);
    });

    it('hasConfirm: a spelling no string comparison would match is gated when it opens the flagged file', () => {
      // U+017F LONG S: APFS opens `commands.deploy` for it; toLowerCase does not fold it.
      const longS = `command${String.fromCodePoint(0x17f)}.deploy`;
      expect(longS.toLowerCase()).not.toBe('commands.deploy');
      expect(hasConfirm(longS)).toBe(false);
      (keysOpeningSameEntry as Mock).mockImplementation((key: string, flagged: string[]) =>
        key === longS ? flagged.filter(k => k === 'commands.deploy') : []);
      expect(hasConfirm(longS)).toBe(true);
      // Only flagged keys are offered as candidates: an unflagged entry's file gates nothing.
      expect((keysOpeningSameEntry as Mock).mock.calls.at(-1)).toEqual([longS, ['commands.deploy', 'commands.rm-logs']]);
    });

    it('gatedAmong: the same answer for many keys, by name and by file', () => {
      const longS = `command${String.fromCodePoint(0x17f)}.deploy`;
      (entriesOpenedBy as Mock).mockImplementation((keys: string[]) =>
        new Map(keys.filter(k => k === longS).map(k => [k, ['commands.deploy']])));
      const gated = gatedAmong(['commands.deploy', 'COMMANDS.RM-LOGS', longS, 'commands.greet']);
      expect([...gated].sort()).toEqual(['COMMANDS.RM-LOGS', 'commands.deploy', longS].sort());
      // Keys matched by name are not looked up by file; the rest are, against the flagged keys.
      expect((entriesOpenedBy as Mock).mock.calls.at(-1)).toEqual([[longS, 'commands.greet'], ['commands.deploy', 'commands.rm-logs']]);
    });

    it('gatedAmong: nothing is gated, and no file is looked at, when no flag is listed', () => {
      list({});
      expect(gatedAmong(['commands.deploy']).size).toBe(0);
      expect(entriesOpenedBy).not.toHaveBeenCalled();
    });

    it('hasConfirm: a longer or shorter key is a different entry', () => {
      expect(hasConfirm('commands.deploy.now')).toBe(false);
      expect(hasConfirm('commands')).toBe(false);
      expect(hasConfirm('commands.deplo')).toBe(false);
    });

    it('hasConfirm: only the literal true counts, by name or by file', () => {
      list({ 'commands.DEPLOY': false as unknown as true });
      (keysOpeningSameEntry as Mock).mockImplementation((_key: string, flagged: string[]) => flagged);
      expect(hasConfirm('commands.deploy')).toBe(false);
      expect(hasConfirm('commands.DEPLOY')).toBe(false);
    });

    it('hasConfirm: a key that names an Object.prototype member is not flagged', () => {
      expect(hasConfirm('constructor')).toBe(false);
      expect(hasConfirm('__proto__')).toBe(false);
    });

    /** A project list and a global list, each as given. */
    const twoLists = (project: Record<string, true>, global: Record<string, true>) => {
      (findProjectFile as Mock).mockReturnValue('/mock/project/.reverie');
      (loadConfirmMap as Mock).mockImplementation((scope?: string) => ({ ...(scope === 'project' ? project : global) }));
      (loadConfirmMapMerged as Mock).mockReturnValue({ ...global, ...project });
    };
    afterEach(() => {
      (findProjectFile as Mock).mockReturnValue(null);
      (loadConfirmMap as Mock).mockImplementation(() => ({}));
    });

    it('flagsGating: names each flag that gates the key, and the list it is in', () => {
      // The global list holds only the exact spelling; the other is the project's.
      twoLists({ 'commands.DEPLOY': true, 'other.cmd': true }, { 'commands.deploy': true });
      expect(flagsGating('commands.deploy')).toEqual([
        { key: 'commands.DEPLOY', scope: 'project' },
        { key: 'commands.deploy', scope: 'global' },
      ]);
      expect(flagsGating('commands.greet')).toEqual([]);
    });

    it('flagsGating: a name flagged in both lists is named in both (#257)', () => {
      // Merged into one map, the global list was the only one named: clearing
      // it from there left the project's, and the command failed again.
      twoLists({ 'ops.deploy': true }, { 'ops.deploy': true });
      expect(flagsGating('OPS.DEPLOY')).toEqual([
        { key: 'ops.deploy', scope: 'project' },
        { key: 'ops.deploy', scope: 'global' },
      ]);
    });
  });

  describe('changing the list is exact', () => {
    const list = (data: Record<string, true>) => {
      (loadConfirmMap as Mock).mockReturnValue({ ...data });
      (loadConfirmMapMerged as Mock).mockReturnValue({ ...data });
    };
    const saved = () => (saveConfirmMap as Mock).mock.calls[0][0] as Record<string, true>;

    it('removeConfirm: takes the name it is given, and leaves another spelling — it may be another entry', () => {
      // Two entries that differ only by case can exist in a store written on
      // a case-sensitive volume, each with its own flag.
      list({ 'a.b': true, 'a.B': true, 'other': true });
      expect(removeConfirm('a.b')).toBe(true);
      expect(saved()).toEqual({ 'a.B': true, 'other': true });
    });

    it('removeConfirm: writes nothing when the name is not listed, whatever else would gate the key', () => {
      list({ 'commands.DEPLOY': true });
      (keysOpeningSameEntry as Mock).mockImplementation((_key: string, flagged: string[]) => flagged);
      expect(removeConfirm('commands.deploy')).toBe(false);
      expect(saveConfirmMap).not.toHaveBeenCalled();
    });

    it('setConfirm: leaves another spelling alone', () => {
      list({ 'a.b': true });
      setConfirm('a.B');
      expect(saved()).toEqual({ 'a.b': true, 'a.B': true });
    });

    it('removeConfirmForKey: takes the flag of the removed key only, not of its case twin', () => {
      list({ 'a.b': true, 'a.B': true });
      removeConfirmForKey('a.B');
      expect(saved()).toEqual({ 'a.b': true });
      expect(hasConfirm('a.b')).toBe(true);
    });

    it('removeConfirmForKey: a namespace spelled in another case is another namespace', () => {
      list({ 'commands.build': true, 'Commands.deploy': true, 'commandsx.deploy': true });
      removeConfirmForKey('commands');
      expect(saved()).toEqual({ 'Commands.deploy': true, 'commandsx.deploy': true });
    });
  });

});
