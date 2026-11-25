import {
  loadConfirmKeys,
  saveConfirmKeys,
  setConfirm,
  removeConfirm,
  hasConfirm,
  removeConfirmForKey,
  moveConfirm,
  flagsGating,
  gatedAmong,
} from '../confirm';
import { keysOpeningSameEntry, entriesOpenedBy } from '../utils/entryIdentity';

vi.mock('../store', () => {
  let confirmKeys: Record<string, true> = {};
  return {
    loadConfirmMap: vi.fn(() => ({ ...confirmKeys })),
    saveConfirmMap: vi.fn((data: Record<string, true>) => { confirmKeys = { ...data }; }),
    loadConfirmMapMerged: vi.fn(() => ({ ...confirmKeys })),
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
}));

import { loadConfirmMap, saveConfirmMap, loadConfirmMapMerged } from '../store';

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
      setConfirm('commands.new');

      expect(saveConfirmMap).toHaveBeenCalled();
      const savedData = (saveConfirmMap as Mock).mock.calls[0][0];
      expect(savedData['commands.new']).toBe(true);
      expect(savedData['commands.deploy']).toBe(true);
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

    it('flagsGating: names each flag that gates the key, and the list it is in', () => {
      (loadConfirmMapMerged as Mock).mockReturnValue({ 'commands.deploy': true, 'commands.DEPLOY': true, 'other.cmd': true });
      // The global list holds only the exact spelling; the other is the project's.
      (loadConfirmMap as Mock).mockReturnValue({ 'commands.deploy': true });
      expect(flagsGating('commands.deploy')).toEqual([
        { key: 'commands.deploy', scope: 'global' },
        { key: 'commands.DEPLOY', scope: 'project' },
      ]);
      expect(flagsGating('commands.greet')).toEqual([]);
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

  // Only the flag on the renamed key itself used to move, so renaming a
  // namespace left its entries' flags behind. The caller says which moved
  // entries were gated, asked before anything moved; nothing here infers it.
  //
  // And a rename drops nothing. A flag gates by name, and the global list is
  // read in every project: the flag on a renamed key may be what gates
  // another project's entry of the same name, which the rename cannot see.
  describe('moveConfirm', () => {
    const list = (scoped: Record<string, true>) => {
      (loadConfirmMap as Mock).mockReturnValue({ ...scoped });
    };
    const saved = () => (saveConfirmMap as Mock).mock.calls[0][0] as Record<string, true>;

    it('flags the new key and leaves the old one listed', () => {
      moveConfirm([['commands.deploy', 'commands.ship']]);
      expect(saved()).toEqual({ 'commands.deploy': true, 'commands.ship': true, 'commands.rm-logs': true });
    });

    it('does that for each entry it is given, and touches no other flag', () => {
      list({ 'ops.deploy': true, 'ops.db.wipe': true, 'OPS.deploy': true, 'ops2.deploy': true });
      moveConfirm([['ops.deploy', 'jobs.deploy'], ['ops.db.wipe', 'jobs.db.wipe']]);
      expect(saved()).toEqual({
        'ops.deploy': true, 'ops.db.wipe': true, 'OPS.deploy': true, 'ops2.deploy': true,
        'jobs.deploy': true, 'jobs.db.wipe': true,
      });
    });

    it('flags the new key in the list it writes to when the flag lived in the other one', () => {
      list({});
      moveConfirm([['ops.deploy', 'ops.ship']]);
      expect(saved()).toEqual({ 'ops.ship': true });
    });

    it('writes nothing when there is nothing to add', () => {
      moveConfirm([]);
      expect(saveConfirmMap).not.toHaveBeenCalled();
      // The new key is already flagged.
      moveConfirm([['commands.rm-logs', 'commands.deploy']]);
      expect(saveConfirmMap).not.toHaveBeenCalled();
    });
  });

});
