import {
  loadConfirmKeys,
  saveConfirmKeys,
  setConfirm,
  removeConfirm,
  hasConfirm,
  removeConfirmForKey,
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

import { loadConfirmMap, saveConfirmMap, loadConfirmMapMerged, clearStoreCaches } from '../store';

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

});
