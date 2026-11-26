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

import { loadConfirmMap, saveConfirmMap, loadConfirmMapMerged, findProjectFile, updateUnderBothLocks } from '../store';

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
      expect(setConfirm('commands.new')).toMatchObject({ key: 'commands.new', globalOnly: false });

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

    describe('#255: the name it is listed under', () => {
      /** One store holding `keys` (and `unreadable` entry keys), as the transaction sees it under its lock. */
      const storeHolding = (keys: string[], unreadable: string[] = []) => {
        (updateUnderBothLocks as Mock).mockImplementationOnce((scope: string, fn: (target: unknown, other: unknown) => { confirm: Record<string, true> } | null) => {
          const next = fn({
            scope, dir: '/mock/store',
            data: { entries: {}, aliases: {}, confirm: loadConfirmMap(scope) },
            keys,
            unreadable: unreadable.map(key => ({ kind: 'entry', key, path: `/mock/store/${key}.json`, reason: 'conflict' })),
          }, undefined);
          if (next !== null) saveConfirmMap(next.confirm, scope);
        });
      };
      const listed = () => Object.keys((saveConfirmMap as Mock).mock.calls[0][0] as object).filter(k => !k.startsWith('commands.')).sort();
      afterEach(() => { (storedSpellingOf as Mock).mockReturnValue(undefined); });

      it('the exact key, when it is stored', () => {
        storeHolding(['ops.fix', 'OPS.fix']);
        expect(setConfirm('ops.fix')).toMatchObject({ key: 'ops.fix' });
        expect(listed()).toEqual(['ops.fix']);
      });

      it('the stored key whose file the spelling opens (a fold the filesystem makes)', () => {
        storeHolding(['ops.fix']);
        (storedSpellingOf as Mock).mockReturnValue('ops.fix');
        expect(setConfirm('ops.\ufb01x')).toMatchObject({ key: 'ops.fix' });
        expect(listed()).toEqual(['ops.fix']);
      });

      it('an unreadable entry is a candidate too: its file is there', () => {
        storeHolding([], ['ops.fix']);
        (storedSpellingOf as Mock).mockImplementation((_dir: string, _key: string, names: string[]) => names.includes('ops.fix') ? 'ops.fix' : undefined);
        expect(setConfirm('ops.\ufb01x')).toMatchObject({ key: 'ops.fix' });
      });

      it('the one stored key that differs only by case, where no file is shared (a case-sensitive volume)', () => {
        storeHolding(['ops.Deploy']);
        expect(setConfirm('OPS.deploy')).toMatchObject({ key: 'ops.Deploy' });
      });

      it('several stored keys differing only by case, none of them the key: the spelling typed', () => {
        storeHolding(['ops.Deploy', 'OPS.DEPLOY']);
        expect(setConfirm('ops.deploy')).toMatchObject({ key: 'ops.deploy' });
        expect(listed()).toEqual(['ops.deploy']);
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
