import fs from 'fs';
import path from 'path';
import os from 'os';

let tmpDir: string;

// Mock getDataDirectory to point at our temp dir (same pattern as
// telemetry.test.ts — avoids path caching issues).
vi.mock('../utils/paths', () => ({
  getDataDirectory: () => tmpDir,
  findProjectFile: () => null,
}));

import { isTestRun } from '../utils/testTraffic';
import { logToolCall, loadTelemetry, computeStats, classifyOp } from '../utils/telemetry';
import { logAudit, queryAuditLog, clearAuditLogCache } from '../utils/audit';

const savedRvrTest = process.env.RVR_TEST;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-testtraffic-'));
  clearAuditLogCache();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  if (savedRvrTest === undefined) delete process.env.RVR_TEST;
  else process.env.RVR_TEST = savedRvrTest;
});

describe('isTestRun (#130)', () => {
  it('recognizes 1 and true, rejects everything else', () => {
    process.env.RVR_TEST = '1';
    expect(isTestRun()).toBe(true);
    process.env.RVR_TEST = 'true';
    expect(isTestRun()).toBe(true);
    process.env.RVR_TEST = '0';
    expect(isTestRun()).toBe(false);
    delete process.env.RVR_TEST;
    expect(isTestRun()).toBe(false);
  });
});

describe('test-traffic tagging (#130)', () => {
  it('logToolCall tags rows test:true under RVR_TEST', async () => {
    process.env.RVR_TEST = '1';
    await logToolCall('reverie_set', 'project.name', 'cli');
    const [entry] = loadTelemetry();
    expect(entry.test).toBe(true);
  });

  it('logToolCall writes no test field without RVR_TEST', async () => {
    delete process.env.RVR_TEST;
    await logToolCall('reverie_set', 'project.name', 'cli');
    const [entry] = loadTelemetry();
    expect(entry.test).toBeUndefined();
  });

  it('computeStats excludes tagged rows by default and includes them on opt-in', async () => {
    delete process.env.RVR_TEST;
    await logToolCall('reverie_set', 'project.name', 'cli');
    process.env.RVR_TEST = '1';
    await logToolCall('reverie_init', undefined, 'cli');
    await logToolCall('reverie_init', undefined, 'cli');

    expect(computeStats().totalCalls).toBe(1);
    expect(computeStats(0, true).totalCalls).toBe(3);
  });

  it('logAudit tags rows and queryAuditLog excludes them by default', async () => {
    delete process.env.RVR_TEST;
    await logAudit({ src: 'cli', tool: 'reverie_set', op: 'write', key: 'a.real', success: true }, true);
    process.env.RVR_TEST = '1';
    await logAudit({ src: 'cli', tool: 'reverie_set', op: 'write', key: 'a.test', success: true }, true);

    const defaultRows = queryAuditLog();
    expect(defaultRows.map(e => e.key)).toEqual(['a.real']);
    const allRows = queryAuditLog({ includeTest: true });
    expect(allRows.map(e => e.key).sort()).toEqual(['a.real', 'a.test']);
  });
});

describe('selfRef instrumentation (#134)', () => {
  it('classifies the observability tools as meta ops', () => {
    expect(classifyOp('reverie_stats')).toBe('meta');
    expect(classifyOp('reverie_audit')).toBe('meta');
  });

  it('selfRef rows are logged but excluded from stats', async () => {
    delete process.env.RVR_TEST;
    await logToolCall('reverie_set', 'project.name', 'cli');
    await logToolCall('reverie_stats', undefined, 'cli', undefined, { selfRef: true });

    // The record is complete…
    expect(loadTelemetry()).toHaveLength(2);
    // …but aggregates never count the act of looking at them.
    expect(computeStats().totalCalls).toBe(1);
    // include_test does not open the selfRef gate — separate concerns.
    expect(computeStats(0, true).totalCalls).toBe(1);
  });

  it('queryAuditLog excludes selfRef rows unless asked', async () => {
    delete process.env.RVR_TEST;
    await logAudit({ src: 'cli', tool: 'reverie_set', op: 'write', key: 'a.real', success: true }, true);
    await logAudit({ src: 'cli', tool: 'reverie_audit', op: 'meta', success: true, selfRef: true }, true);

    expect(queryAuditLog().map(e => e.tool)).toEqual(['reverie_set']);
    expect(queryAuditLog({ includeSelfRef: true })).toHaveLength(2);
  });
});

describe('watcher self-exclusion (#135)', () => {
  it('queryAuditLog hides rows from an excluded session', async () => {
    delete process.env.RVR_TEST;
    await logAudit({ src: 'cli', tool: 'reverie_set', op: 'write', key: 'a.one', success: true }, true);
    const [own] = queryAuditLog();
    expect(own).toBeDefined();

    const excluded = queryAuditLog({ excludeSession: own.session });
    expect(excluded).toHaveLength(0);
    expect(queryAuditLog({ excludeSession: 'someone-else' })).toHaveLength(1);
  });
});
