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

  // The store compares keys without case (#216), and on a case-insensitive
  // filesystem `commands.Deploy` reads the file of `commands.deploy`. A list
  // that matched only the exact spelling let a flagged entry run unconfirmed
  // under any other one, so every operation here ignores case.
  describe('a flag belongs to its entry under any spelling of the key', () => {
    const list = (data: Record<string, true>) => {
      (loadConfirmMap as Mock).mockReturnValue({ ...data });
      (loadConfirmMapMerged as Mock).mockReturnValue({ ...data });
    };
    const saved = () => (saveConfirmMap as Mock).mock.calls[0][0] as Record<string, true>;

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

    it('removeConfirm: every spelling goes, so the requirement is really gone', () => {
      list({ 'commands.deploy': true, 'commands.DEPLOY': true, 'commands.other': true });
      removeConfirm('commands.Deploy');
      expect(saved()).toEqual({ 'commands.other': true });
    });

    it('setConfirm: replaces another spelling instead of listing the entry twice', () => {
      list({ 'commands.DEPLOY': true, 'commands.other': true });
      setConfirm('commands.deploy');
      expect(saved()).toEqual({ 'commands.deploy': true, 'commands.other': true });
    });

    it('removeConfirmForKey: the cascade ignores case, and stops at the segment boundary', () => {
      list({ 'Commands.deploy': true, 'commands.Sub.x': true, 'commandsx.deploy': true });
      removeConfirmForKey('commands');
      expect(saved()).toEqual({ 'commandsx.deploy': true });
    });
  });

  // Only the flag on the renamed key itself used to move. Renaming a
  // namespace left the flags of its entries under names that no longer
  // existed, and the renamed commands ran unconfirmed.
  describe('moveConfirm', () => {
    const list = (scoped: Record<string, true>, merged: Record<string, true> = scoped) => {
      (loadConfirmMap as Mock).mockReturnValue({ ...scoped });
      (loadConfirmMapMerged as Mock).mockReturnValue({ ...merged });
    };
    const saved = () => (saveConfirmMap as Mock).mock.calls[0][0] as Record<string, true>;

    it('moves the flag on the renamed key', () => {
      moveConfirm('commands.deploy', 'commands.ship');
      expect(saved()).toEqual({ 'commands.ship': true, 'commands.rm-logs': true });
    });

    it('moves the flag of every entry under a renamed namespace', () => {
      list({ 'ops.deploy': true, 'ops.db.wipe': true, 'other.cmd': true });
      moveConfirm('ops', 'jobs');
      expect(saved()).toEqual({ 'jobs.deploy': true, 'jobs.db.wipe': true, 'other.cmd': true });
    });

    it('leaves a key that only shares a prefix where it is', () => {
      list({ 'ops.deploy': true, 'ops2.deploy': true, 'opsx': true });
      moveConfirm('ops', 'jobs');
      expect(saved()).toEqual({ 'jobs.deploy': true, 'ops2.deploy': true, 'opsx': true });
    });

    it('carries a flag listed in another case, keeping the rest of its spelling', () => {
      list({ 'OPS.Deploy': true });
      moveConfirm('ops', 'jobs');
      expect(saved()).toEqual({ 'jobs.Deploy': true });
    });

    it('carries a flag that lives in the other scope, so the renamed entry stays gated', () => {
      // The gate reads the merged list: a flag in the global list gated the
      // project entry too. The old name stays in the list this rename cannot
      // write to; the new name is flagged in the one it can.
      list({}, { 'ops.deploy': true });
      moveConfirm('ops.deploy', 'ops.ship');
      expect(saved()).toEqual({ 'ops.ship': true });
    });

    it('writes nothing when there is no flag to move', () => {
      moveConfirm('commands.greet', 'commands.hello');
      expect(saveConfirmMap).not.toHaveBeenCalled();
    });

    it('does not cut a key at the wrong place when lower-casing changes its length', () => {
      // 'İ'.toLowerCase() is two code units. A cut at the lower-cased
      // prefix's length would drop the first letter of the next segment.
      list({ 'İps.deploy': true });
      moveConfirm('İps', 'jobs');
      expect(saved()).toEqual({ 'jobs.deploy': true });
    });
  });

});
