import {
  setAlias,
  removeAlias,
  renameAlias,
  loadAliases,
  buildKeyToAliasMap,
  resolveKey,
} from '../alias';

vi.mock('../store', () => {
  let aliases: Record<string, string> = {};
  const loadAliasMap = vi.fn(() => ({ ...aliases }));
  const saveAliasMap = vi.fn((data: Record<string, string>) => { aliases = { ...data }; });
  return {
    loadAliasMap,
    saveAliasMap,
    // #256: setConfirm's read of both stores; not used here. A throw, so a
    // call can never fall through to the real store.
    inspectBothStores: vi.fn(() => { throw new Error('inspectBothStores is not mocked in this suite'); }),
    // #254: the transactional form, over this mock's own load and save — so
    // what a change writes still shows up as a saveAliasMap call.
    updateAliasMap: vi.fn((fn: (a: Record<string, string>) => Record<string, string> | null, scope?: string) => {
      const next = fn(loadAliasMap(scope));
      if (next !== null) saveAliasMap(next, scope);
    }),
    // #279: setAlias and renameAlias write through updateStore, which hands
    // them the store's entries too. Over this mock's alias map, with no
    // entries: the change still shows up as a saveAliasMap call.
    updateStore: vi.fn((fn: (c: { entries: Record<string, unknown>; aliases: Record<string, string>; confirm: Record<string, true> }) => { aliases: Record<string, string> } | null, scope?: string) => {
      const next = fn({ entries: {}, aliases: loadAliasMap(scope), confirm: {} });
      if (next !== null) saveAliasMap(next.aliases, scope);
    }),
    // The other store's entries, read for the same check: none.
    loadEntries: vi.fn(() => ({})),
    loadAliasMapMerged: vi.fn(() => ({ ...aliases })),
    clearStoreCaches: vi.fn(() => { aliases = {}; }),
    findProjectFile: vi.fn(() => null),
    hasProjectStore: vi.fn(() => false),
    clearProjectFileCache: vi.fn(),
    // These are needed because alias.ts re-exports Scope from store
  };
});

import { loadAliasMap, saveAliasMap, loadAliasMapMerged } from '../store';

describe('Alias Management', () => {
  const originalConsoleLog = console.log;
  const originalConsoleError = console.error;

  beforeEach(() => {
    vi.clearAllMocks();
    // Set up default aliases
    const defaultAliases = {
      'prod-ip': 'server.production.ip',
      'dev-ip': 'server.development.ip'
    };
    (loadAliasMap as Mock).mockReturnValue({ ...defaultAliases });
    (loadAliasMapMerged as Mock).mockReturnValue({ ...defaultAliases });
    console.log = vi.fn();
    console.error = vi.fn();
  });

  afterEach(() => {
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
  });

  describe('loadAliases', () => {
    it('loads aliases from store (merged)', () => {
      const aliases = loadAliases();

      expect(aliases['prod-ip']).toBe('server.production.ip');
      expect(aliases['dev-ip']).toBe('server.development.ip');
      expect(loadAliasMapMerged).toHaveBeenCalled();
    });

    it('returns empty object if no aliases exist', () => {
      (loadAliasMapMerged as Mock).mockReturnValue({});

      const aliases = loadAliases();
      expect(Object.keys(aliases).length).toBe(0);
    });
  });

  describe('setAlias', () => {
    it('adds a new alias', () => {
      setAlias('db-uri', 'database.uri');

      expect(saveAliasMap).toHaveBeenCalled();
      const savedData = (saveAliasMap as Mock).mock.calls[0][0];
      expect(savedData['db-uri']).toBe('database.uri');
    });

    it('updates an existing alias', () => {
      setAlias('prod-ip', 'new.path.to.ip');

      const savedData = (saveAliasMap as Mock).mock.calls[0][0];
      expect(savedData['prod-ip']).toBe('new.path.to.ip');
    });

    // Round-2 regression: pre-fix, setAlias accepted any string for both
    // alias and target. The persistence path silently dropped some (e.g.
    // __proto__) and persisted others (e.g. empty string), and the response
    // always reported "Alias set" regardless of what actually landed.
    describe('validation gate', () => {
      it.each([
        '__proto__',
        'constructor',
        'prototype',
        '.dotleading',
        'trailing.',
        'a/b',
        '_aliases',
        '',
      ])('rejects invalid alias name %j', (badName) => {
        expect(() => setAlias(badName, 'safe.target')).toThrow(/Invalid alias name/);
        expect(saveAliasMap).not.toHaveBeenCalled();
      });

      it.each([
        '__proto__',
        'constructor',
        '.dotleading',
        '/etc/passwd',
        '_aliases',
        '',
      ])('rejects invalid alias target %j', (badTarget) => {
        expect(() => setAlias('safe_name', badTarget)).toThrow(/Invalid alias target/);
        expect(saveAliasMap).not.toHaveBeenCalled();
      });
    });
  });

  describe('removeAlias', () => {
    it('removes an existing alias', () => {
      const result = removeAlias('prod-ip');

      expect(result).toBe(true);
      expect(saveAliasMap).toHaveBeenCalled();
    });

    it('handles non-existent aliases gracefully', () => {
      (loadAliasMap as Mock).mockReturnValue({ 'prod-ip': 'server.production.ip' });

      const result = removeAlias('non-existent');
      // With no project file, falls through to global where it doesn't exist
      expect(result).toBe(false);
    });
  });

  describe('renameAlias', () => {
    it('renames an existing alias', () => {
      (loadAliasMap as Mock).mockReturnValue({
        'prod-ip': 'server.production.ip',
        'dev-ip': 'server.development.ip'
      });

      const result = renameAlias('prod-ip', 'production-ip');

      expect(result).toBe(true);
      expect(saveAliasMap).toHaveBeenCalled();
      const savedData = (saveAliasMap as Mock).mock.calls[0][0];
      expect(savedData['production-ip']).toBe('server.production.ip');
      expect(savedData['prod-ip']).toBeUndefined();
    });

    it('returns false when old name does not exist', () => {
      (loadAliasMap as Mock).mockReturnValue({});

      const result = renameAlias('nonexistent', 'new-name');
      expect(result).toBe(false);
    });

    it('returns false when new name already exists', () => {
      const result = renameAlias('prod-ip', 'dev-ip');
      expect(result).toBe(false);
    });
  });

  describe('buildKeyToAliasMap', () => {
    it('builds inverted map correctly', () => {
      const map = buildKeyToAliasMap();

      expect(map['server.production.ip']).toEqual('prod-ip');
      expect(map['server.development.ip']).toEqual('dev-ip');
    });

    it('returns empty object when no aliases exist', () => {
      (loadAliasMapMerged as Mock).mockReturnValue({});

      const map = buildKeyToAliasMap();
      expect(map).toEqual({});
    });

    it('uses provided aliases without calling loadAliases', () => {
      const preloaded = { myalias: 'target.path' };
      const map = buildKeyToAliasMap(preloaded);

      expect(map['target.path']).toEqual('myalias');
    });
  });

  describe('resolveKey', () => {
    it('returns target path when key is a known alias', () => {
      expect(resolveKey('prod-ip')).toBe('server.production.ip');
    });

    it('returns the key unchanged when it is not an alias', () => {
      expect(resolveKey('unknown-key')).toBe('unknown-key');
    });
  });

});
