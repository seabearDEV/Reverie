/**
 * Tests for MissWindowTracker, miss-path persistence, and getExplorationCost calibration.
 */
import fs from 'fs';
import path from 'path';
import os from 'os';

let tmpDir: string;

vi.mock('../utils/paths', () => ({
  getDataDirectory: () => tmpDir,
  findProjectFile: () => null,
}));

import {
  MissWindowTracker,
  MissPath,
  appendMissPath,
  loadMissPaths,
  getExplorationCost,
  EXPLORATION_COST,
} from '../utils/telemetry';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-miss-path-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── MissWindowTracker ────────────────────────────────────────────────

describe('MissWindowTracker', () => {
  it('opens a window on read miss and closes as writeback on reverie_set', () => {
    const tracker = new MissWindowTracker();

    // Read miss on arch namespace
    const closed1 = tracker.onToolCall({
      session: 's1', tool: 'reverie_get', namespace: 'arch', key: 'arch.mcp',
      op: 'read', hit: false, responseSize: 0,
    });
    expect(closed1).toHaveLength(0);
    expect(tracker.openCount).toBe(1);

    // Intermediate call accumulates
    const closed2 = tracker.onToolCall({
      session: 's1', tool: 'reverie_get', namespace: 'files', key: 'files.entry',
      op: 'read', hit: false, responseSize: 500,
    });
    expect(closed2).toHaveLength(0);
    expect(tracker.openCount).toBe(2); // two windows now

    // reverie_set to arch namespace closes the arch window as writeback
    const closed3 = tracker.onToolCall({
      session: 's1', tool: 'reverie_set', namespace: 'arch', key: 'arch.mcp',
      op: 'write', hit: undefined, responseSize: 200,
    });
    expect(closed3).toHaveLength(1);
    expect(closed3[0].resolution).toBe('writeback');
    expect(closed3[0].namespace).toBe('arch');
    expect(closed3[0].key).toBe('arch.mcp');
    expect(closed3[0].toolCalls).toBe(1); // the files.entry call accumulated
    expect(closed3[0].explorationBytes).toBe(500);
    expect(tracker.openCount).toBe(1); // files window still open
  });

  it('closes all session windows as moved_on on a hit', () => {
    const tracker = new MissWindowTracker();

    // Two misses in same session
    tracker.onToolCall({
      session: 's1', tool: 'reverie_get', namespace: 'arch', key: 'arch.mcp',
      op: 'read', hit: false, responseSize: 0,
    });
    tracker.onToolCall({
      session: 's1', tool: 'reverie_get', namespace: 'files', key: 'files.entry',
      op: 'read', hit: false, responseSize: 0,
    });
    expect(tracker.openCount).toBe(2);

    // A hit closes all windows for the session
    const closed = tracker.onToolCall({
      session: 's1', tool: 'reverie_get', namespace: 'context', key: 'context.ci',
      op: 'read', hit: true, responseSize: 300,
    });
    expect(closed).toHaveLength(2);
    expect(closed.every(c => c.resolution === 'moved_on')).toBe(true);
    expect(tracker.openCount).toBe(0);
  });

  it('does not close windows from other sessions', () => {
    const tracker = new MissWindowTracker();

    tracker.onToolCall({
      session: 's1', tool: 'reverie_get', namespace: 'arch', key: 'arch.mcp',
      op: 'read', hit: false, responseSize: 0,
    });
    tracker.onToolCall({
      session: 's2', tool: 'reverie_get', namespace: 'arch', key: 'arch.mcp',
      op: 'read', hit: false, responseSize: 0,
    });
    expect(tracker.openCount).toBe(2);

    // Hit in s1 only closes s1's window
    const closed = tracker.onToolCall({
      session: 's1', tool: 'reverie_get', namespace: 'arch', key: 'arch.mcp',
      op: 'read', hit: true, responseSize: 100,
    });
    expect(closed).toHaveLength(1);
    expect(closed[0].session).toBe('s1');
    expect(tracker.openCount).toBe(1);
  });

  it('does not open duplicate windows for same session+namespace', () => {
    const tracker = new MissWindowTracker();

    tracker.onToolCall({
      session: 's1', tool: 'reverie_get', namespace: 'arch', key: 'arch.mcp',
      op: 'read', hit: false, responseSize: 0,
    });
    tracker.onToolCall({
      session: 's1', tool: 'reverie_find', namespace: 'arch', key: 'arch.store',
      op: 'read', hit: false, responseSize: 0,
    });
    // Should still be 1 window, not 2
    expect(tracker.openCount).toBe(1);
  });

  it('accumulates bytes across multiple calls', () => {
    const tracker = new MissWindowTracker();

    tracker.onToolCall({
      session: 's1', tool: 'reverie_get', namespace: 'arch', key: 'arch.mcp',
      op: 'read', hit: false, responseSize: 0,
    });

    // Three exploration calls
    tracker.onToolCall({
      session: 's1', tool: 'reverie_get', namespace: 'files', key: 'files.x',
      op: 'read', hit: false, responseSize: 100,
    });
    tracker.onToolCall({
      session: 's1', tool: 'reverie_find', namespace: '*', key: '',
      op: 'read', hit: false, responseSize: 200,
    });
    tracker.onToolCall({
      session: 's1', tool: 'reverie_get', namespace: 'context', key: 'context.y',
      op: 'read', hit: false, responseSize: 300,
    });

    // Close arch window via writeback
    const closed = tracker.onToolCall({
      session: 's1', tool: 'reverie_set', namespace: 'arch', key: 'arch.mcp',
      op: 'write', hit: undefined, responseSize: 50,
    });
    const archPath = closed.find(c => c.namespace === 'arch');
    expect(archPath).toBeDefined();
    expect(archPath!.toolCalls).toBe(3);
    expect(archPath!.explorationBytes).toBe(600); // 100 + 200 + 300
  });

  it('flushAll closes all windows as timeout', () => {
    const tracker = new MissWindowTracker();

    tracker.onToolCall({
      session: 's1', tool: 'reverie_get', namespace: 'arch', key: 'arch.mcp',
      op: 'read', hit: false, responseSize: 0,
    });
    tracker.onToolCall({
      session: 's2', tool: 'reverie_get', namespace: 'files', key: 'files.entry',
      op: 'read', hit: false, responseSize: 0,
    });
    expect(tracker.openCount).toBe(2);

    const flushed = tracker.flushAll();
    expect(flushed).toHaveLength(2);
    expect(flushed.every(f => f.resolution === 'timeout')).toBe(true);
    expect(tracker.openCount).toBe(0);
  });

  it('tracks agent identity from params', () => {
    const tracker = new MissWindowTracker();

    tracker.onToolCall({
      session: 's1', tool: 'reverie_get', namespace: 'arch', key: 'arch.mcp',
      op: 'read', hit: false, responseSize: 0, agent: 'claude-code',
    });

    const flushed = tracker.flushAll();
    expect(flushed[0].agent).toBe('claude-code');
  });

  it('carries the agentDetected confidence marker through to closed records (#138)', () => {
    const tracker = new MissWindowTracker();

    tracker.onToolCall({
      session: 's1', tool: 'reverie_get', namespace: 'arch', key: 'arch.mcp',
      op: 'read', hit: false, responseSize: 0, agent: 'claude-code', agentDetected: true,
    });

    const flushed = tracker.flushAll();
    expect(flushed[0].agentDetected).toBe(true);
  });

  it('returns empty array when no windows are open', () => {
    const tracker = new MissWindowTracker();
    expect(tracker.flushAll()).toHaveLength(0);
    expect(tracker.onToolCall({
      session: 's1', tool: 'reverie_set', namespace: 'arch', key: 'arch.x',
      op: 'write', hit: undefined, responseSize: 50,
    })).toHaveLength(0);
  });
});

// ── Persistence (appendMissPath / loadMissPaths) ─────────────────────

describe('miss-path persistence', () => {
  it('roundtrips miss-path records through JSONL', async () => {
    const record: MissPath = {
      ts: 1000, session: 's1', namespace: 'arch', key: 'arch.mcp',
      toolCalls: 3, explorationBytes: 1200,
      resolution: 'writeback', resolvedAt: 2000, agent: 'test',
    };
    await appendMissPath(record);
    // appendMissPath is async by default — give it a tick
    await new Promise(r => setTimeout(r, 50));
    const loaded = loadMissPaths();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toEqual(record);
  });

  it('appends multiple records', async () => {
    const r1: MissPath = {
      ts: 1000, session: 's1', namespace: 'arch', key: 'arch.mcp',
      toolCalls: 2, explorationBytes: 800,
      resolution: 'writeback', resolvedAt: 2000,
    };
    const r2: MissPath = {
      ts: 3000, session: 's1', namespace: 'files', key: 'files.entry',
      toolCalls: 1, explorationBytes: 400,
      resolution: 'moved_on', resolvedAt: 4000,
    };
    await appendMissPath(r1);
    await appendMissPath(r2);
    await new Promise(r => setTimeout(r, 50));
    const loaded = loadMissPaths();
    expect(loaded).toHaveLength(2);
  });

  it('sync write persists immediately', () => {
    const record: MissPath = {
      ts: 1000, session: 's1', namespace: 'arch', key: 'arch.mcp',
      toolCalls: 0, explorationBytes: 0,
      resolution: 'timeout', resolvedAt: 2000,
    };
    appendMissPath(record, true);
    const loaded = loadMissPaths();
    expect(loaded).toHaveLength(1);
  });

  it('returns empty array when file does not exist', () => {
    expect(loadMissPaths()).toEqual([]);
  });

  it('handles malformed lines gracefully', () => {
    const filePath = path.join(tmpDir, 'miss-paths.jsonl');
    fs.writeFileSync(filePath, '{"ts":1}\nnot-json\n{"ts":2}\n');
    const loaded = loadMissPaths();
    expect(loaded).toHaveLength(2);
  });
});

// ── getExplorationCost calibration ───────────────────────────────────

describe('getExplorationCost', () => {
  it('returns static cost when no miss-paths provided', () => {
    const result = getExplorationCost('arch');
    expect(result.cost).toBe(EXPLORATION_COST['arch']);
    expect(result.source).toBe('static');
    expect(result.samples).toBe(0);
  });

  it('returns static cost when fewer than 5 writeback samples', () => {
    const missPaths: MissPath[] = Array.from({ length: 4 }, (_, i) => ({
      ts: i, session: `s${i}`, namespace: 'arch', key: 'arch.x',
      toolCalls: 3, explorationBytes: 2000,
      resolution: 'writeback' as const, resolvedAt: i + 100,
    }));
    const result = getExplorationCost('arch', missPaths);
    expect(result.source).toBe('static');
    expect(result.samples).toBe(4);
  });

  it('returns observed median when >= 5 writeback samples', () => {
    // explorationBytes: [400, 800, 1200, 1600, 2000]
    // tokens (÷4):      [100, 200,  300,  400,  500]
    // median (index 2):  300
    const missPaths: MissPath[] = Array.from({ length: 5 }, (_, i) => ({
      ts: i, session: `s${i}`, namespace: 'files', key: 'files.x',
      toolCalls: 2, explorationBytes: (i + 1) * 400,
      resolution: 'writeback' as const, resolvedAt: i + 100,
    }));
    const result = getExplorationCost('files', missPaths);
    expect(result.source).toBe('observed');
    expect(result.cost).toBe(300);
    expect(result.samples).toBe(5);
  });

  it('ignores non-writeback resolutions for calibration', () => {
    const missPaths: MissPath[] = [
      ...Array.from({ length: 3 }, (_, i) => ({
        ts: i, session: `s${i}`, namespace: 'arch', key: 'arch.x',
        toolCalls: 2, explorationBytes: 1000,
        resolution: 'writeback' as const, resolvedAt: i + 100,
      })),
      ...Array.from({ length: 10 }, (_, i) => ({
        ts: i + 100, session: `s${i + 100}`, namespace: 'arch', key: 'arch.x',
        toolCalls: 1, explorationBytes: 500,
        resolution: 'timeout' as const, resolvedAt: i + 200,
      })),
    ];
    // Only 3 writebacks — not enough
    const result = getExplorationCost('arch', missPaths);
    expect(result.source).toBe('static');
    expect(result.samples).toBe(3);
  });

  it('uses DEFAULT_EXPLORATION_COST for unknown namespaces', () => {
    const result = getExplorationCost('custom_ns');
    expect(result.cost).toBe(1000); // DEFAULT_EXPLORATION_COST
    expect(result.source).toBe('static');
  });

  it('filters by namespace correctly', () => {
    const missPaths: MissPath[] = [
      ...Array.from({ length: 6 }, (_, i) => ({
        ts: i, session: `s${i}`, namespace: 'arch', key: 'arch.x',
        toolCalls: 2, explorationBytes: 2000,
        resolution: 'writeback' as const, resolvedAt: i + 100,
      })),
      ...Array.from({ length: 6 }, (_, i) => ({
        ts: i + 100, session: `s${i + 100}`, namespace: 'files', key: 'files.x',
        toolCalls: 1, explorationBytes: 800,
        resolution: 'writeback' as const, resolvedAt: i + 200,
      })),
    ];
    const archResult = getExplorationCost('arch', missPaths);
    const filesResult = getExplorationCost('files', missPaths);
    expect(archResult.cost).toBe(500); // 2000/4 = 500
    expect(filesResult.cost).toBe(200); // 800/4 = 200
    expect(archResult.source).toBe('observed');
    expect(filesResult.source).toBe('observed');
  });
});
