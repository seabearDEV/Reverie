import {
  loadConfirmKeys,
  saveConfirmKeys,
  setConfirm,
  removeConfirm,
  hasConfirm,
  removeConfirmForKey,
  moveConfirm,
} from '../confirm';

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

  // Asking whether a key is flagged ignores case; changing the list is exact.
  // Versions up to 1.3.0 could list a flag under another spelling than the
  // entry's, and matching the exact spelling only left that entry running
  // unconfirmed. But a cascade that ignored case took the flag of an entry
  // that was never removed: `commands.*` and `Commands.*` are two namespaces.
  describe('asking ignores case', () => {
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

    it('hasConfirm: a longer or shorter key is a different entry', () => {
      expect(hasConfirm('commands.deploy.now')).toBe(false);
      expect(hasConfirm('commands')).toBe(false);
      expect(hasConfirm('commands.deplo')).toBe(false);
    });

    it('hasConfirm: only the literal true counts, under any spelling', () => {
      list({ 'commands.DEPLOY': false as unknown as true });
      expect(hasConfirm('commands.deploy')).toBe(false);
      expect(hasConfirm('commands.DEPLOY')).toBe(false);
    });

    it('hasConfirm: a key that names an Object.prototype member is not flagged', () => {
      expect(hasConfirm('constructor')).toBe(false);
      expect(hasConfirm('__proto__')).toBe(false);
    });
  });

  describe('changing the list is exact, unless the user named the key', () => {
    const list = (data: Record<string, true>) => {
      (loadConfirmMap as Mock).mockReturnValue({ ...data });
      (loadConfirmMapMerged as Mock).mockReturnValue({ ...data });
    };
    const saved = () => (saveConfirmMap as Mock).mock.calls[0][0] as Record<string, true>;

    it('removeConfirm: the user named the key, so every spelling of it goes', () => {
      list({ 'commands.deploy': true, 'commands.DEPLOY': true, 'commands.other': true });
      removeConfirm('commands.Deploy');
      expect(saved()).toEqual({ 'commands.other': true });
    });

    it('setConfirm: leaves another spelling alone — it may be another entry', () => {
      // Two entries that differ only by case can exist in a store written on
      // a case-sensitive volume. Each keeps its own flag.
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
  // namespace left its entries' flags behind. The caller says which entries
  // moved; nothing here infers it from the shape of the key.
  describe('moveConfirm', () => {
    const list = (scoped: Record<string, true>, merged: Record<string, true> = scoped) => {
      (loadConfirmMap as Mock).mockReturnValue({ ...scoped });
      (loadConfirmMapMerged as Mock).mockReturnValue({ ...merged });
    };
    const saved = () => (saveConfirmMap as Mock).mock.calls[0][0] as Record<string, true>;
    const gone = () => false;
    const remains = () => true;

    it('moves the flag of a renamed entry', () => {
      moveConfirm([['commands.deploy', 'commands.ship']], undefined, gone);
      expect(saved()).toEqual({ 'commands.ship': true, 'commands.rm-logs': true });
    });

    it('moves the flag of each entry that moved, and of no other', () => {
      list({ 'ops.deploy': true, 'ops.db.wipe': true, 'other.cmd': true });
      moveConfirm([['ops.deploy', 'jobs.deploy'], ['ops.db.wipe', 'jobs.db.wipe'], ['ops.status', 'jobs.status']], undefined, gone);
      expect(saved()).toEqual({ 'jobs.deploy': true, 'jobs.db.wipe': true, 'other.cmd': true });
    });

    it('leaves the flag of an entry that did not move, whatever its key looks like', () => {
      // `OPS.deploy` is not under `ops`, and neither is `ops2.deploy`: the
      // rename moved `ops.a` only, and says so.
      list({ 'OPS.deploy': true, 'ops2.deploy': true, 'ops.other': true });
      moveConfirm([['ops.a', 'jobs.a']], undefined, gone);
      expect(saveConfirmMap).not.toHaveBeenCalled();
    });

    it('carries a flag listed in another case than the entry, and leaves that spelling in the list', () => {
      // The old spelling is not this entry's name. It may be another entry's.
      list({ 'ops.DEPLOY': true });
      moveConfirm([['ops.deploy', 'jobs.deploy']], undefined, gone);
      expect(saved()).toEqual({ 'ops.DEPLOY': true, 'jobs.deploy': true });
    });

    it('keeps the old flag while the old key still reads', () => {
      // A rename in the project leaves a global entry of the same name where
      // it was. That entry was gated by this flag too.
      list({ 'ops.deploy': true });
      moveConfirm([['ops.deploy', 'jobs.deploy']], undefined, remains);
      expect(saved()).toEqual({ 'ops.deploy': true, 'jobs.deploy': true });
    });

    it('carries a flag that lives in the other scope, so the renamed entry stays gated', () => {
      // The gate reads the merged list. The new name is flagged in the list
      // this rename can write to; the other list is not touched.
      list({}, { 'ops.deploy': true });
      moveConfirm([['ops.deploy', 'ops.ship']], undefined, gone);
      expect(saved()).toEqual({ 'ops.ship': true });
    });

    it('writes nothing when no moved entry was flagged', () => {
      moveConfirm([['commands.greet', 'commands.hello']], undefined, gone);
      expect(saveConfirmMap).not.toHaveBeenCalled();
      moveConfirm([], undefined, gone);
      expect(saveConfirmMap).not.toHaveBeenCalled();
    });

    it('asks whether the old key still reads only for entries it is about to drop', () => {
      const stillStored = vi.fn(() => false);
      list({ 'ops.deploy': true });
      moveConfirm([['ops.deploy', 'jobs.deploy'], ['ops.status', 'jobs.status']], undefined, stillStored);
      expect(stillStored.mock.calls).toEqual([['ops.deploy']]);
    });
  });

});
