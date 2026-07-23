 

type ToolHandler = (params: any) => Promise<any>;
// Was vi.hoisted (#112) — bun:test has no equivalent, but doesn't need
// one because vi.mock factories run in source order, after this binding.
const toolHandlers: Record<string, ToolHandler> = {};
const mockExecSync = vi.fn();
const mockFiles: Record<string, boolean> = {};
const mockWrittenFiles: Record<string, string> = {};
const mockData: Record<string, any> = {};
const mockAliases: Record<string, string> = {};
const mockConfig: Record<string, any> = { colors: true, theme: 'default' };
const mockConfirmKeys: Record<string, true> = {};
const mockMetaData: Record<string, number> = {};

vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => {
  class MockMcpServer {
    tool = vi.fn((name: string, _desc: string, _schema: any, handler?: ToolHandler) => {
      // Handle both 3-arg (no schema) and 4-arg overloads
      const fn = handler ?? _schema;
      toolHandlers[name] = fn;
    });
    connect = vi.fn().mockResolvedValue(undefined as never);
  }
  return { McpServer: MockMcpServer };
});

vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: vi.fn(),
}));

// Mock child_process
vi.mock('child_process', () => ({
  execSync: (...args: any[]) => mockExecSync(...args),
  spawn: vi.fn(),
  spawnSync: vi.fn(() => ({ status: 0, stdout: '', stderr: '' })),
}));

// Mock fs — track written files
vi.mock('fs', () => {
  const mock = {
    existsSync: vi.fn((p: string) => mockFiles[p] === true),
    writeFileSync: vi.fn((p: string, content: string) => {
      mockWrittenFiles[p] = content;
    }),
    renameSync: vi.fn((src: string, dest: string) => {
      if (mockWrittenFiles[src] !== undefined) {
        mockWrittenFiles[dest] = mockWrittenFiles[src];
        delete mockWrittenFiles[src];
      }
    }),
    statSync: vi.fn(() => ({ mtimeMs: Date.now() })),
    readFileSync: vi.fn(() => JSON.stringify({ entries: {}, aliases: {}, confirm: {} })),
    mkdirSync: vi.fn(),
    openSync: vi.fn(() => 3),
    readSync: vi.fn(() => 0),
    writeSync: vi.fn(),
    closeSync: vi.fn(),
    unlinkSync: vi.fn(),
    appendFile: vi.fn((_p: string, _data: string, cb: (err: NodeJS.ErrnoException | null) => void) => { cb(null); }),
    constants: { O_CREAT: 0x40, O_EXCL: 0x80, O_WRONLY: 0x01 },
  };
  return { default: mock, ...mock };
});

// Mock storage — helpers for nested dot-path operations
function getNestedMock(obj: any, path: string): any {
  return path.split('.').reduce((o, k) => (o ? o[k] : undefined), obj);
}
function setNestedMock(obj: any, path: string, value: any): void {
  const parts = path.split('.');
  const lastIndex = parts.length - 1;
  let cur = obj;
  for (let i = 0; i < lastIndex; i++) {
    const key = parts[i];
    // Prevent prototype pollution via unsafe path segments
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      return;
    }
    if (!cur[key] || typeof cur[key] !== 'object') cur[key] = {};
    cur = cur[key];
  }
  const lastKey = parts[lastIndex];
  if (lastKey === '__proto__' || lastKey === 'constructor' || lastKey === 'prototype') {
    return;
  }
  cur[lastKey] = value;
}
function flattenMock(obj: any, prefix = ''): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'object' && v !== null) Object.assign(result, flattenMock(v, key));
    else result[key] = String(v);
  }
  return result;
}
function removeNestedMock(obj: any, path: string): boolean {
  const parts = path.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!cur[parts[i]]) return false;
    cur = cur[parts[i]];
  }
  if (cur[parts[parts.length - 1]] === undefined) return false;
  delete cur[parts[parts.length - 1]];
  return true;
}
// Pre-load real ../storage via createRequire BEFORE vi.mock registers,
// to grab the real validateImportEntries (#75 sentinel guard + key-safety
// checks). bun:test runs vi.mock in source order, so this captures the
// unmocked module — vitest hoists vi.mock above all source-order code,
// so this pattern is bun-only post-port.
import { createRequire } from 'node:module';
const _requireForStorage = createRequire(import.meta.url);
const _realStorage = _requireForStorage('../storage') as typeof import('../storage');

vi.mock('../storage', () => {
  return {
    loadData: vi.fn(() => ({ ...mockData })),
    saveData: vi.fn((d: any) => {
      Object.keys(mockData).forEach(k => delete mockData[k]);
      Object.assign(mockData, d);
    }),
    getValue: vi.fn((key: string) => getNestedMock(mockData, key)),
    setValue: vi.fn((key: string, value: string) => setNestedMock(mockData, key, value)),
    removeValue: vi.fn((key: string) => removeNestedMock(mockData, key)),
    getEntriesFlat: vi.fn(() => flattenMock(mockData)),
    validateImportEntries: _realStorage.validateImportEntries,
    validateImportAliases: vi.fn(),
    validateImportConfirm: vi.fn(),
  };
});

// Mock alias
vi.mock('../alias', () => ({
  loadAliases: vi.fn(() => ({ ...mockAliases })),
  saveAliases: vi.fn((a: any) => {
    Object.keys(mockAliases).forEach(k => delete mockAliases[k]);
    Object.assign(mockAliases, a);
  }),
  setAlias: vi.fn((alias: string, path: string) => {
    // Enforce one alias per entry
    for (const [existing, target] of Object.entries(mockAliases)) {
      if (target === path && existing !== alias) delete mockAliases[existing];
    }
    mockAliases[alias] = path;
  }),
  resolveKey: vi.fn((k: string) => {
    const aliases = { ...mockAliases };
    return aliases[k] ?? k;
  }),
  buildKeyToAliasMap: vi.fn(() => ({})),
  removeAlias: vi.fn((alias: string) => {
    if (!(alias in mockAliases)) return false;
    delete mockAliases[alias];
    return true;
  }),
  removeAliasesForKey: vi.fn(),
  renameAlias: vi.fn((oldName: string, newName: string) => {
    if (!(oldName in mockAliases)) return false;
    if (newName in mockAliases) return false;
    mockAliases[newName] = mockAliases[oldName];
    delete mockAliases[oldName];
    return true;
  }),
}));

// Mock confirm
vi.mock('../confirm', () => ({
  hasConfirm: vi.fn((key: string) => mockConfirmKeys[key] === true),
  setConfirm: vi.fn((key: string) => { mockConfirmKeys[key] = true; }),
  removeConfirm: vi.fn((key: string) => { delete mockConfirmKeys[key]; }),
  loadConfirmKeys: vi.fn(() => ({ ...mockConfirmKeys })),
  saveConfirmKeys: vi.fn((c: any) => {
    Object.keys(mockConfirmKeys).forEach(k => delete mockConfirmKeys[k]);
    Object.assign(mockConfirmKeys, c);
  }),
  removeConfirmForKey: vi.fn(),
}));

vi.mock('../utils/paths', () => ({
  ensureDataDirectoryExists: vi.fn(),
  getAliasFilePath: vi.fn(() => '/mock/aliases.json'),
  getConfigFilePath: vi.fn(() => '/mock/config.json'),
  getConfirmFilePath: vi.fn(() => '/mock/confirm.json'),
  getUnifiedDataFilePath: vi.fn(() => '/mock/data.json'),
  getDataDirectory: vi.fn(() => '/mock'),
  getGlobalStoreDirPath: vi.fn(() => '/mock/store'),
  findProjectFile: vi.fn(() => null),
  findProjectStoreDir: vi.fn(() => null),
  clearProjectFileCache: vi.fn(),
}));

vi.mock('../store', () => ({
  findProjectFile: vi.fn(() => null),
  clearProjectFileCache: vi.fn(),
  clearStoreCaches: vi.fn(),
  loadEntries: vi.fn(() => ({ ...mockData })),
  saveEntries: vi.fn((d: any) => {
    Object.keys(mockData).forEach(k => delete mockData[k]);
    Object.assign(mockData, d);
  }),
  saveAll: vi.fn((sections: { entries?: any; aliases?: any; confirm?: any }) => {
    if (sections.entries !== undefined) {
      Object.keys(mockData).forEach(k => delete mockData[k]);
      Object.assign(mockData, sections.entries);
    }
    if (sections.aliases !== undefined) {
      Object.keys(mockAliases).forEach(k => delete mockAliases[k]);
      Object.assign(mockAliases, sections.aliases);
    }
    if (sections.confirm !== undefined) {
      Object.keys(mockConfirmKeys).forEach(k => delete mockConfirmKeys[k]);
      Object.assign(mockConfirmKeys, sections.confirm);
    }
  }),
  saveEntriesAndTouchMeta: vi.fn((d: any, key: string) => {
    Object.keys(mockData).forEach(k => delete mockData[k]);
    Object.assign(mockData, d);
    mockMetaData[key] = Date.now();
  }),
  saveEntriesAndRemoveMeta: vi.fn((d: any, key: string) => {
    Object.keys(mockData).forEach(k => delete mockData[k]);
    Object.assign(mockData, d);
    const prefix = key + '.';
    for (const k of Object.keys(mockMetaData)) {
      if (k === key || k.startsWith(prefix)) delete mockMetaData[k];
    }
  }),
  touchMeta: vi.fn(),
  removeMeta: vi.fn(),
  loadMeta: vi.fn(() => ({ ...mockMetaData })),
  loadMetaMerged: vi.fn(() => ({ ...mockMetaData })),
  STALE_DAYS: 30,
  STALE_MS: 30 * 86400000,
  getStalenessTag: vi.fn((key: string, meta: Record<string, number>) => {
    const ts = meta[key];
    if (ts === undefined) return ' [untracked]';
    if (ts < Date.now() - 30 * 86400000) return ` [${Math.floor((Date.now() - ts) / 86400000)}d]`;
    return '';
  }),
}));

vi.mock('../formatting', () => ({
  formatTree: vi.fn(() => 'tree-output'),
  resetColorCache: vi.fn(),
}));

// Mock config
vi.mock('../config', () => ({
  DEFAULT_BOOTSTRAP_MAX_RESPONSE_BYTES: 38 * 1024,
  loadConfig: vi.fn(() => ({ ...mockConfig })),
  getConfigSetting: vi.fn((key: string) => {
    if (key === 'colors' || key === 'theme') return mockConfig[key];
    if (key === 'import_max_bytes') return mockConfig.import_max_bytes ?? null;
    return null;
  }),
  setConfigSetting: vi.fn((key: string, value: any) => {
    mockConfig[key] = value;
  }),
  VALID_CONFIG_KEYS: ['colors', 'theme'],
  VALID_THEMES: ['default', 'dark', 'light'],
}));

// Mock telemetry
vi.mock('../utils/telemetry', () => ({
  logToolCall: vi.fn(() => Promise.resolve()),
  computeStats: vi.fn(() => ({
    period: '30d', totalCalls: 0, mcpSessions: 0, mcpCalls: 0, cliCalls: 0,
    bootstrapRate: 0, writeBackRate: 0, reads: 0, writes: 0, execs: 0,
    readWriteRatio: '0:0', namespaceCoverage: {}, topTools: [], scopeBreakdown: { project: 0, global: 0, unscoped: 0 },
    estimatedTokensSaved: 0, estimatedTokensSavedBootstrap: 0,
    estimatedExplorationTokensSaved: 0, estimatedRedundantWriteTokensSaved: 0, estimatedTotalTokensSaved: 0, explorationBreakdown: {},
    deliveryCostTokens: 0, netTokensSaved: 0, calibration: {},
  })),
  classifyOp: vi.fn((tool: string) => {
    if (['reverie_set', 'reverie_remove', 'reverie_copy', 'reverie_rename', 'reverie_import', 'reverie_reset', 'reverie_alias_set', 'reverie_alias_remove', 'reverie_config_set', 'reverie_init'].includes(tool)) return 'write';
    if (tool === 'reverie_run') return 'exec';
    if (['reverie_context', 'reverie_get', 'reverie_find', 'reverie_export', 'reverie_alias_list', 'reverie_config_get', 'reverie_stale', 'reverie_lint'].includes(tool)) return 'read';
    return 'meta';
  }),
  getTelemetryPath: vi.fn(() => '/mock/telemetry.jsonl'),
  getMissPathsPath: vi.fn(() => '/mock/miss-paths.jsonl'),
  MissWindowTracker: class { onToolCall() { return []; } flushAll() { return []; } readonly openCount = 0; },
  appendMissPath: vi.fn(() => Promise.resolve()),
  getSessionId: vi.fn(() => 'mock-session'),
  extractNamespace: vi.fn((key?: string) => key ? key.split('.')[0] : '*'),
}));

// Mock audit
vi.mock('../utils/audit', () => ({
  logAudit: vi.fn(() => Promise.resolve()),
  queryAuditLog: vi.fn(() => []),
  sanitizeValue: vi.fn((v: string | undefined) => v),
  sanitizeParams: vi.fn((p: Record<string, unknown>) => p),
  classifyOp: vi.fn(() => 'meta'),
  getAuditPath: vi.fn(() => '/mock/audit.jsonl'),
}));

// Mock deepMerge — use real implementation
vi.mock('../utils/deepMerge', () => ({
  deepMerge: vi.fn((target: Record<string, any>, source: Record<string, any>) => {
    return { ...target, ...source };
  }),
}));

// Helper to reset mock data between tests
function resetMocks() {
  Object.keys(mockData).forEach(k => delete mockData[k]);
  Object.keys(mockAliases).forEach(k => delete mockAliases[k]);
  Object.keys(mockConfirmKeys).forEach(k => delete mockConfirmKeys[k]);
  Object.keys(mockConfig).forEach(k => delete mockConfig[k]);
  Object.assign(mockConfig, { colors: true, theme: 'default' });
  Object.keys(mockFiles).forEach(k => delete mockFiles[k]);
  Object.keys(mockWrittenFiles).forEach(k => delete mockWrittenFiles[k]);
  Object.keys(mockMetaData).forEach(k => delete mockMetaData[k]);
  mockExecSync.mockReset();
}

// Import crypto for test data
import { encryptValue, decryptValue } from '../utils/crypto';

// Import the module which triggers tool registrations
beforeAll(async () => {
  await import('../mcp-server');
});

describe('MCP Server Tools', () => {
  beforeEach(() => {
    resetMocks();
  });

  describe('reverie_set', () => {
    it('sets a value and returns a quiet confirmation without echoing the value (#125)', async () => {
      const result = await toolHandlers['reverie_set']({ key: 'server.ip', value: '10.0.0.1' });
      expect(result.content[0].text).toContain('Set: server.ip (8B)');
      expect(result.content[0].text).not.toContain('10.0.0.1');
      expect(result.isError).toBeUndefined();
    });

    it('marks encrypted writes without echoing plaintext or ciphertext', async () => {
      const result = await toolHandlers['reverie_set']({
        key: 'api.secret', value: 'mysecret', encrypt: true, password: 'pass',
      });
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('Set: api.secret (8B, encrypted)');
      expect(result.content[0].text).not.toContain('mysecret');
    });

    it('marks encrypted writes with alias without echoing plaintext', async () => {
      const result = await toolHandlers['reverie_set']({
        key: 'api.secret', value: 'mysecret', encrypt: true, password: 'pass', alias: 'sec',
      });
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('Set: api.secret (8B, encrypted)');
      expect(result.content[0].text).toContain('Alias set: sec ->');
      expect(result.content[0].text).not.toContain('mysecret');
    });
  });

  describe('reverie_get', () => {
    it('returns all entries', async () => {
      Object.assign(mockData, { server: { ip: '10.0.0.1' } });
      const result = await toolHandlers['reverie_get']({ key: undefined, format: undefined, values: true });
      expect(result.content[0].text).toContain('server.ip: 10.0.0.1');
    });

    it('returns "No entries" when store is empty', async () => {
      const result = await toolHandlers['reverie_get']({ key: undefined, format: undefined });
      expect(result.content[0].text).toBe('No entries found.');
    });

    it('returns a leaf value', async () => {
      Object.assign(mockData, { db: { host: 'localhost' } });
      Object.assign(mockMetaData, { 'db.host': Date.now() });
      const result = await toolHandlers['reverie_get']({ key: 'db.host', format: undefined });
      expect(result.content[0].text).toBe('db.host: localhost');
    });

    it('returns a subtree in flat format', async () => {
      Object.assign(mockData, { db: { host: 'localhost', port: '5432' } });
      const result = await toolHandlers['reverie_get']({ key: 'db', format: undefined, values: true });
      expect(result.content[0].text).toContain('db.host: localhost');
      expect(result.content[0].text).toContain('db.port: 5432');
    });

    it('returns error for missing key', async () => {
      const result = await toolHandlers['reverie_get']({ key: 'missing', format: undefined });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("'missing' not found");
    });

    it('uses tree format when requested', async () => {
      Object.assign(mockData, { a: '1' });
      const result = await toolHandlers['reverie_get']({ key: undefined, format: 'tree' });
      expect(result.content[0].text).toBe('tree-output');
    });

    it('shows [encrypted] for encrypted leaf value', async () => {
      const encrypted = encryptValue('secret', 'pass');
      Object.assign(mockData, { api: { key: encrypted } });
      Object.assign(mockMetaData, { 'api.key': Date.now() });
      const result = await toolHandlers['reverie_get']({ key: 'api.key', format: undefined });
      expect(result.content[0].text).toBe('api.key: [encrypted]');
    });

    it('shows [untracked] for leaf value with no meta', async () => {
      Object.assign(mockData, { db: { host: 'localhost' } });
      // mockMetaData is empty — no timestamp for db.host
      const result = await toolHandlers['reverie_get']({ key: 'db.host', format: undefined });
      expect(result.content[0].text).toBe('db.host: localhost [untracked]');
    });

    it('shows age tag for stale leaf value', async () => {
      Object.assign(mockData, { db: { host: 'localhost' } });
      const oldTs = Date.now() - 45 * 86400000;
      Object.assign(mockMetaData, { 'db.host': oldTs });
      const result = await toolHandlers['reverie_get']({ key: 'db.host', format: undefined });
      expect(result.content[0].text).toMatch(/^db\.host: localhost \[\d+d\]$/);
    });

    it('shows [encrypted] for encrypted values in flat listing', async () => {
      const encrypted = encryptValue('secret', 'pass');
      Object.assign(mockData, { api: { key: encrypted }, plain: { val: 'visible' } });
      const result = await toolHandlers['reverie_get']({ key: undefined, format: undefined, values: true });
      expect(result.content[0].text).toContain('api.key: [encrypted]');
      expect(result.content[0].text).toContain('plain.val: visible');
    });

    it('shows [encrypted] for encrypted values in subtree flat format', async () => {
      const encrypted = encryptValue('secret', 'pass');
      Object.assign(mockData, { api: { key: encrypted, name: 'myapi' } });
      const result = await toolHandlers['reverie_get']({ key: 'api', format: undefined, values: true });
      expect(result.content[0].text).toContain('api.key: [encrypted]');
      expect(result.content[0].text).toContain('api.name: myapi');
    });
  });

  describe('reverie_remove', () => {
    it('removes an existing key', async () => {
      Object.assign(mockData, { foo: 'bar' });
      const result = await toolHandlers['reverie_remove']({ key: 'foo' });
      expect(result.content[0].text).toContain('Removed: foo');
    });

    it('returns error for missing key', async () => {
      const result = await toolHandlers['reverie_remove']({ key: 'nope' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("'nope' not found");
    });
  });

  describe('reverie_rename', () => {
    it('renames an entry key', async () => {
      Object.assign(mockData, { old: { key: 'value' } });
      const result = await toolHandlers['reverie_rename']({ oldKey: 'old.key', newKey: 'new.key' });
      expect(result.content[0].text).toContain('Renamed: old.key -> new.key');
      expect(mockData.new?.key).toBe('value');
      expect(mockData.old?.key).toBeUndefined();
    });

    it('returns error when source key not found', async () => {
      const result = await toolHandlers['reverie_rename']({ oldKey: 'missing', newKey: 'new' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("'missing' not found");
    });

    it('returns error when destination already exists', async () => {
      Object.assign(mockData, { old: 'value', new: 'existing' });
      const result = await toolHandlers['reverie_rename']({ oldKey: 'old', newKey: 'new' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("'new' already exists");
    });

    it('re-points aliases from old key to new key', async () => {
      Object.assign(mockData, { old: 'value' });
      Object.assign(mockAliases, { shortcut: 'old' });
      const result = await toolHandlers['reverie_rename']({ oldKey: 'old', newKey: 'new' });
      expect(result.content[0].text).toContain('Renamed: old -> new');
      expect(mockAliases.shortcut).toBe('new');
    });

    it('moves confirm metadata to new key', async () => {
      Object.assign(mockData, { old: 'echo dangerous' });
      Object.assign(mockConfirmKeys, { old: true as const });
      const result = await toolHandlers['reverie_rename']({ oldKey: 'old', newKey: 'new' });
      expect(result.content[0].text).toContain('Renamed: old -> new');
      expect(mockConfirmKeys.old).toBeUndefined();
      expect(mockConfirmKeys.new).toBe(true);
    });

    it('renames an alias when is_alias is true', async () => {
      Object.assign(mockAliases, { oldAlias: 'some.key' });
      const result = await toolHandlers['reverie_rename']({ oldKey: 'oldAlias', newKey: 'newAlias', is_alias: true });
      expect(result.content[0].text).toContain("Alias 'oldAlias' renamed to 'newAlias'");
      expect(mockAliases.newAlias).toBe('some.key');
      expect(mockAliases.oldAlias).toBeUndefined();
    });

    it('returns error for missing alias in alias mode', async () => {
      const result = await toolHandlers['reverie_rename']({ oldKey: 'nope', newKey: 'new', is_alias: true });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("'nope' not found");
    });

    it('returns error when target alias already exists', async () => {
      Object.assign(mockAliases, { oldAlias: 'a.key', newAlias: 'b.key' });
      const result = await toolHandlers['reverie_rename']({ oldKey: 'oldAlias', newKey: 'newAlias', is_alias: true });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("'newAlias' already exists");
    });

    it('resolves alias before renaming entry', async () => {
      Object.assign(mockData, { actual: { key: 'value' } });
      Object.assign(mockAliases, { shortcut: 'actual.key' });
      const result = await toolHandlers['reverie_rename']({ oldKey: 'shortcut', newKey: 'renamed.key' });
      expect(result.content[0].text).toContain('Renamed: actual.key -> renamed.key');
    });
  });

  describe('reverie_find', () => {
    it('finds matching entries', async () => {
      Object.assign(mockData, { server: { ip: '10.0.0.1' } });
      const result = await toolHandlers['reverie_find']({
        query: 'server',
        aliasesOnly: undefined, entriesOnly: undefined,
      });
      expect(result.content[0].text).toContain('server.ip');
    });

    it('respects aliasesOnly — skips data entries', async () => {
      Object.assign(mockData, { server: { ip: '10.0.0.1' } });
      Object.assign(mockAliases, { srv: 'server.ip' });
      const result = await toolHandlers['reverie_find']({
        query: 'server',
        aliasesOnly: true, entriesOnly: undefined,
      });
      // Should find alias but not the data entry
      expect(result.content[0].text).toContain('[alias] srv -> server.ip');
      expect(result.content[0].text).not.toContain('server.ip: 10.0.0.1');
    });

    it('respects entriesOnly — skips alias search', async () => {
      Object.assign(mockData, { server: { ip: '10.0.0.1' } });
      Object.assign(mockAliases, { srv: 'server.ip' });
      const result = await toolHandlers['reverie_find']({
        query: 'server',
        aliasesOnly: undefined, entriesOnly: true,
      });
      // Should find data entry but not the alias
      expect(result.content[0].text).toContain('server.ip: 10.0.0.1');
      expect(result.content[0].text).not.toContain('[alias]');
    });

    it('returns no results message', async () => {
      const result = await toolHandlers['reverie_find']({
        query: 'nonexistent',
        aliasesOnly: undefined, entriesOnly: undefined,
      });
      expect(result.content[0].text).toContain("No results found for 'nonexistent'");
    });

    it('shows [encrypted] for encrypted values matched by key', async () => {
      const encrypted = encryptValue('secret', 'pass');
      Object.assign(mockData, { api: { key: encrypted } });
      const result = await toolHandlers['reverie_find']({
        query: 'api',
        aliasesOnly: undefined, entriesOnly: undefined,
      });
      expect(result.content[0].text).toContain('api.key: [encrypted]');
    });

    it('does not match encrypted values by value content', async () => {
      const encrypted = encryptValue('findme', 'pass');
      Object.assign(mockData, { api: { key: encrypted } });
      const result = await toolHandlers['reverie_find']({
        query: 'findme',
        aliasesOnly: undefined, entriesOnly: undefined,
      });
      expect(result.content[0].text).toContain('No results');
    });

    it('keysOnly projects values out of the response (#127)', async () => {
      Object.assign(mockData, { server: { ip: '10.0.0.1' } });
      const result = await toolHandlers['reverie_find']({
        query: 'server', keysOnly: true,
        aliasesOnly: undefined, entriesOnly: undefined,
      });
      expect(result.content[0].text).toContain('server.ip');
      expect(result.content[0].text).not.toContain('10.0.0.1');
    });
  });

  describe('reverie_alias_set', () => {
    it('creates an alias', async () => {
      const result = await toolHandlers['reverie_alias_set']({ alias: 'srv', key: 'server.ip' });
      expect(result.content[0].text).toContain('Alias set: srv -> server.ip');
    });
  });

  describe('reverie_alias_remove', () => {
    it('removes an existing alias', async () => {
      Object.assign(mockAliases, { srv: 'server.ip' });
      const result = await toolHandlers['reverie_alias_remove']({ alias: 'srv' });
      expect(result.content[0].text).toContain('Alias removed: srv');
    });

    it('returns error for missing alias', async () => {
      const result = await toolHandlers['reverie_alias_remove']({ alias: 'nope' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("'nope' not found");
    });
  });

  describe('reverie_alias_list', () => {
    it('lists all aliases', async () => {
      Object.assign(mockAliases, { srv: 'server.ip', db: 'database.host' });
      const result = await toolHandlers['reverie_alias_list']({});
      expect(result.content[0].text).toContain('srv -> server.ip');
      expect(result.content[0].text).toContain('db -> database.host');
    });

    it('returns message when no aliases defined', async () => {
      const result = await toolHandlers['reverie_alias_list']({});
      expect(result.content[0].text).toBe('No aliases defined.');
    });
  });

  describe('reverie_run', () => {
    it('executes a stored command and returns stdout with command prefix', async () => {
      Object.assign(mockData, { cmd: 'echo hello' });
      mockExecSync.mockReturnValue('hello\n');
      const result = await toolHandlers['reverie_run']({ key: 'cmd', dry: undefined });
      expect(result.content[0].text).toBe('$ echo hello\nhello\n');
      expect(mockExecSync).toHaveBeenCalledWith('echo hello', expect.objectContaining({
        encoding: 'utf-8',
        shell: process.env.SHELL || '/bin/sh',
        timeout: 30000,
      }));
    });

    it('returns the command with dry: true', async () => {
      Object.assign(mockData, { cmd: 'echo hello' });
      const result = await toolHandlers['reverie_run']({ key: 'cmd', dry: true });
      expect(result.content[0].text).toBe('$ echo hello');
      expect(mockExecSync).not.toHaveBeenCalled();
    });

    it('returns error for missing key', async () => {
      const result = await toolHandlers['reverie_run']({ key: 'nope', dry: undefined });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("'nope' not found");
    });

    it('returns error when value is not a string', async () => {
      Object.assign(mockData, { nested: { a: '1' } });
      const result = await toolHandlers['reverie_run']({ key: 'nested', dry: undefined });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('not a string command');
    });

    it('returns exit code and stderr on failure with command prefix', async () => {
      Object.assign(mockData, { cmd: 'false' });
      mockExecSync.mockImplementation(() => {
        const err: any = new Error('fail');
        err.status = 1;
        err.stderr = 'command failed';
        throw err;
      });
      const result = await toolHandlers['reverie_run']({ key: 'cmd', dry: undefined });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('$ false');
      expect(result.content[0].text).toContain('exit 1');
      expect(result.content[0].text).toContain('command failed');
    });

    it('resolves alias before executing', async () => {
      Object.assign(mockData, { commands: { greet: 'echo hello' } });
      Object.assign(mockAliases, { hi: 'commands.greet' });
      mockExecSync.mockReturnValue('hello\n');
      const result = await toolHandlers['reverie_run']({ key: 'hi', dry: undefined });
      expect(result.content[0].text).toBe('$ echo hello\nhello\n');
    });

    it('resolves alias with dry run', async () => {
      Object.assign(mockData, { commands: { greet: 'echo hello' } });
      Object.assign(mockAliases, { hi: 'commands.greet' });
      const result = await toolHandlers['reverie_run']({ key: 'hi', dry: true });
      expect(result.content[0].text).toBe('$ echo hello');
      expect(mockExecSync).not.toHaveBeenCalled();
    });

    it('returns error when value is encrypted', async () => {
      const encrypted = encryptValue('echo secret', 'pass');
      Object.assign(mockData, { cmd: encrypted });
      const result = await toolHandlers['reverie_run']({ key: 'cmd', dry: undefined });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('encrypted');
      expect(result.content[0].text).toContain('not supported via MCP');
      expect(mockExecSync).not.toHaveBeenCalled();
    });
  });

  describe('reverie_config_get', () => {
    it('returns all config settings when no key provided', async () => {
      const result = await toolHandlers['reverie_config_get']({ key: undefined });
      expect(result.content[0].text).toContain('colors: true');
      expect(result.content[0].text).toContain('theme: default');
    });

    it('returns a single config value', async () => {
      const result = await toolHandlers['reverie_config_get']({ key: 'theme' });
      expect(result.content[0].text).toBe('theme: default');
    });

    it('returns error for unknown key', async () => {
      const result = await toolHandlers['reverie_config_get']({ key: 'unknown' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Unknown config key: 'unknown'");
    });
  });

  describe('reverie_config_set', () => {
    it('sets a valid config key', async () => {
      const result = await toolHandlers['reverie_config_set']({ key: 'theme', value: 'dark' });
      expect(result.content[0].text).toContain('Config set: theme = dark');
    });

    it('converts boolean for colors', async () => {
      const result = await toolHandlers['reverie_config_set']({ key: 'colors', value: 'true' });
      expect(result.content[0].text).toContain('Config set: colors = true');
    });

    it('converts "1" to true for colors', async () => {
      const result = await toolHandlers['reverie_config_set']({ key: 'colors', value: '1' });
      expect(result.content[0].text).toContain('Config set: colors = 1');
    });

    it('returns error for unknown key', async () => {
      const result = await toolHandlers['reverie_config_set']({ key: 'bad', value: 'x' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Unknown config key: 'bad'");
    });
  });

  describe('reverie_export', () => {
    it('exports data only as valid JSON wrapped in the envelope', async () => {
      Object.assign(mockData, { a: '1' });
      const result = await toolHandlers['reverie_export']({ type: 'entries', pretty: undefined });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.$reverie.type).toBe('entries');
      expect(parsed.entries).toEqual({ a: '1' });
    });

    it('exports aliases only as valid JSON wrapped in the envelope', async () => {
      Object.assign(mockAliases, { srv: 'server.ip' });
      const result = await toolHandlers['reverie_export']({ type: 'aliases', pretty: undefined });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.$reverie.type).toBe('aliases');
      expect(parsed.aliases).toEqual({ srv: 'server.ip' });
    });

    it('exports all as wrapped JSON with entries/aliases/confirm sections', async () => {
      Object.assign(mockData, { a: '1' });
      Object.assign(mockAliases, { x: 'y' });
      const result = await toolHandlers['reverie_export']({ type: 'all', pretty: undefined });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.$reverie.type).toBe('all');
      expect(parsed.entries).toEqual({ a: '1' });
      expect(parsed.aliases).toEqual({ x: 'y' });
      expect(parsed.confirm).toEqual({});
    });

    it('pretty-prints when requested', async () => {
      Object.assign(mockData, { a: '1' });
      const result = await toolHandlers['reverie_export']({ type: 'entries', pretty: true });
      expect(result.content[0].text).toContain('  "a": "1"');
    });

    it('masks encrypted values in data export', async () => {
      const encrypted = encryptValue('secret', 'pass');
      Object.assign(mockData, { api: { key: encrypted }, plain: 'visible' });
      const result = await toolHandlers['reverie_export']({ type: 'entries', pretty: undefined });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.entries.api.key).toBe('[encrypted]');
      expect(parsed.entries.plain).toBe('visible');
      expect(parsed.$reverie.includesEncrypted).toBe(false);
      expect(result.content[0].text).not.toContain('encrypted::v1:');
    });

    it('masks encrypted values in all export', async () => {
      const encrypted = encryptValue('secret', 'pass');
      Object.assign(mockData, { secret: encrypted });
      const result = await toolHandlers['reverie_export']({ type: 'all', pretty: undefined });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.entries.secret).toBe('[encrypted]');
    });

    it('emits real ciphertext when includeEncrypted: true', async () => {
      const encrypted = encryptValue('secret', 'pass');
      Object.assign(mockData, { api: { key: encrypted } });
      const result = await toolHandlers['reverie_export']({ type: 'entries', includeEncrypted: true });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.entries.api.key).toBe(encrypted);
      expect(parsed.$reverie.includesEncrypted).toBe(true);
      expect(result.content[0].text).toContain('encrypted::v1:');
      expect(result.content[0].text).not.toContain('[encrypted]');
    });

    it('emits real ciphertext on all export when includeEncrypted: true', async () => {
      const encrypted = encryptValue('secret', 'pass');
      Object.assign(mockData, { api: { key: encrypted } });
      const result = await toolHandlers['reverie_export']({ type: 'all', includeEncrypted: true });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.entries.api.key).toBe(encrypted);
      expect(parsed.$reverie.includesEncrypted).toBe(true);
    });
  });

  describe('reverie_import', () => {
    it('imports data (replace)', async () => {
      Object.assign(mockData, { old: 'val' });
      const result = await toolHandlers['reverie_import']({
        type: 'entries', data: '{"new":"val"}', merge: false,
      });
      expect(result.content[0].text).toContain('Entries imported successfully');
      expect(mockData).toEqual({ new: 'val' });
    });

    it('imports data (merge)', async () => {
      Object.assign(mockData, { old: 'val' });
      const result = await toolHandlers['reverie_import']({
        type: 'entries', data: '{"new":"val"}', merge: true,
      });
      expect(result.content[0].text).toContain('Entries merged successfully');
    });

    it('imports aliases (replace)', async () => {
      Object.assign(mockAliases, { old: 'path.old' });
      const result = await toolHandlers['reverie_import']({
        type: 'aliases', data: '{"new":"path.new"}', merge: false,
      });
      expect(result.content[0].text).toContain('Aliases imported successfully');
      expect(mockAliases).toEqual({ new: 'path.new' });
    });

    it('returns error for invalid JSON', async () => {
      const result = await toolHandlers['reverie_import']({
        type: 'entries', data: 'not-json', merge: undefined,
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Invalid JSON');
    });

    it('returns error for non-object JSON', async () => {
      const result = await toolHandlers['reverie_import']({
        type: 'entries', data: '[1,2,3]', merge: undefined,
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('must be an object');
    });

    it('imports all (replace) with structured JSON', async () => {
      Object.assign(mockData, { old: 'data' });
      Object.assign(mockAliases, { old: 'alias.path' });
      const json = JSON.stringify({ entries: { new: 'data' }, aliases: { new: 'alias.path' } });
      const result = await toolHandlers['reverie_import']({
        type: 'all', data: json, merge: false,
      });
      expect(result.content[0].text).toContain('Entries, aliases, and confirm keys imported successfully');
      expect(mockData).toEqual({ new: 'data' });
      expect(mockAliases).toEqual({ new: 'alias.path' });
    });

    it('imports all (merge) with structured JSON', async () => {
      Object.assign(mockData, { existing: 'data' });
      Object.assign(mockAliases, { existing: 'alias.path' });
      const json = JSON.stringify({ entries: { added: 'data' }, aliases: { added: 'alias.path' } });
      const result = await toolHandlers['reverie_import']({
        type: 'all', data: json, merge: true,
      });
      expect(result.content[0].text).toContain('Entries, aliases, and confirm keys merged successfully');
      expect(mockData).toEqual({ existing: 'data', added: 'data' });
      expect(mockAliases).toEqual({ existing: 'alias.path', added: 'alias.path' });
    });

    it('rejects oversized string payloads (#80)', async () => {
      mockConfig.import_max_bytes = 100;
      try {
        const big = JSON.stringify({ k: 'x'.repeat(500) });
        const result = await toolHandlers['reverie_import']({
          type: 'entries', data: big, merge: false,
        });
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('too large');
        expect(result.content[0].text).toContain('import_max_bytes');
      } finally {
        delete mockConfig.import_max_bytes;
      }
    });

    it('does not half-apply a multi-section import when a later section fails validation (#77)', async () => {
      // Entries valid, aliases has a non-string value — alias validation
      // must fail BEFORE entries are written. Pre-fix the MCP path wrote
      // entries first and tripped on aliases, leaving a torn store.
      Object.assign(mockData, { preserved: 'before' });
      Object.assign(mockAliases, { preservedAlias: 'some.path' });
      const json = JSON.stringify({ entries: { ok: 'value' }, aliases: { bad: { not: 'a string' } } });

      const result = await toolHandlers['reverie_import']({
        type: 'all', data: json, merge: false,
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Alias values must all be strings');
      // Store must be exactly as it was before.
      expect(mockData).toEqual({ preserved: 'before' });
      expect(mockAliases).toEqual({ preservedAlias: 'some.path' });
    });

    it('returns error when importing all without data/aliases keys', async () => {
      const result = await toolHandlers['reverie_import']({
        type: 'all', data: '{"foo":"bar"}', merge: undefined,
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('requires {"entries"');
    });
  });

  describe('reverie_export / reverie_import round-trip', () => {
    it('round-trips export all → import all', async () => {
      Object.assign(mockData, { server: { ip: '10.0.0.1' } });
      Object.assign(mockAliases, { srv: 'server.ip' });

      // Export
      const exported = await toolHandlers['reverie_export']({ type: 'all', pretty: undefined });
      const json = exported.content[0].text;

      // Clear stores
      Object.keys(mockData).forEach(k => delete mockData[k]);
      Object.keys(mockAliases).forEach(k => delete mockAliases[k]);
      expect(mockData).toEqual({});
      expect(mockAliases).toEqual({});

      // Import
      const result = await toolHandlers['reverie_import']({ type: 'all', data: json, merge: false });
      expect(result.content[0].text).toContain('Entries, aliases, and confirm keys imported successfully');
      expect(mockData).toEqual({ server: { ip: '10.0.0.1' } });
      expect(mockAliases).toEqual({ srv: 'server.ip' });
    });

    it('round-trips encrypted values when includeEncrypted is set', async () => {
      const plaintext = 'top-secret';
      const password = 'pw';
      const encrypted = encryptValue(plaintext, password);
      Object.assign(mockData, { api: { key: encrypted } });

      const exported = await toolHandlers['reverie_export']({ type: 'entries', includeEncrypted: true });
      const json = exported.content[0].text;

      Object.keys(mockData).forEach(k => delete mockData[k]);

      const result = await toolHandlers['reverie_import']({ type: 'entries', data: json, merge: false });
      expect(result.isError).toBeFalsy();
      expect(mockData.api).toBeDefined();
      const restored = (mockData.api as Record<string, string>).key;
      expect(restored).toBe(encrypted);
      expect(decryptValue(restored, password)).toBe(plaintext);
    });

    it('rejects import of a masking-export file (preserves encrypted values in store)', async () => {
      const encrypted = encryptValue('secret', 'pw');
      Object.assign(mockData, { api: { key: encrypted } });

      // Export WITHOUT includeEncrypted — produces the lossy [encrypted] sentinel
      const exported = await toolHandlers['reverie_export']({ type: 'entries' });
      const json = exported.content[0].text;
      expect(json).toContain('[encrypted]');

      // Import must fail with a clear message instead of silently overwriting
      // the ciphertext in the store with the literal string '[encrypted]'.
      const result = await toolHandlers['reverie_import']({ type: 'entries', data: json, merge: false });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('masked encrypted placeholders');

      // Store should still hold the original ciphertext, untouched.
      expect((mockData.api as Record<string, string>).key).toBe(encrypted);
    });
  });

  describe('reverie_reset', () => {
    it('resets data', async () => {
      Object.assign(mockData, { a: '1' });
      const result = await toolHandlers['reverie_reset']({ type: 'entries' });
      expect(result.content[0].text).toContain('Entries reset to empty state');
      expect(mockData).toEqual({});
    });

    it('resets aliases', async () => {
      Object.assign(mockAliases, { srv: 'server.ip' });
      const result = await toolHandlers['reverie_reset']({ type: 'aliases' });
      expect(result.content[0].text).toContain('Aliases reset to empty state');
      expect(mockAliases).toEqual({});
    });

    it('resets all', async () => {
      Object.assign(mockData, { a: '1' });
      Object.assign(mockAliases, { srv: 'server.ip' });
      const result = await toolHandlers['reverie_reset']({ type: 'all' });
      expect(result.content[0].text).toContain('Entries, aliases, and confirm keys reset to empty state');
      expect(mockData).toEqual({});
      expect(mockAliases).toEqual({});
    });
  });

  describe('reverie_context', () => {
    it('returns flat entries and aliases', async () => {
      Object.assign(mockData, { server: { ip: '10.0.0.1' }, db: { host: 'localhost' } });
      Object.assign(mockAliases, { srv: 'server.ip' });

      const result = await toolHandlers['reverie_context']({});
      const text = result.content[0].text;
      expect(text).toContain('server.ip: 10.0.0.1');
      expect(text).toContain('db.host: localhost');
      expect(text).toContain('srv -> server.ip');
    });

    it('returns message when no entries stored', async () => {
      const result = await toolHandlers['reverie_context']({});
      expect(result.content[0].text).toContain('No entries stored');
    });

    it('sizeOnly returns per-namespace counts without entry content (#127)', async () => {
      Object.assign(mockData, { server: { ip: '10.0.0.1' }, project: { name: 'test' } });
      const result = await toolHandlers['reverie_context']({ sizeOnly: true });
      const text = result.content[0].text;
      expect(text).toContain('Context size (tier: standard)');
      expect(text).toContain('server');
      expect(text).toContain('total');
      expect(text).toContain('Budget:');
      expect(text).toContain('2 entries');
      expect(text).not.toContain('10.0.0.1');
      expect(text).not.toContain('test');
    });

    it('shows entries without aliases section when no aliases exist', async () => {
      Object.assign(mockData, { key: 'value' });

      const result = await toolHandlers['reverie_context']({});
      const text = result.content[0].text;
      expect(text).toContain('key: value');
      expect(text).not.toContain('Aliases:');
    });

    it('filters to essential tier', async () => {
      Object.assign(mockData, {
        project: { name: 'test' },
        commands: { build: 'npm run build' },
        conventions: { style: 'prettier' },
        arch: { pattern: 'MVC' },
        deps: { express: '4.x' },
      });
      const result = await toolHandlers['reverie_context']({ tier: 'essential' });
      const text = result.content[0].text;
      expect(text).toContain('project.name: test');
      expect(text).toContain('commands.build:');
      expect(text).toContain('conventions.style:');
      expect(text).not.toContain('arch.pattern');
      expect(text).not.toContain('deps.express');
      expect(text).toContain('[tier: essential');
    });

    it('defaults to standard tier excluding arch', async () => {
      Object.assign(mockData, {
        project: { name: 'test' },
        arch: { pattern: 'MVC' },
        context: { note: 'important' },
      });
      const result = await toolHandlers['reverie_context']({});
      const text = result.content[0].text;
      expect(text).toContain('project.name: test');
      expect(text).toContain('context.note: important');
      expect(text).not.toContain('arch.pattern');
      expect(text).toContain('[tier: standard');
    });

    it('full tier includes everything', async () => {
      Object.assign(mockData, {
        project: { name: 'test' },
        arch: { pattern: 'MVC' },
      });
      const result = await toolHandlers['reverie_context']({ tier: 'full' });
      const text = result.content[0].text;
      expect(text).toContain('project.name: test');
      expect(text).toContain('arch.pattern: MVC');
      expect(text).not.toContain('[tier:');
    });

    it('shows [untracked] for entries with no meta in context', async () => {
      Object.assign(mockData, { project: { name: 'test' } });
      // mockMetaData is empty — no timestamp
      const result = await toolHandlers['reverie_context']({ tier: 'full' });
      const text = result.content[0].text;
      expect(text).toContain('project.name: test [untracked]');
    });

    it('shows age tag for stale entries in context', async () => {
      Object.assign(mockData, { project: { name: 'test' } });
      const oldTs = Date.now() - 45 * 86400000;
      Object.assign(mockMetaData, { 'project.name': oldTs });
      const result = await toolHandlers['reverie_context']({ tier: 'full' });
      const text = result.content[0].text;
      expect(text).toMatch(/project\.name: test \[\d+d\]/);
    });

    it('no tag for fresh entries in context', async () => {
      Object.assign(mockData, { project: { name: 'test' } });
      Object.assign(mockMetaData, { 'project.name': Date.now() });
      const result = await toolHandlers['reverie_context']({ tier: 'full' });
      const text = result.content[0].text;
      expect(text).toContain('project.name: test');
      expect(text).not.toContain('[untracked]');
      expect(text).not.toMatch(/project\.name: test \[\d+d\]/);
    });

    it('includes custom namespaces in standard tier', async () => {
      Object.assign(mockData, {
        myteam: { workflow: 'agile' },
        arch: { pattern: 'MVC' },
      });
      const result = await toolHandlers['reverie_context']({});
      const text = result.content[0].text;
      expect(text).toContain('myteam.workflow: agile');
      expect(text).not.toContain('arch.pattern');
    });

    it('includes aliases regardless of tier', async () => {
      Object.assign(mockData, { project: { name: 'test' } });
      Object.assign(mockAliases, { p: 'project.name' });
      const result = await toolHandlers['reverie_context']({ tier: 'essential' });
      const text = result.content[0].text;
      expect(text).toContain('p -> project.name');
    });
  });

  describe('reverie_run with chain', () => {
    it('resolves chain keys and joins with &&', async () => {
      Object.assign(mockData, {
        cmd: { a: 'echo step-a', b: 'echo step-b' },
        macros: { both: 'cmd.a cmd.b' },
      });
      mockExecSync.mockReturnValue('step-a\nstep-b\n');

      const result = await toolHandlers['reverie_run']({ key: 'macros.both', chain: true });
      expect(result.content[0].text).toContain('echo step-a && echo step-b');
    });

    it('supports dry run with chain', async () => {
      Object.assign(mockData, {
        cmd: { a: 'echo hi', b: 'echo bye' },
        macros: { both: 'cmd.a cmd.b' },
      });

      const result = await toolHandlers['reverie_run']({ key: 'macros.both', chain: true, dry: true });
      expect(result.content[0].text).toBe('$ echo hi && echo bye');
      expect(mockExecSync).not.toHaveBeenCalled();
    });

    it('returns error when a chain key is not found', async () => {
      Object.assign(mockData, {
        macros: { bad: 'cmd.exists cmd.missing' },
        cmd: { exists: 'echo ok' },
      });

      const result = await toolHandlers['reverie_run']({ key: 'macros.bad', chain: true });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("'cmd.missing' not found");
    });
  });

  describe('reverie_find with regex', () => {
    it('matches entries by regex pattern', async () => {
      Object.assign(mockData, {
        server: { prod: { ip: '10.0.0.1' }, dev: { ip: '127.0.0.1' } },
      });

      const result = await toolHandlers['reverie_find']({ query: 'prod.*ip', regex: true });
      expect(result.content[0].text).toContain('server.prod.ip');
      expect(result.content[0].text).not.toContain('server.dev.ip');
    });

    it('returns error for invalid regex', async () => {
      const result = await toolHandlers['reverie_find']({ query: '[invalid', regex: true });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Invalid regex');
    });

    it('supports keysOnly', async () => {
      Object.assign(mockData, { server: { ip: '10.0.0.1' } });

      const result = await toolHandlers['reverie_find']({ query: '10.0', keysOnly: true });
      // 10.0 is only in the value, not the key — so no match with keysOnly
      expect(result.content[0].text).toContain('No results');
    });

    it('supports valuesOnly', async () => {
      Object.assign(mockData, { server: { ip: '10.0.0.1' } });

      const result = await toolHandlers['reverie_find']({ query: 'server', valuesOnly: true });
      // "server" is only in the key, not the value — so no match with valuesOnly
      expect(result.content[0].text).toContain('No results');
    });

    it('returns error when keysOnly and valuesOnly are both true', async () => {
      Object.assign(mockData, { server: { ip: '10.0.0.1' } });

      const result = await toolHandlers['reverie_find']({ query: 'server', keysOnly: true, valuesOnly: true });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('mutually exclusive');
    });
  });

  describe('reverie_stale', () => {
    it('returns message when no stale entries (default threshold)', async () => {
      Object.assign(mockData, { project: { name: 'test' } });
      // All entries have recent timestamps (within last 30 days)
      const recentTs = Date.now() - 1 * 86400000; // 1 day ago
      Object.assign(mockMetaData, { 'project.name': recentTs });

      const result = await toolHandlers['reverie_stale']({});
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('No entries older than 30 days');
    });

    it('returns stale entries older than threshold', async () => {
      Object.assign(mockData, { project: { name: 'test', oldkey: 'oldval' } });
      const oldTs = Date.now() - 60 * 86400000; // 60 days ago
      const recentTs = Date.now() - 1 * 86400000; // 1 day ago
      Object.assign(mockMetaData, {
        'project.name': recentTs,
        'project.oldkey': oldTs,
      });

      const result = await toolHandlers['reverie_stale']({ days: 30 });
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('project.oldkey');
      expect(result.content[0].text).not.toContain('project.name');
    });

    it('uses custom days threshold', async () => {
      Object.assign(mockData, { project: { a: '1', b: '2' } });
      const ts7dAgo = Date.now() - 7 * 86400000;
      Object.assign(mockMetaData, {
        'project.a': ts7dAgo,
        'project.b': ts7dAgo,
      });

      const result = await toolHandlers['reverie_stale']({ days: 3 });
      expect(result.content[0].text).toContain('project.a');
      expect(result.content[0].text).toContain('project.b');
    });

    it('marks entries with no timestamp as untracked', async () => {
      Object.assign(mockData, { untracked: 'value' });
      // mockMetaData is empty (no timestamps)

      const result = await toolHandlers['reverie_stale']({ days: 0 });
      expect(result.content[0].text).toContain('untracked');
    });

    it('handles scoped (global) request', async () => {
      Object.assign(mockData, { g: 'val' });
      const oldTs = Date.now() - 90 * 86400000;
      Object.assign(mockMetaData, { g: oldTs });

      const result = await toolHandlers['reverie_stale']({ days: 30, scope: 'global' });
      expect(result.content[0].text).toContain('g');
    });
  });

  describe('reverie_audit', () => {
    it('returns no entries message when empty', async () => {
      const result = await toolHandlers['reverie_audit']({});
      expect(result.content[0].text).toContain('No audit entries found');
    });

    it('returns formatted entries when data exists', async () => {
      const { queryAuditLog } = await import('../utils/audit');
      (queryAuditLog as any).mockReturnValueOnce([
        { ts: Date.now(), session: 'abc', src: 'mcp', tool: 'reverie_set', op: 'write', key: 'arch.mcp', scope: 'project', success: true, before: 'old', after: 'new' },
      ]);
      const result = await toolHandlers['reverie_audit']({});
      expect(result.content[0].text).toContain('Audit Log');
      expect(result.content[0].text).toContain('reverie_set');
      expect(result.content[0].text).toContain('arch.mcp');
      expect(result.content[0].text).toContain('- old');
      expect(result.content[0].text).toContain('+ new');
    });

    it('passes filter params to queryAuditLog', async () => {
      const { queryAuditLog } = await import('../utils/audit');
      await toolHandlers['reverie_audit']({ key: 'arch', period: '7d', writes_only: true, limit: 10 });
      expect(queryAuditLog).toHaveBeenCalledWith({ key: 'arch', periodDays: 7, writesOnly: true, limit: 10 });
    });

    it('passes include_test and include_self_ref through (#130 #134)', async () => {
      const { queryAuditLog } = await import('../utils/audit');
      await toolHandlers['reverie_audit']({ include_test: true, include_self_ref: true });
      expect(queryAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({ includeTest: true, includeSelfRef: true })
      );
    });
  });

  describe('MCP wrapper audit logging', () => {
    let logAuditMock: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
      resetMocks();
      const auditModule = await import('../utils/audit');
      logAuditMock = auditModule.logAudit as ReturnType<typeof vi.fn>;
      logAuditMock.mockClear();
    });

    it('calls logAudit with before/after for reverie_set', async () => {
      Object.assign(mockData, { server: { ip: '10.0.0.1' } });
      await toolHandlers['reverie_set']({ key: 'server.ip', value: '10.0.0.2' });
      expect(logAuditMock).toHaveBeenCalledWith(
        expect.objectContaining({
          src: 'mcp',
          tool: 'reverie_set',
          op: 'write',
          key: 'server.ip',
          success: true,
          before: '10.0.0.1',
          after: '10.0.0.2',
        })
      );
    });

    it('calls logAudit with success: false when handler returns isError', async () => {
      // Attempt to get a missing key — reverie_get returns isError
      await toolHandlers['reverie_get']({ key: 'nonexistent' });
      expect(logAuditMock).toHaveBeenCalledWith(
        expect.objectContaining({
          tool: 'reverie_get',
          success: false,
        })
      );
    });

    it('calls logAudit with alias name as key for reverie_alias_set', async () => {
      await toolHandlers['reverie_alias_set']({ alias: 'srv', key: 'server.ip' });
      expect(logAuditMock).toHaveBeenCalledWith(
        expect.objectContaining({
          tool: 'reverie_alias_set',
          op: 'write',
          key: 'srv',
          success: true,
        })
      );
    });

    it('captures alias target in before for reverie_alias_set when alias exists', async () => {
      Object.assign(mockAliases, { srv: 'server.old' });
      await toolHandlers['reverie_alias_set']({ alias: 'srv', key: 'server.ip' });
      expect(logAuditMock).toHaveBeenCalledWith(
        expect.objectContaining({
          tool: 'reverie_alias_set',
          key: 'srv',
          before: 'server.old',
        })
      );
    });

    it('calls logAudit with alias name as key for reverie_alias_remove', async () => {
      Object.assign(mockAliases, { srv: 'server.ip' });
      await toolHandlers['reverie_alias_remove']({ alias: 'srv' });
      expect(logAuditMock).toHaveBeenCalledWith(
        expect.objectContaining({
          tool: 'reverie_alias_remove',
          op: 'write',
          key: 'srv',
          success: true,
          before: 'server.ip',
        })
      );
    });

    it('resolves alias key to actual path before capturing value for reverie_remove', async () => {
      Object.assign(mockData, { server: { ip: '10.0.0.1' } });
      Object.assign(mockAliases, { srv: 'server.ip' });
      await toolHandlers['reverie_remove']({ key: 'srv' });
      expect(logAuditMock).toHaveBeenCalledWith(
        expect.objectContaining({
          tool: 'reverie_remove',
          key: 'srv',
          before: '10.0.0.1',
          success: true,
        })
      );
    });

    it('logs reverie_stats with selfRef:true and op meta (#134)', async () => {
      logAuditMock.mockClear();
      await toolHandlers['reverie_stats']({});
      expect(logAuditMock).toHaveBeenCalledWith(
        expect.objectContaining({ tool: 'reverie_stats', op: 'meta', selfRef: true })
      );
    });

    it('logs reverie_audit itself with selfRef:true and op meta (#134)', async () => {
      logAuditMock.mockClear();
      await toolHandlers['reverie_audit']({});
      expect(logAuditMock).toHaveBeenCalledWith(
        expect.objectContaining({ tool: 'reverie_audit', op: 'meta', selfRef: true })
      );
    });
  });

  describe('guardrail signal propagation (#100, #101)', () => {
    let logAuditMock: ReturnType<typeof vi.fn>;
    let logToolCallMock: ReturnType<typeof vi.fn>;
    let clearWriteAmpStateFn: () => void;

    beforeEach(async () => {
      resetMocks();
      const auditModule = await import('../utils/audit');
      const telemetryModule = await import('../utils/telemetry');
      const writeAmpModule = await import('../utils/writeAmp');
      logAuditMock = auditModule.logAudit as ReturnType<typeof vi.fn>;
      logToolCallMock = telemetryModule.logToolCall as ReturnType<typeof vi.fn>;
      clearWriteAmpStateFn = writeAmpModule.clearWriteAmpState;
      logAuditMock.mockClear();
      logToolCallMock.mockClear();
      clearWriteAmpStateFn();
    });

    afterEach(() => {
      clearWriteAmpStateFn();
    });

    it('reverie_set on 3rd write of same key emits writeAmpWarning to audit + telemetry', async () => {
      await toolHandlers['reverie_set']({ key: 'files.x', value: 'v1' });
      await toolHandlers['reverie_set']({ key: 'files.x', value: 'v2' });
      logAuditMock.mockClear();
      logToolCallMock.mockClear();
      const result = await toolHandlers['reverie_set']({ key: 'files.x', value: 'v3' });

      expect(result.content[0].text).toContain('warning: this key has been written 3 times');

      expect(logAuditMock).toHaveBeenCalledWith(
        expect.objectContaining({
          tool: 'reverie_set',
          writeAmpWarning: true,
          writeAmpCount: 3,
        })
      );

      expect(logToolCallMock).toHaveBeenCalledWith(
        'reverie_set',
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ writeAmpWarning: true, writeAmpCount: 3 })
      );
    });

    it('reverie_set on 1st/2nd writes does not emit writeAmpWarning', async () => {
      await toolHandlers['reverie_set']({ key: 'files.x', value: 'v1' });
      const audit1 = logAuditMock.mock.calls[logAuditMock.mock.calls.length - 1][0] as Record<string, unknown>;
      expect(audit1.writeAmpWarning).toBeUndefined();

      await toolHandlers['reverie_set']({ key: 'files.x', value: 'v2' });
      const audit2 = logAuditMock.mock.calls[logAuditMock.mock.calls.length - 1][0] as Record<string, unknown>;
      expect(audit2.writeAmpWarning).toBeUndefined();
    });

    it('different keys in same session each get their own counter', async () => {
      await toolHandlers['reverie_set']({ key: 'files.a', value: 'v' });
      await toolHandlers['reverie_set']({ key: 'files.a', value: 'v' });
      logAuditMock.mockClear();
      const result = await toolHandlers['reverie_set']({ key: 'files.b', value: 'v' });
      expect(result.content[0].text).not.toContain('warning:');
      const audit = logAuditMock.mock.calls[0][0] as Record<string, unknown>;
      expect(audit.writeAmpWarning).toBeUndefined();
    });

    it('reverie_context emits degraded + shedNamespaces when over budget', async () => {
      mockConfig.bootstrap_max_response_bytes = 200;
      const big = 'x'.repeat(300);
      Object.assign(mockData, {
        project: { name: 'reverie' },
        files: { a: big, b: big, c: big },
      });

      const result = await toolHandlers['reverie_context']({});
      expect(result.content[0].text).toContain('[trimmed:');
      expect(result.content[0].text).toContain('files.*');

      expect(logAuditMock).toHaveBeenCalledWith(
        expect.objectContaining({
          tool: 'reverie_context',
          degraded: true,
          shedNamespaces: expect.arrayContaining(['files.*']),
        })
      );
    });

    it('reverie_context with tier:"full" bypasses shed even when over budget', async () => {
      mockConfig.bootstrap_max_response_bytes = 200;
      const big = 'x'.repeat(300);
      Object.assign(mockData, {
        project: { name: 'reverie' },
        files: { a: big, b: big, c: big },
      });

      const result = await toolHandlers['reverie_context']({ tier: 'full' });
      expect(result.content[0].text).not.toContain('[trimmed:');
      expect(result.content[0].text).toContain('files.a');

      expect(logAuditMock).toHaveBeenCalledWith(
        expect.not.objectContaining({ degraded: true })
      );
    });

    it('reverie_context surfaces pathological-overflow notice when never-shed exceeds budget', async () => {
      mockConfig.bootstrap_max_response_bytes = 50;
      Object.assign(mockData, {
        project: { name: 'x'.repeat(500) },
        files: { shedme: 'x'.repeat(100) },
      });

      const result = await toolHandlers['reverie_context']({});
      expect(result.content[0].text).toContain('still exceeds budget');
      expect(result.content[0].text).toContain('bootstrap_max_response_bytes');
    });

    it('reverie_context under budget produces no degraded signal', async () => {
      mockConfig.bootstrap_max_response_bytes = 50 * 1024;
      Object.assign(mockData, { project: { name: 'reverie' } });

      const result = await toolHandlers['reverie_context']({});
      expect(result.content[0].text).not.toContain('[trimmed:');

      const auditCall = logAuditMock.mock.calls.find(c => (c[0] as { tool?: string }).tool === 'reverie_context');
      expect(auditCall).toBeDefined();
      const auditRow = auditCall![0] as Record<string, unknown>;
      expect(auditRow.degraded).toBeUndefined();
      expect(auditRow.shedNamespaces).toBeUndefined();
    });
  });

});
