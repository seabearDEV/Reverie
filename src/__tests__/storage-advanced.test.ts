import { getValue, setValue, removeValue, getEntriesFlat } from '../storage';

vi.mock('../store', () => {
  let projectEntries: Record<string, any> = {};
  let globalEntries: Record<string, any> = {};
  let projectMeta: Record<string, number> = {};
  let globalMeta: Record<string, number> = {};
  let hasProject = false;

  return {
    loadEntries: vi.fn((scope?: string) => {
      if (scope === 'project') return { ...projectEntries };
      return { ...globalEntries };
    }),
    saveEntries: vi.fn((data: any, scope?: string) => {
      if (scope === 'project') {
        Object.keys(projectEntries).forEach(k => delete projectEntries[k]);
        Object.assign(projectEntries, data);
      } else {
        Object.keys(globalEntries).forEach(k => delete globalEntries[k]);
        Object.assign(globalEntries, data);
      }
    }),
    loadEntriesMerged: vi.fn(() => ({ ...globalEntries, ...projectEntries })),
    clearStoreCaches: vi.fn(),
    findProjectFile: vi.fn(() => hasProject ? '/fake/.codexcli.json' : null),
    clearProjectFileCache: vi.fn(),
    saveEntriesAndTouchMeta: vi.fn((data: any, key: string, scope?: string) => {
      if (scope === 'project') {
        Object.keys(projectEntries).forEach(k => delete projectEntries[k]);
        Object.assign(projectEntries, data);
        projectMeta[key] = Date.now();
      } else {
        Object.keys(globalEntries).forEach(k => delete globalEntries[k]);
        Object.assign(globalEntries, data);
        globalMeta[key] = Date.now();
      }
    }),
    saveEntriesAndRemoveMeta: vi.fn((data: any, key: string, scope?: string) => {
      if (scope === 'project') {
        Object.keys(projectEntries).forEach(k => delete projectEntries[k]);
        Object.assign(projectEntries, data);
        delete projectMeta[key];
      } else {
        Object.keys(globalEntries).forEach(k => delete globalEntries[k]);
        Object.assign(globalEntries, data);
        delete globalMeta[key];
      }
    }),
    // Test helper to set up state
    __setProjectEntries: (data: Record<string, any>) => {
      Object.keys(projectEntries).forEach(k => delete projectEntries[k]);
      Object.assign(projectEntries, data);
    },
    __setGlobalEntries: (data: Record<string, any>) => {
      Object.keys(globalEntries).forEach(k => delete globalEntries[k]);
      Object.assign(globalEntries, data);
    },
    __setHasProject: (val: boolean) => { hasProject = val; },
    __reset: () => {
      Object.keys(projectEntries).forEach(k => delete projectEntries[k]);
      Object.keys(globalEntries).forEach(k => delete globalEntries[k]);
      Object.keys(projectMeta).forEach(k => delete projectMeta[k]);
      Object.keys(globalMeta).forEach(k => delete globalMeta[k]);
      hasProject = false;
    },
  };
});

vi.mock('../formatting', () => ({
  color: {
    red: (t: string) => t,
    gray: (t: string) => t,
  },
}));

const store = await import('../store') as any;

beforeEach(() => {
  store.__reset();
  vi.clearAllMocks();
});

describe('storage layer — scope fallthrough', () => {
  it('getValue with auto scope checks project first, then global', () => {
    store.__setHasProject(true);
    store.__setProjectEntries({ server: { ip: '10.0.0.1' } });
    store.__setGlobalEntries({ server: { ip: '192.168.1.1' } });

    expect(getValue('server.ip')).toBe('10.0.0.1');
  });

  it('getValue falls through to global when project lacks key', () => {
    store.__setHasProject(true);
    store.__setProjectEntries({});
    store.__setGlobalEntries({ server: { ip: '192.168.1.1' } });

    expect(getValue('server.ip')).toBe('192.168.1.1');
  });

  it('getValue with explicit global scope ignores project', () => {
    store.__setHasProject(true);
    store.__setProjectEntries({ server: { ip: '10.0.0.1' } });
    store.__setGlobalEntries({ server: { ip: '192.168.1.1' } });

    expect(getValue('server.ip', 'global')).toBe('192.168.1.1');
  });

  it('getValue with explicit project scope ignores global', () => {
    store.__setHasProject(true);
    store.__setProjectEntries({});
    store.__setGlobalEntries({ server: { ip: '192.168.1.1' } });

    expect(getValue('server.ip', 'project')).toBeUndefined();
  });

  it('getValue returns undefined when key absent from both scopes', () => {
    store.__setHasProject(true);
    store.__setProjectEntries({});
    store.__setGlobalEntries({});

    expect(getValue('nonexistent.key')).toBeUndefined();
  });
});

describe('storage layer — setValue', () => {
  it('setValue sets value in auto-resolved scope', () => {
    store.__setHasProject(false);
    setValue('test.key', 'value');
    expect(store.saveEntriesAndTouchMeta).toHaveBeenCalled();
  });

  it('setValue with project scope targets project store', () => {
    setValue('test.key', 'value', 'project');
    expect(store.saveEntriesAndTouchMeta).toHaveBeenCalledWith(
      expect.anything(),
      'test.key',
      'project',
    );
  });
});

describe('storage layer — removeValue', () => {
  it('removeValue with auto scope removes from project first', () => {
    store.__setHasProject(true);
    store.__setProjectEntries({ foo: 'bar' });
    store.__setGlobalEntries({ foo: 'global' });

    const removed = removeValue('foo');
    expect(removed).toBe(true);
    expect(store.saveEntriesAndRemoveMeta).toHaveBeenCalledWith(
      expect.anything(),
      'foo',
      'project',
    );
  });

  it('removeValue with auto scope no longer falls through to global (#99)', () => {
    // Pre-#99 removeValue with auto walked project→global. After #99 the auto
    // branch collapses to whichever scope project resolution picks (project
    // when resolvable). Removing a global-scoped entry now requires explicit
    // scope:'global'.
    store.__setHasProject(true);
    store.__setProjectEntries({});
    store.__setGlobalEntries({ foo: 'bar' });

    const removed = removeValue('foo');
    expect(removed).toBe(false);
    // Confirm the explicit-scope path still works
    expect(removeValue('foo', 'global')).toBe(true);
    expect(store.saveEntriesAndRemoveMeta).toHaveBeenCalledWith(
      expect.anything(),
      'foo',
      'global',
    );
  });

  it('removeValue returns false when key does not exist anywhere', () => {
    store.__setHasProject(true);
    store.__setProjectEntries({});
    store.__setGlobalEntries({});

    expect(removeValue('nonexistent')).toBe(false);
  });
});

describe('storage layer — getEntriesFlat', () => {
  it('getEntriesFlat with auto scope merges project over global', () => {
    const result = getEntriesFlat();
    // Uses loadEntriesMerged under the hood
    expect(store.loadEntriesMerged).toHaveBeenCalled();
  });

  it('getEntriesFlat with explicit scope does not merge', () => {
    getEntriesFlat('global');
    expect(store.loadEntries).toHaveBeenCalledWith('global');
  });
});
