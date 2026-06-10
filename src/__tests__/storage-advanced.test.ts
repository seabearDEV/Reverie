import type { Mock } from 'bun:test';
import { getValue, setValue, removeValue, getEntriesFlat } from '../storage';
import { saveEntriesAndTouchMeta, saveEntriesAndRemoveMeta, loadEntries, loadEntriesMerged } from '../store';

// State accessed by both the mock factory and the tests. Was previously
// exposed as __reset/__setProjectEntries on the mocked store namespace,
// but bun:test (#112) filters mock factory exports to only those names
// already exported by the real module — non-real names like __reset get
// dropped. Hoisting the state to module scope avoids the round-trip.
const projectEntries: Record<string, any> = {};
const globalEntries: Record<string, any> = {};
const projectMeta: Record<string, number> = {};
const globalMeta: Record<string, number> = {};
const testState = { hasProject: false };

vi.mock('../store', () => {
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
    findProjectFile: vi.fn(() => testState.hasProject ? '/fake/.codexcli.json' : null),
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
    // bun:test (#112): omitting these from the mock falls through to the
    // REAL store impls (live bindings preserve un-mocked exports), which
    // hit the actual filesystem. Stub them as no-ops so the slow path
    // (loadEntries+saveEntriesAndTouchMeta) is exercised — that's what
    // the tests assert against.
    setEntryFast: vi.fn(() => false),
    getEntryFast: vi.fn(() => undefined),
    saveAliasMap: vi.fn(),
    loadAliasMap: vi.fn(() => ({})),
    loadAliasMapMerged: vi.fn(() => ({})),
    saveConfirmMap: vi.fn(),
    loadConfirmMap: vi.fn(() => ({})),
    loadConfirmMapMerged: vi.fn(() => ({})),
    saveAll: vi.fn(),
    loadMeta: vi.fn(() => ({})),
    loadMetaMerged: vi.fn(() => ({})),
    touchMeta: vi.fn(),
    removeMeta: vi.fn(),
    getStalenessTag: vi.fn(() => ''),
    STALE_DAYS: 30,
    STALE_MS: 30 * 86400000,
  };
});

vi.mock('../formatting', () => ({
  color: {
    red: (t: string) => t,
    gray: (t: string) => t,
  },
}));

function resetTestState() {
  Object.keys(projectEntries).forEach(k => delete projectEntries[k]);
  Object.keys(globalEntries).forEach(k => delete globalEntries[k]);
  Object.keys(projectMeta).forEach(k => delete projectMeta[k]);
  Object.keys(globalMeta).forEach(k => delete globalMeta[k]);
  testState.hasProject = false;
}

beforeEach(() => {
  resetTestState();
  vi.clearAllMocks();
});

describe('storage layer — scope fallthrough', () => {
  it('getValue with auto scope checks project first, then global', () => {
    testState.hasProject = true;
    Object.assign(projectEntries, { server: { ip: '10.0.0.1' } });
    Object.assign(globalEntries, { server: { ip: '192.168.1.1' } });

    expect(getValue('server.ip')).toBe('10.0.0.1');
  });

  it('getValue falls through to global when project lacks key', () => {
    testState.hasProject = true;
    Object.assign(projectEntries, {});
    Object.assign(globalEntries, { server: { ip: '192.168.1.1' } });

    expect(getValue('server.ip')).toBe('192.168.1.1');
  });

  it('getValue with explicit global scope ignores project', () => {
    testState.hasProject = true;
    Object.assign(projectEntries, { server: { ip: '10.0.0.1' } });
    Object.assign(globalEntries, { server: { ip: '192.168.1.1' } });

    expect(getValue('server.ip', 'global')).toBe('192.168.1.1');
  });

  it('getValue with explicit project scope ignores global', () => {
    testState.hasProject = true;
    Object.assign(projectEntries, {});
    Object.assign(globalEntries, { server: { ip: '192.168.1.1' } });

    expect(getValue('server.ip', 'project')).toBeUndefined();
  });

  it('getValue returns undefined when key absent from both scopes', () => {
    testState.hasProject = true;
    Object.assign(projectEntries, {});
    Object.assign(globalEntries, {});

    expect(getValue('nonexistent.key')).toBeUndefined();
  });
});

describe('storage layer — setValue', () => {
  it('setValue sets value in auto-resolved scope', () => {
    testState.hasProject = false;
    setValue('test.key', 'value');
    expect((saveEntriesAndTouchMeta as Mock<typeof saveEntriesAndTouchMeta>)).toHaveBeenCalled();
  });

  it('setValue with project scope targets project store', () => {
    setValue('test.key', 'value', 'project');
    expect((saveEntriesAndTouchMeta as Mock<typeof saveEntriesAndTouchMeta>)).toHaveBeenCalledWith(
      expect.anything(),
      'test.key',
      'project',
    );
  });
});

describe('storage layer — removeValue', () => {
  it('removeValue with auto scope removes from project first', () => {
    testState.hasProject = true;
    Object.assign(projectEntries, { foo: 'bar' });
    Object.assign(globalEntries, { foo: 'global' });

    const removed = removeValue('foo');
    expect(removed).toBe(true);
    expect((saveEntriesAndRemoveMeta as Mock<typeof saveEntriesAndRemoveMeta>)).toHaveBeenCalledWith(
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
    testState.hasProject = true;
    Object.assign(projectEntries, {});
    Object.assign(globalEntries, { foo: 'bar' });

    const removed = removeValue('foo');
    expect(removed).toBe(false);
    // Confirm the explicit-scope path still works
    expect(removeValue('foo', 'global')).toBe(true);
    expect((saveEntriesAndRemoveMeta as Mock<typeof saveEntriesAndRemoveMeta>)).toHaveBeenCalledWith(
      expect.anything(),
      'foo',
      'global',
    );
  });

  it('removeValue returns false when key does not exist anywhere', () => {
    testState.hasProject = true;
    Object.assign(projectEntries, {});
    Object.assign(globalEntries, {});

    expect(removeValue('nonexistent')).toBe(false);
  });
});

describe('storage layer — getEntriesFlat', () => {
  it('getEntriesFlat with auto scope merges project over global', () => {
    getEntriesFlat();
    // Uses loadEntriesMerged under the hood
    expect((loadEntriesMerged as Mock<typeof loadEntriesMerged>)).toHaveBeenCalled();
  });

  it('getEntriesFlat with explicit scope does not merge', () => {
    getEntriesFlat('global');
    expect((loadEntries as Mock<typeof loadEntries>)).toHaveBeenCalledWith('global');
  });
});
