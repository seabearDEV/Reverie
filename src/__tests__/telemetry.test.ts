import fs from 'fs';
import path from 'path';
import os from 'os';

let tmpDir: string;

// Mock getDataDirectory to point at our temp dir (avoids path caching issues)
vi.mock('../utils/paths', () => ({
  getDataDirectory: () => tmpDir,
  findProjectFile: () => null,
}));

// Import after mocks
import { logToolCall, loadTelemetry, computeStats, TelemetryEntry } from '../utils/telemetry';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-telemetry-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('logToolCall', () => {
  it('creates telemetry.jsonl and writes a valid entry', async () => {
    await logToolCall('reverie_get', 'arch.mcp');
    const content = fs.readFileSync(path.join(tmpDir, 'telemetry.jsonl'), 'utf8');
    const entry = JSON.parse(content.trim()) as TelemetryEntry;
    expect(entry.tool).toBe('reverie_get');
    expect(entry.op).toBe('read');
    expect(entry.ns).toBe('arch');
    expect(entry.session).toMatch(/^[a-f0-9]{8}$/);
    expect(entry.ts).toBeGreaterThan(0);
    expect(entry.src).toBe('mcp');
  });

  it('records cli source when specified', async () => {
    await logToolCall('reverie_get', 'arch.mcp', 'cli');
    const content = fs.readFileSync(path.join(tmpDir, 'telemetry.jsonl'), 'utf8');
    const entry = JSON.parse(content.trim()) as TelemetryEntry;
    expect(entry.src).toBe('cli');
  });

  it('records scope when specified', async () => {
    await logToolCall('reverie_set', 'arch.mcp', 'mcp', 'project');
    const content = fs.readFileSync(path.join(tmpDir, 'telemetry.jsonl'), 'utf8');
    const entry = JSON.parse(content.trim()) as TelemetryEntry;
    expect(entry.scope).toBe('project');
  });

  it('appends multiple entries', async () => {
    await logToolCall('reverie_set', 'project.name');
    await logToolCall('reverie_get', 'project.name');
    const entries = loadTelemetry();
    expect(entries).toHaveLength(2);
  });

  it('classifies writes correctly', async () => {
    await logToolCall('reverie_set', 'x');
    await logToolCall('reverie_copy', 'x');
    await logToolCall('reverie_import');
    await logToolCall('reverie_alias_set', 'a');
    await logToolCall('reverie_config_set');
    await logToolCall('reverie_rename', 'x');
    const entries = loadTelemetry();
    expect(entries.every(e => e.op === 'write')).toBe(true);
  });

  it('classifies removes correctly', async () => {
    await logToolCall('reverie_remove', 'x');
    await logToolCall('reverie_alias_remove', 'a');
    await logToolCall('reverie_reset');
    const entries = loadTelemetry();
    expect(entries.every(e => e.op === 'remove')).toBe(true);
  });

  it('classifies reads correctly', async () => {
    await logToolCall('reverie_get', 'x');
    await logToolCall('reverie_context');
    await logToolCall('reverie_find', 'term');
    await logToolCall('reverie_export');
    await logToolCall('reverie_alias_list');
    await logToolCall('reverie_config_get');
    await logToolCall('reverie_stale');
    await logToolCall('reverie_lint');
    const entries = loadTelemetry();
    expect(entries.every(e => e.op === 'read')).toBe(true);
  });

  it('classifies exec correctly', async () => {
    await logToolCall('reverie_run', 'cmd');
    const entries = loadTelemetry();
    expect(entries[0].op).toBe('exec');
  });

  it('extracts top-level namespace from dot-notation key', async () => {
    await logToolCall('reverie_get', 'arch.mcp.tools');
    const entries = loadTelemetry();
    expect(entries[0].ns).toBe('arch');
  });

  it('uses * for missing key', async () => {
    await logToolCall('reverie_context');
    const entries = loadTelemetry();
    expect(entries[0].ns).toBe('*');
  });

  it('uses full key when no dots', async () => {
    await logToolCall('reverie_get', 'toplevel');
    const entries = loadTelemetry();
    expect(entries[0].ns).toBe('toplevel');
  });

  it('writes synchronously when sync=true', () => {
    logToolCall('reverie_set', 'sync.test', 'cli', 'global', undefined, true);
    // File should exist immediately (sync write)
    const entries = loadTelemetry();
    expect(entries.length).toBe(1);
    expect(entries[0].tool).toBe('reverie_set');
    expect(entries[0].src).toBe('cli');
  });
});

describe('loadTelemetry', () => {
  it('returns empty array when no file exists', () => {
    expect(loadTelemetry()).toEqual([]);
  });

  it('skips malformed lines', () => {
    const telemetryPath = path.join(tmpDir, 'telemetry.jsonl');
    fs.writeFileSync(telemetryPath, '{"ts":1,"tool":"a","session":"x","op":"read","ns":"*"}\nnot json\n{"ts":2,"tool":"b","session":"x","op":"write","ns":"y"}\n');
    const entries = loadTelemetry();
    expect(entries).toHaveLength(2);
    expect(entries[0].tool).toBe('a');
    expect(entries[1].tool).toBe('b');
  });
});

describe('computeStats', () => {
  function writeEntries(entries: TelemetryEntry[]) {
    const telemetryPath = path.join(tmpDir, 'telemetry.jsonl');
    const lines = entries.map(e => JSON.stringify(e)).join('\n') + '\n';
    fs.writeFileSync(telemetryPath, lines);
  }

  it('returns zero stats when no data', () => {
    const stats = computeStats();
    expect(stats.totalCalls).toBe(0);
    expect(stats.mcpSessions).toBe(0);
    expect(stats.mcpCalls).toBe(0);
    expect(stats.cliCalls).toBe(0);
    expect(stats.scopeBreakdown).toEqual({ project: 0, global: 0, unscoped: 0 });
  });

  it('computes bootstrap rate correctly', () => {
    const now = Date.now();
    writeEntries([
      // Session 1: bootstrapped (context first)
      { ts: now - 100, tool: 'reverie_context', session: 's1', op: 'read', ns: '*' },
      { ts: now - 90, tool: 'reverie_get', session: 's1', op: 'read', ns: 'arch' },
      // Session 2: not bootstrapped (get first)
      { ts: now - 80, tool: 'reverie_get', session: 's2', op: 'read', ns: 'arch' },
      { ts: now - 70, tool: 'reverie_context', session: 's2', op: 'read', ns: '*' },
    ]);
    const stats = computeStats();
    expect(stats.mcpSessions).toBe(2);
    expect(stats.bootstrapRate).toBe(0.5);
  });

  it('computes write-back rate correctly', () => {
    const now = Date.now();
    writeEntries([
      // Session 1: wrote back
      { ts: now - 100, tool: 'reverie_context', session: 's1', op: 'read', ns: '*' },
      { ts: now - 90, tool: 'reverie_set', session: 's1', op: 'write', ns: 'arch' },
      // Session 2: read only
      { ts: now - 80, tool: 'reverie_context', session: 's2', op: 'read', ns: '*' },
      { ts: now - 70, tool: 'reverie_get', session: 's2', op: 'read', ns: 'arch' },
    ]);
    const stats = computeStats();
    expect(stats.writeBackRate).toBe(0.5);
  });

  it('computes read:write ratio', () => {
    const now = Date.now();
    writeEntries([
      { ts: now - 100, tool: 'reverie_get', session: 's1', op: 'read', ns: 'a' },
      { ts: now - 90, tool: 'reverie_get', session: 's1', op: 'read', ns: 'b' },
      { ts: now - 80, tool: 'reverie_get', session: 's1', op: 'read', ns: 'c' },
      { ts: now - 70, tool: 'reverie_set', session: 's1', op: 'write', ns: 'a' },
    ]);
    const stats = computeStats();
    expect(stats.reads).toBe(3);
    expect(stats.writes).toBe(1);
    expect(stats.readWriteRatio).toBe('3.0:1');
  });

  it('tracks namespace coverage', () => {
    const now = Date.now();
    writeEntries([
      { ts: now - 100, tool: 'reverie_get', session: 's1', op: 'read', ns: 'arch' },
      { ts: now - 90, tool: 'reverie_set', session: 's1', op: 'write', ns: 'arch' },
      { ts: now - 80, tool: 'reverie_get', session: 's1', op: 'read', ns: 'commands' },
    ]);
    const stats = computeStats();
    expect(stats.namespaceCoverage.arch).toEqual({ reads: 1, writes: 1, lastWrite: now - 90 });
    expect(stats.namespaceCoverage.commands).toEqual({ reads: 1, writes: 0, lastWrite: undefined });
  });

  // Round-2 regression: namespace tracking used to be polluted by failed
  // operations (rejected validator writes), search-tool keys (regex patterns
  // sliced on `.` to make phantom namespaces like `^arch\`), and alias-tool
  // keys (alias names treated as entry namespaces). The filter excludes all
  // three classes so the dashboard shows only real namespace activity.
  describe('namespace coverage filters (round-2 regression)', () => {
    it('excludes failed operations', () => {
      const now = Date.now();
      writeEntries([
        { ts: now - 100, tool: 'reverie_set', session: 's1', op: 'write', ns: 'arch' }, // success default
        { ts: now - 90, tool: 'reverie_set', session: 's1', op: 'write', ns: 'rejected', success: false },
      ]);
      const stats = computeStats();
      expect(stats.namespaceCoverage.arch).toBeDefined();
      expect(stats.namespaceCoverage.rejected).toBeUndefined();
    });

    it('excludes reverie_find keys', () => {
      const now = Date.now();
      writeEntries([
        { ts: now - 100, tool: 'reverie_get', session: 's1', op: 'read', ns: 'arch' },
        { ts: now - 90, tool: 'reverie_find', session: 's1', op: 'read', ns: '^arch\\' },
      ]);
      const stats = computeStats();
      expect(stats.namespaceCoverage.arch).toBeDefined();
      expect(stats.namespaceCoverage['^arch\\']).toBeUndefined();
    });

    it('excludes reverie_alias_set / reverie_alias_remove keys', () => {
      const now = Date.now();
      writeEntries([
        { ts: now - 100, tool: 'reverie_set', session: 's1', op: 'write', ns: 'arch' },
        { ts: now - 90, tool: 'reverie_alias_set', session: 's1', op: 'write', ns: 'flog_alias' },
        { ts: now - 80, tool: 'reverie_alias_remove', session: 's1', op: 'write', ns: 'old_alias' },
      ]);
      const stats = computeStats();
      expect(stats.namespaceCoverage.arch).toBeDefined();
      expect(stats.namespaceCoverage.flog_alias).toBeUndefined();
      expect(stats.namespaceCoverage.old_alias).toBeUndefined();
    });

    // Regression: a telemetry entry whose `ns` is `__proto__` (or `constructor`
    // / `prototype`) used to poison Object.prototype via `nsCoverage[e.ns]++`,
    // because a plain `{}` resolves those keys up the prototype chain. The
    // pollution then silently broke the MCP SDK's request dispatch on the next
    // tool call (server stopped responding mid-session). nsCoverage and the
    // other dict accumulators in computeStats are now Object.create(null).
    it('does not pollute Object.prototype when ns is __proto__/constructor/prototype', () => {
      const now = Date.now();
      writeEntries([
        { ts: now - 100, tool: 'reverie_get', session: 's1', op: 'read', ns: '__proto__' },
        { ts: now - 90, tool: 'reverie_set', session: 's1', op: 'write', ns: '__proto__' },
        { ts: now - 80, tool: 'reverie_get', session: 's1', op: 'read', ns: 'constructor' },
        { ts: now - 70, tool: 'reverie_get', session: 's1', op: 'read', ns: 'prototype' },
        { ts: now - 60, tool: 'reverie_get', session: 's1', op: 'read', ns: 'arch' },
      ]);
      // Run computeStats — must not throw and must not mutate Object.prototype.
      const stats = computeStats();
      // Sentinel: a fresh object must not have inherited any of the
      // counter properties from a polluted Object.prototype.
      const probe: Record<string, unknown> = {};
      expect(probe.reads).toBeUndefined();
      expect(probe.writes).toBeUndefined();
      expect(probe.lastWrite).toBeUndefined();
      expect(probe.calls).toBeUndefined();
      expect(probe.tokensSaved).toBeUndefined();
      expect(probe.hits).toBeUndefined();
      // Sanity: legit ns still tracked.
      expect(stats.namespaceCoverage.arch).toBeDefined();
    });
  });

  it('filters by period', () => {
    const now = Date.now();
    const day = 86400000;
    writeEntries([
      { ts: now - 60 * day, tool: 'reverie_get', session: 'old', op: 'read', ns: 'a' },
      { ts: now - 1000, tool: 'reverie_get', session: 'new', op: 'read', ns: 'b' },
    ]);
    const stats7d = computeStats(7);
    expect(stats7d.totalCalls).toBe(1);
    expect(stats7d.mcpSessions).toBe(1);

    const statsAll = computeStats(0);
    expect(statsAll.totalCalls).toBe(2);
    expect(statsAll.mcpSessions).toBe(2);
  });

  it('separates MCP and CLI stats', () => {
    const now = Date.now();
    writeEntries([
      // MCP session
      { ts: now - 100, tool: 'reverie_context', session: 'mcp1', op: 'read', ns: '*', src: 'mcp' },
      { ts: now - 90, tool: 'reverie_set', session: 'mcp1', op: 'write', ns: 'arch', src: 'mcp' },
      // CLI calls
      { ts: now - 80, tool: 'reverie_get', session: 'cli1', op: 'read', ns: 'arch', src: 'cli' },
      { ts: now - 70, tool: 'reverie_set', session: 'cli2', op: 'write', ns: 'project', src: 'cli' },
    ]);
    const stats = computeStats();
    expect(stats.mcpSessions).toBe(1);
    expect(stats.mcpCalls).toBe(2);
    expect(stats.cliCalls).toBe(2);
    expect(stats.totalCalls).toBe(4);
    // Bootstrap rate only considers MCP sessions
    expect(stats.bootstrapRate).toBe(1);
    expect(stats.writeBackRate).toBe(1);
  });

  it('treats legacy entries without src as MCP', () => {
    const now = Date.now();
    writeEntries([
      { ts: now - 100, tool: 'reverie_context', session: 's1', op: 'read', ns: '*' },
      { ts: now - 90, tool: 'reverie_get', session: 's1', op: 'read', ns: 'arch' },
    ]);
    const stats = computeStats();
    expect(stats.mcpSessions).toBe(1);
    expect(stats.mcpCalls).toBe(2);
    expect(stats.cliCalls).toBe(0);
  });

  it('tracks scope breakdown', () => {
    const now = Date.now();
    writeEntries([
      { ts: now - 100, tool: 'reverie_set', session: 's1', op: 'write', ns: 'a', scope: 'project' },
      { ts: now - 90, tool: 'reverie_set', session: 's1', op: 'write', ns: 'b', scope: 'project' },
      { ts: now - 80, tool: 'reverie_set', session: 's1', op: 'write', ns: 'c', scope: 'global' },
      { ts: now - 70, tool: 'reverie_get', session: 's1', op: 'read', ns: 'd' },
    ]);
    const stats = computeStats();
    expect(stats.scopeBreakdown).toEqual({ project: 2, global: 1, unscoped: 1 });
  });

  it('returns top tools sorted by count', () => {
    const now = Date.now();
    writeEntries([
      { ts: now - 100, tool: 'reverie_get', session: 's1', op: 'read', ns: 'a' },
      { ts: now - 90, tool: 'reverie_get', session: 's1', op: 'read', ns: 'b' },
      { ts: now - 80, tool: 'reverie_set', session: 's1', op: 'write', ns: 'c' },
      { ts: now - 70, tool: 'reverie_context', session: 's1', op: 'read', ns: '*' },
    ]);
    const stats = computeStats();
    expect(stats.topTools[0]).toEqual({ tool: 'reverie_get', count: 2 });
  });

  it('computes hit rate from entries with hit field', () => {
    const now = Date.now();
    writeEntries([
      { ts: now - 100, tool: 'reverie_get', session: 's1', op: 'read', ns: 'a', hit: true },
      { ts: now - 90, tool: 'reverie_get', session: 's1', op: 'read', ns: 'b', hit: true },
      { ts: now - 80, tool: 'reverie_get', session: 's1', op: 'read', ns: 'c', hit: false },
      { ts: now - 70, tool: 'reverie_get', session: 's1', op: 'read', ns: 'd' }, // no hit field — excluded
    ]);
    const stats = computeStats();
    expect(stats.hits).toBe(2);
    expect(stats.misses).toBe(1);
    expect(stats.hitRate).toBeCloseTo(2 / 3);
  });

  it('computes redundant write rate', () => {
    const now = Date.now();
    writeEntries([
      { ts: now - 100, tool: 'reverie_set', session: 's1', op: 'write', ns: 'a', redundant: true },
      { ts: now - 90, tool: 'reverie_set', session: 's1', op: 'write', ns: 'b' },
      { ts: now - 80, tool: 'reverie_set', session: 's1', op: 'write', ns: 'c' },
    ]);
    const stats = computeStats();
    expect(stats.redundantWrites).toBe(1);
    expect(stats.redundantRate).toBeCloseTo(1 / 3);
  });

  it('computes avg session duration from multi-call sessions', () => {
    const now = Date.now();
    writeEntries([
      { ts: now - 10000, tool: 'reverie_context', session: 's1', op: 'read', ns: '*' },
      { ts: now - 5000, tool: 'reverie_get', session: 's1', op: 'read', ns: 'a' },
      { ts: now - 1000, tool: 'reverie_set', session: 's2', op: 'write', ns: 'b' },
    ]);
    const stats = computeStats();
    // s1: 10000-5000 = 5000ms, s2: single call — skipped
    expect(stats.avgSessionDurationMs).toBe(5000);
  });

  it('computes total and avg response bytes', () => {
    const now = Date.now();
    writeEntries([
      { ts: now - 100, tool: 'reverie_get', session: 's1', op: 'read', ns: 'a', responseSize: 100 },
      { ts: now - 90, tool: 'reverie_get', session: 's1', op: 'read', ns: 'b', responseSize: 200 },
      { ts: now - 80, tool: 'reverie_set', session: 's1', op: 'write', ns: 'c' }, // no responseSize
    ]);
    const stats = computeStats();
    expect(stats.totalResponseBytes).toBe(300);
    expect(stats.avgResponseBytes).toBe(150);
  });

  it('computes avg duration from entries with duration field', () => {
    const now = Date.now();
    writeEntries([
      { ts: now - 100, tool: 'reverie_get', session: 's1', op: 'read', ns: 'a', duration: 10 },
      { ts: now - 90, tool: 'reverie_set', session: 's1', op: 'write', ns: 'b', duration: 20 },
    ]);
    const stats = computeStats();
    expect(stats.avgDurationMs).toBe(15);
  });

  it('computes trend when previous period has data', () => {
    const now = Date.now();
    const DAY = 86400000;
    writeEntries([
      // Previous period (8-15 days ago)
      { ts: now - 10 * DAY, tool: 'reverie_get', session: 'p1', op: 'read', ns: 'a' },
      { ts: now - 9 * DAY, tool: 'reverie_set', session: 'p1', op: 'write', ns: 'b' },
      // Current period (within 7 days)
      { ts: now - 3 * DAY, tool: 'reverie_get', session: 's1', op: 'read', ns: 'a' },
      { ts: now - 2 * DAY, tool: 'reverie_set', session: 's1', op: 'write', ns: 'b' },
      { ts: now - 1 * DAY, tool: 'reverie_get', session: 's2', op: 'read', ns: 'c' },
    ]);
    const stats = computeStats(7);
    expect(stats.trend).toBeDefined();
    expect(stats.trend!.callsDelta).toBeCloseTo(50); // 3 vs 2 = +50%
  });

  it('returns no trend for all-time period', () => {
    const now = Date.now();
    writeEntries([
      { ts: now - 100, tool: 'reverie_get', session: 's1', op: 'read', ns: 'a' },
    ]);
    const stats = computeStats(0); // all-time
    expect(stats.trend).toBeUndefined();
  });

  it('counts calls per project', () => {
    const now = Date.now();
    writeEntries([
      { ts: now - 100, tool: 'reverie_get', session: 's1', op: 'read', ns: 'a', project: '/repo/one' },
      { ts: now - 90, tool: 'reverie_set', session: 's1', op: 'write', ns: 'b', project: '/repo/one' },
      { ts: now - 80, tool: 'reverie_get', session: 's1', op: 'read', ns: 'c', project: '/repo/two' },
    ]);
    const stats = computeStats();
    expect(stats.projectBreakdown['/repo/one']).toBe(2);
    expect(stats.projectBreakdown['/repo/two']).toBe(1);
  });

  it('groups path variants of the same repo by projectId (#141)', () => {
    const now = Date.now();
    writeEntries([
      { ts: now - 100, tool: 'reverie_get', session: 's1', op: 'read', ns: 'a', project: '/old/Path/Repo', projectId: 'github.com/owner/repo' },
      { ts: now - 90, tool: 'reverie_set', session: 's1', op: 'write', ns: 'b', project: '/new/path/repo', projectId: 'github.com/owner/repo' },
      // pre-#141 row: no projectId, groups by raw path
      { ts: now - 80, tool: 'reverie_get', session: 's1', op: 'read', ns: 'c', project: '/legacy/path' },
    ]);
    const stats = computeStats();
    expect(stats.projectBreakdown['github.com/owner/repo']).toBe(2);
    expect(stats.projectBreakdown['/legacy/path']).toBe(1);
    expect(stats.projectBreakdown['/old/Path/Repo']).toBeUndefined();
  });

  it('segments bulk burst writes from organic writes (#142)', () => {
    const now = Date.now();
    // A bulk-init run: 6 writes 50ms apart, across DIFFERENT phantom
    // sessions (un-bridged CLI = one session per process).
    const burst = Array.from({ length: 6 }, (_, i) => ({
      ts: now - 60000 + i * 50, tool: 'reverie_set', session: `p${i}`, op: 'write' as const, ns: 'arch',
    }));
    // Organic activity: spread out well beyond the burst gap.
    const organic = [
      { ts: now - 30000, tool: 'reverie_set', session: 's1', op: 'write' as const, ns: 'context' },
      { ts: now - 10000, tool: 'reverie_get', session: 's1', op: 'read' as const, ns: 'context' },
      { ts: now - 5000, tool: 'reverie_get', session: 's1', op: 'read' as const, ns: 'arch' },
    ];
    writeEntries([...burst, ...organic]);
    const stats = computeStats();
    expect(stats.writes).toBe(7);
    expect(stats.bulkWrites).toBe(6);
    expect(stats.organicWrites).toBe(1);
    expect(stats.organicReadWriteRatio).toBe('2.0:1');
  });

  it('does not classify short close-together runs as bulk (#142)', () => {
    const now = Date.now();
    // 4 quick writes — below the 5-run threshold.
    writeEntries(Array.from({ length: 4 }, (_, i) => ({
      ts: now - 5000 + i * 100, tool: 'reverie_set', session: 's1', op: 'write' as const, ns: 'a',
    })));
    const stats = computeStats();
    expect(stats.bulkWrites).toBe(0);
    expect(stats.organicWrites).toBe(4);
  });

  it('estimates tokens saved from cache hits', () => {
    const now = Date.now();
    writeEntries([
      { ts: now - 100, tool: 'reverie_get', session: 's1', op: 'read', ns: 'a', hit: true, responseSize: 400 },
      { ts: now - 90, tool: 'reverie_context', session: 's1', op: 'read', ns: '*', hit: true, responseSize: 2000 },
      { ts: now - 80, tool: 'reverie_get', session: 's1', op: 'read', ns: 'b', hit: false, responseSize: 100 },
    ]);
    const stats = computeStats();
    // hits: 400 + 2000 = 2400 bytes / 4 = 600 tokens
    expect(stats.estimatedTokensSaved).toBe(600);
    // bootstrap: 2000 / 4 = 500 tokens
    expect(stats.estimatedTokensSavedBootstrap).toBe(500);
  });

  it('computes exploration tokens saved by namespace', () => {
    const now = Date.now();
    writeEntries([
      { ts: now - 100, tool: 'reverie_get', session: 's1', op: 'read', ns: 'files', hit: true, responseSize: 200 },
      { ts: now - 90, tool: 'reverie_get', session: 's1', op: 'read', ns: 'files', hit: true, responseSize: 200 },
      { ts: now - 80, tool: 'reverie_get', session: 's1', op: 'read', ns: 'arch', hit: true, responseSize: 300 },
      { ts: now - 70, tool: 'reverie_get', session: 's1', op: 'read', ns: 'commands', hit: true, responseSize: 100 },
      { ts: now - 60, tool: 'reverie_get', session: 's1', op: 'read', ns: 'commands', hit: false, responseSize: 50 },
    ]);
    const stats = computeStats();
    // files: 2 hits × 2000 = 4000, arch: 1 × 3000 = 3000, commands: 1 × 1000 = 1000
    expect(stats.explorationBreakdown['files']).toEqual({ hits: 2, tokensSaved: 4000 });
    expect(stats.explorationBreakdown['arch']).toEqual({ hits: 1, tokensSaved: 3000 });
    expect(stats.explorationBreakdown['commands']).toEqual({ hits: 1, tokensSaved: 1000 });
    expect(stats.estimatedExplorationTokensSaved).toBe(8000);
  });

  it('computes bootstrap exploration cost from response size', () => {
    const now = Date.now();
    // 8000 bytes ≈ 100 entries at ~80 bytes each → 100 × 200 = 20000 tokens
    // delivery floor: 8000 / 4 = 2000 → max(2000, 20000) = 20000
    writeEntries([
      { ts: now - 100, tool: 'reverie_context', session: 's1', op: 'read', ns: '*', hit: true, responseSize: 8000 },
    ]);
    const stats = computeStats();
    expect(stats.explorationBreakdown['bootstrap']).toEqual({ hits: 1, tokensSaved: 20000 });
  });

  it('uses default exploration cost for unknown namespaces', () => {
    const now = Date.now();
    writeEntries([
      { ts: now - 100, tool: 'reverie_get', session: 's1', op: 'read', ns: 'custom', hit: true, responseSize: 100 },
    ]);
    const stats = computeStats();
    expect(stats.explorationBreakdown['custom']).toEqual({ hits: 1, tokensSaved: 1000 });
  });

  it('computes redundant write token savings', () => {
    const now = Date.now();
    writeEntries([
      { ts: now - 100, tool: 'reverie_set', session: 's1', op: 'write', ns: 'a', redundant: true },
      { ts: now - 90, tool: 'reverie_set', session: 's1', op: 'write', ns: 'b', redundant: true },
      { ts: now - 80, tool: 'reverie_set', session: 's1', op: 'write', ns: 'c', redundant: false },
    ]);
    const stats = computeStats();
    expect(stats.estimatedRedundantWriteTokensSaved).toBe(300); // 2 × 150
  });

  it('computes total as exploration + redundant', () => {
    const now = Date.now();
    writeEntries([
      { ts: now - 100, tool: 'reverie_get', session: 's1', op: 'read', ns: 'files', hit: true, responseSize: 200 },
      { ts: now - 90, tool: 'reverie_set', session: 's1', op: 'write', ns: 'a', redundant: true },
    ]);
    const stats = computeStats();
    // exploration: 1 files hit × 2000 = 2000, redundant: 1 × 150 = 150
    expect(stats.estimatedTotalTokensSaved).toBe(2150);
  });

  it('breaks down calls by agent', () => {
    const now = Date.now();
    writeEntries([
      { ts: now - 100, tool: 'reverie_get', session: 's1', op: 'read', ns: 'a', agent: 'claude' },
      { ts: now - 90, tool: 'reverie_set', session: 's1', op: 'write', ns: 'b', agent: 'claude' },
      { ts: now - 80, tool: 'reverie_get', session: 's1', op: 'read', ns: 'c', agent: 'cursor' },
      { ts: now - 70, tool: 'reverie_set', session: 's1', op: 'write', ns: 'd' }, // no agent — excluded
    ]);
    const stats = computeStats();
    expect(stats.agentBreakdown['claude']).toEqual({ calls: 2, reads: 1, writes: 1 });
    expect(stats.agentBreakdown['cursor']).toEqual({ calls: 1, reads: 1, writes: 0 });
    expect(stats.agentBreakdown['(unknown)']).toBeUndefined(); // no-agent entries excluded
  });

  it('handles zero MCP sessions without divide-by-zero', () => {
    const now = Date.now();
    writeEntries([
      { ts: now - 100, tool: 'reverie_get', session: 's1', op: 'read', ns: 'a', src: 'cli' },
    ]);
    const stats = computeStats();
    expect(stats.mcpSessions).toBe(0);
    expect(stats.bootstrapRate).toBe(0);
    expect(stats.writeBackRate).toBe(0);
  });
});
