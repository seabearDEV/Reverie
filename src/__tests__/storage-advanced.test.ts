import type { Mock } from 'bun:test';
import { getValue, setValue, removeValue, getEntriesFlat } from '../storage';
import { updateEntries, updateStore, loadEntries, loadEntriesMerged } from '../store';

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
    // #254: a change is a function of the store as it stands; applied here
    // to this mock's state for the scope it names.
    updateEntries: vi.fn((fn: (entries: any, meta: Record<string, number>) => boolean | void, scope?: string) => {
      const entries = scope === 'project' ? projectEntries : globalEntries;
      const meta = scope === 'project' ? projectMeta : globalMeta;
      const nextEntries = structuredClone(entries);
      const nextMeta = { ...meta };
      if (fn(nextEntries, nextMeta) === false) return;
      Object.keys(entries).forEach(k => delete entries[k]);
      Object.assign(entries, nextEntries);
      Object.keys(meta).forEach(k => delete meta[k]);
      Object.assign(meta, nextMeta);
    }),
    // bun:test (#112): omitting these from the mock falls through to the
    // REAL store impls (live bindings preserve un-mocked exports), which
    // hit the actual filesystem. Stub them as no-ops so the slow path
    // (updateEntries) is exercised — that's what
    // the tests assert against.
    setEntryFast: vi.fn(() => false),
    getEntryFast: vi.fn(() => undefined),
    // #268: one store write of the whole state. #267: removeValue writes
    // through it. Applied here to this mock's entries and meta for the
    // scope it names, so nothing here can reach the real store through it.
    updateStore: vi.fn((fn: (current: any) => any, scope?: string) => {
      const entries = scope === 'project' ? projectEntries : globalEntries;
      const meta = scope === 'project' ? projectMeta : globalMeta;
      const next = fn({ entries: structuredClone(entries), aliases: {}, confirm: {}, _meta: { ...meta } });
      if (next === null) return;
      Object.keys(entries).forEach(k => delete entries[k]);
      Object.assign(entries, next.entries);
      Object.keys(meta).forEach(k => delete meta[k]);
      Object.assign(meta, next._meta ?? {});
    }),
    // #256: setConfirm's read of both stores; not used here. A throw, so a
    // call can never fall through to the real store.
    inspectBothStores: vi.fn(() => { throw new Error('inspectBothStores is not mocked in this suite'); }),
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
    expect((updateEntries as Mock<typeof updateEntries>)).toHaveBeenCalled();
  });

  it('setValue with project scope targets project store', () => {
    setValue('test.key', 'value', 'project');
    expect((updateEntries as Mock<typeof updateEntries>)).toHaveBeenCalledWith(expect.any(Function), 'project');
    expect(projectEntries).toEqual({ test: { key: 'value' } });
    expect(projectMeta['test.key']).toBeGreaterThan(0);
  });
});

describe('storage layer — removeValue', () => {
  it('removeValue with auto scope removes from project first', () => {
    testState.hasProject = true;
    Object.assign(projectEntries, { foo: 'bar' });
    Object.assign(globalEntries, { foo: 'global' });

    const removed = removeValue('foo');
    expect(removed).toBe(true);
    // #267: the removal is one store write that can name what it removes.
    expect((updateStore as Mock<typeof updateStore>)).toHaveBeenCalledWith(expect.any(Function), 'project');
    expect(projectEntries).toEqual({});
    expect(globalEntries).toEqual({ foo: 'global' });
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
    expect((updateStore as Mock<typeof updateStore>)).toHaveBeenCalledWith(expect.any(Function), 'global');
    expect(globalEntries).toEqual({});
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
