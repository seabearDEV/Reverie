/**
 * Advanced telemetry computeStats boundary tests.
 *
 * Covers: edge cases in exploration-weighted token savings,
 * trend math, single-entry sessions, empty data, ratio edge cases.
 */
import fs from 'fs';
import path from 'path';
import os from 'os';

let tmpDir: string;

vi.mock('../utils/paths', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../utils/paths')>();
  return {
    ...orig,
    getDataDirectory: () => tmpDir,
  };
});

import { computeStats, loadTelemetry, TelemetryEntry, EXPLORATION_COST, MissPath } from '../utils/telemetry';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-telemetry-adv-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeEntries(entries: TelemetryEntry[]) {
  const telemetryPath = path.join(tmpDir, 'telemetry.jsonl');
  fs.writeFileSync(telemetryPath, entries.map(e => JSON.stringify(e)).join('\n') + '\n');
}

describe('computeStats — boundary cases', () => {
  it('handles a single-call session (no duration)', () => {
    const now = Date.now();
    writeEntries([
      { ts: now, tool: 'reverie_get', session: 'solo', op: 'read', ns: 'project' },
    ]);
    const stats = computeStats();
    expect(stats.avgSessionDurationMs).toBeUndefined();
    expect(stats.avgSessionCalls).toBe(1);
  });

  it('handles read-only data (infinite ratio)', () => {
    const now = Date.now();
    writeEntries([
      { ts: now - 100, tool: 'reverie_get', session: 's1', op: 'read', ns: 'a' },
      { ts: now - 90, tool: 'reverie_get', session: 's1', op: 'read', ns: 'b' },
    ]);
    const stats = computeStats();
    expect(stats.readWriteRatio).toBe('∞:1');
  });

  it('handles write-only data', () => {
    const now = Date.now();
    writeEntries([
      { ts: now - 100, tool: 'reverie_set', session: 's1', op: 'write', ns: 'a' },
    ]);
    const stats = computeStats();
    expect(stats.readWriteRatio).toBe('0.0:1');
  });

  it('handles no reads and no writes', () => {
    const now = Date.now();
    writeEntries([
      { ts: now, tool: 'reverie_run', session: 's1', op: 'exec', ns: 'commands' },
    ]);
    const stats = computeStats();
    expect(stats.readWriteRatio).toBe('0:0');
  });

  it('hitRate is undefined when no reads have hit field', () => {
    const now = Date.now();
    writeEntries([
      { ts: now, tool: 'reverie_get', session: 's1', op: 'read', ns: 'a' },
    ]);
    const stats = computeStats();
    expect(stats.hitRate).toBeUndefined();
  });

  it('redundantRate is undefined when no writes exist', () => {
    const now = Date.now();
    writeEntries([
      { ts: now, tool: 'reverie_get', session: 's1', op: 'read', ns: 'a' },
    ]);
    const stats = computeStats();
    expect(stats.redundantRate).toBeUndefined();
  });

  it('avgResponseBytes is undefined when no entries have responseSize', () => {
    const now = Date.now();
    writeEntries([
      { ts: now, tool: 'reverie_get', session: 's1', op: 'read', ns: 'a' },
    ]);
    const stats = computeStats();
    expect(stats.avgResponseBytes).toBeUndefined();
    expect(stats.totalResponseBytes).toBe(0);
  });

  it('avgDurationMs is undefined when no entries have duration', () => {
    const now = Date.now();
    writeEntries([
      { ts: now, tool: 'reverie_get', session: 's1', op: 'read', ns: 'a' },
    ]);
    const stats = computeStats();
    expect(stats.avgDurationMs).toBeUndefined();
  });

  it('trend callsDelta handles zero previous calls', () => {
    const now = Date.now();
    const DAY = 86400000;
    writeEntries([
      // Only current period (within 7 days), nothing in previous period
      { ts: now - 1000, tool: 'reverie_get', session: 's1', op: 'read', ns: 'a' },
    ]);
    const stats = computeStats(7);
    // No previous period data → no trend
    expect(stats.trend).toBeUndefined();
  });

  it('trend with equal periods shows 0% change', () => {
    const now = Date.now();
    const DAY = 86400000;
    writeEntries([
      // Previous period (8-14 days ago)
      { ts: now - 10 * DAY, tool: 'reverie_get', session: 'p1', op: 'read', ns: 'a' },
      { ts: now - 9 * DAY, tool: 'reverie_set', session: 'p1', op: 'write', ns: 'b' },
      // Current period (within 7 days) — same count
      { ts: now - 3 * DAY, tool: 'reverie_get', session: 's1', op: 'read', ns: 'a' },
      { ts: now - 2 * DAY, tool: 'reverie_set', session: 's1', op: 'write', ns: 'b' },
    ]);
    const stats = computeStats(7);
    expect(stats.trend).toBeDefined();
    expect(stats.trend!.callsDelta).toBeCloseTo(0);
  });

  it('exploration cost map exports known namespaces', () => {
    expect(EXPLORATION_COST['files']).toBe(2000);
    expect(EXPLORATION_COST['arch']).toBe(3000);
    expect(EXPLORATION_COST['context']).toBe(3000);
    expect(EXPLORATION_COST['commands']).toBe(1000);
    expect(EXPLORATION_COST['conventions']).toBe(1500);
    expect(EXPLORATION_COST['project']).toBe(500);
    expect(EXPLORATION_COST['deps']).toBe(800);
  });

  it('bootstrap with tiny response still gets floor cost', () => {
    const now = Date.now();
    // 40 bytes → ~0.5 entries → max(10, 0.5*200=100) → 100 tokens
    writeEntries([
      { ts: now, tool: 'reverie_context', session: 's1', op: 'read', ns: '*', hit: true, responseSize: 40 },
    ]);
    const stats = computeStats();
    const bsTokens = stats.explorationBreakdown['bootstrap']?.tokensSaved ?? 0;
    // delivery floor = 40/4=10, approx entries = round(40/80)=1 → 1*200=200
    // max(10, 200) = 200
    expect(bsTokens).toBe(200);
  });

  it('bootstrap with large response uses entry estimate', () => {
    const now = Date.now();
    // 16000 bytes → ~200 entries → max(4000, 200*200=40000) → 40000
    writeEntries([
      { ts: now, tool: 'reverie_context', session: 's1', op: 'read', ns: '*', hit: true, responseSize: 16000 },
    ]);
    const stats = computeStats();
    expect(stats.explorationBreakdown['bootstrap']?.tokensSaved).toBe(40000);
  });

  it('multiple sessions compute avg duration correctly', () => {
    const now = Date.now();
    writeEntries([
      // Session 1: 5000ms span
      { ts: now - 15000, tool: 'reverie_context', session: 's1', op: 'read', ns: '*' },
      { ts: now - 10000, tool: 'reverie_get', session: 's1', op: 'read', ns: 'a' },
      // Session 2: 3000ms span
      { ts: now - 8000, tool: 'reverie_context', session: 's2', op: 'read', ns: '*' },
      { ts: now - 5000, tool: 'reverie_set', session: 's2', op: 'write', ns: 'b' },
      // Session 3: 1 call only — excluded from duration
      { ts: now - 1000, tool: 'reverie_get', session: 's3', op: 'read', ns: 'c' },
    ]);
    const stats = computeStats();
    // (5000 + 3000) / 2 = 4000
    expect(stats.avgSessionDurationMs).toBe(4000);
  });

  it('handles many agents in breakdown', () => {
    const now = Date.now();
    const agents = ['claude', 'cursor', 'copilot', 'chatgpt', 'windsurf'];
    const entries: TelemetryEntry[] = agents.map((agent, i) => ({
      ts: now - i * 1000,
      tool: 'reverie_get',
      session: 's1',
      op: 'read' as const,
      ns: 'a',
      agent,
    }));
    writeEntries(entries);
    const stats = computeStats();
    for (const agent of agents) {
      expect(stats.agentBreakdown[agent]).toBeDefined();
      expect(stats.agentBreakdown[agent].calls).toBe(1);
    }
  });

  it('period "all" label when periodDays is 0', () => {
    writeEntries([
      { ts: Date.now(), tool: 'reverie_get', session: 's1', op: 'read', ns: 'a' },
    ]);
    const stats = computeStats(0);
    expect(stats.period).toBe('all');
  });

  it('period label includes day count', () => {
    writeEntries([
      { ts: Date.now(), tool: 'reverie_get', session: 's1', op: 'read', ns: 'a' },
    ]);
    const stats = computeStats(30);
    expect(stats.period).toBe('30d');
  });
});

describe('computeStats — net savings and calibration', () => {
  function writeMissPaths(records: MissPath[]) {
    fs.writeFileSync(
      path.join(tmpDir, 'miss-paths.jsonl'),
      records.map(r => JSON.stringify(r)).join('\n') + '\n',
    );
  }

  it('computes deliveryCostTokens and netTokensSaved', () => {
    const now = Date.now();
    writeEntries([
      // Read hit with responseSize → delivery cost = 400/4 = 100 tokens
      { ts: now, tool: 'reverie_get', session: 's1', op: 'read', ns: 'arch', hit: true, responseSize: 400 },
    ]);
    const stats = computeStats();
    // deliveryCost = estimatedTokensSaved = 400/4 = 100
    expect(stats.deliveryCostTokens).toBe(100);
    // estimatedTotalTokensSaved uses EXPLORATION_COST[arch] = 3000 for the one hit
    expect(stats.estimatedTotalTokensSaved).toBe(3000);
    // net = 3000 - 100 = 2900
    expect(stats.netTokensSaved).toBe(2900);
  });

  it('netTokensSaved can be negative when delivery cost exceeds exploration value', () => {
    const now = Date.now();
    // Large response for a cheap namespace (project: 500 tokens)
    writeEntries([
      { ts: now, tool: 'reverie_get', session: 's1', op: 'read', ns: 'project', hit: true, responseSize: 4000 },
    ]);
    const stats = computeStats();
    // deliveryCost = 4000/4 = 1000
    // exploration = EXPLORATION_COST[project] = 500
    // net = 500 - 1000 = -500
    expect(stats.netTokensSaved).toBe(-500);
  });

  it('populates calibration field with static source when no miss-paths', () => {
    const now = Date.now();
    writeEntries([
      { ts: now, tool: 'reverie_get', session: 's1', op: 'read', ns: 'arch', hit: true, responseSize: 100 },
      { ts: now, tool: 'reverie_get', session: 's1', op: 'read', ns: 'files', hit: true, responseSize: 100 },
    ]);
    const stats = computeStats();
    expect(stats.calibration['arch']).toBeDefined();
    expect(stats.calibration['arch'].source).toBe('static');
    expect(stats.calibration['files']).toBeDefined();
    expect(stats.calibration['files'].source).toBe('static');
  });

  it('uses observed costs when miss-paths.jsonl has sufficient data', () => {
    const now = Date.now();
    writeEntries([
      { ts: now, tool: 'reverie_get', session: 's1', op: 'read', ns: 'arch', hit: true, responseSize: 100 },
    ]);
    // 6 writeback miss-paths for arch with explorationBytes = 800 each → 800/4 = 200 tokens median
    writeMissPaths(Array.from({ length: 6 }, (_, i) => ({
      ts: i, session: `s${i}`, namespace: 'arch', key: 'arch.x',
      toolCalls: 2, explorationBytes: 800,
      resolution: 'writeback' as const, resolvedAt: i + 100,
    })));
    const stats = computeStats();
    expect(stats.calibration['arch'].source).toBe('observed');
    expect(stats.calibration['arch'].cost).toBe(200);
    // Exploration tokens for the 1 hit = 200 (observed), not 3000 (static)
    expect(stats.explorationBreakdown['arch']?.tokensSaved).toBe(200);
  });

  it('deliveryCostTokens and netTokensSaved are 0 when no hits', () => {
    const now = Date.now();
    writeEntries([
      { ts: now, tool: 'reverie_get', session: 's1', op: 'read', ns: 'arch' },
    ]);
    const stats = computeStats();
    expect(stats.deliveryCostTokens).toBe(0);
    expect(stats.netTokensSaved).toBe(0);
  });

  it('calibration is empty when no read hits', () => {
    const now = Date.now();
    writeEntries([
      { ts: now, tool: 'reverie_set', session: 's1', op: 'write', ns: 'arch' },
    ]);
    const stats = computeStats();
    expect(Object.keys(stats.calibration)).toHaveLength(0);
  });
});

describe('loadTelemetry — edge cases', () => {
  it('handles empty file', () => {
    fs.writeFileSync(path.join(tmpDir, 'telemetry.jsonl'), '');
    expect(loadTelemetry()).toEqual([]);
  });

  it('handles file with only newlines', () => {
    fs.writeFileSync(path.join(tmpDir, 'telemetry.jsonl'), '\n\n\n');
    expect(loadTelemetry()).toEqual([]);
  });

  it('handles very large log file', () => {
    const entry = { ts: Date.now(), tool: 'reverie_get', session: 's1', op: 'read', ns: 'a' };
    const line = JSON.stringify(entry);
    // Write 1000 entries
    const content = (line + '\n').repeat(1000);
    fs.writeFileSync(path.join(tmpDir, 'telemetry.jsonl'), content);
    const entries = loadTelemetry();
    expect(entries.length).toBe(1000);
  });
});
