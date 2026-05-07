import fs from 'fs';
import path from 'path';
import os from 'os';

let tmpDir: string;

vi.mock('../utils/paths', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../utils/paths')>();
  return {
    ...orig,
    getDataDirectory: () => tmpDir,
    findProjectFile: () => null,
  };
});

vi.mock('../utils/crypto', () => ({
  isEncrypted: (v: string) => v.startsWith('ENC:'),
}));

import { logAudit, loadAuditLog } from '../utils/audit';
import { logToolCall, loadTelemetry } from '../utils/telemetry';
import { getSessionId } from '../utils/session';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-session-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('audit + telemetry session ID consistency (regression for v1.11.x bug)', () => {
  // Pre-v1.11.x, src/utils/audit.ts and src/utils/telemetry.ts each generated
  // their own independent random sessionId at module load time. Same operation
  // logged to both files would have DIFFERENT session fields, breaking any
  // analysis that joined the two logs by session.
  //
  // The fix is structural: both modules now import getSessionId() from a
  // shared src/utils/session.ts, so there's a single source of truth.

  it('logAudit and logToolCall produce the same session field for the same operation (cli)', async () => {
    await logAudit({
      src: 'cli',
      tool: 'reverie_set',
      op: 'write',
      key: 'foo.bar',
      success: true,
    });
    await logToolCall('reverie_set', 'foo.bar', 'cli');

    const auditEntries = loadAuditLog();
    const telemetryEntries = loadTelemetry();

    expect(auditEntries).toHaveLength(1);
    expect(telemetryEntries).toHaveLength(1);
    expect(auditEntries[0].session).toBe(telemetryEntries[0].session);
  });

  it('logAudit and logToolCall produce the same session field for the same operation (mcp)', async () => {
    // Regression: pre-fix, only the cli path was tested. A live flogging of
    // v1.11.0 found audit and telemetry session IDs diverging for MCP-sourced
    // operations because the running MCP server process predated PR #67 and
    // had not been restarted. The CODE is correct (both modules import from
    // the shared session.ts), but coverage was incomplete — this test pins
    // the MCP path so a future regression here gets caught at unit-test time.
    await logAudit({
      src: 'mcp',
      tool: 'reverie_set',
      op: 'write',
      key: 'foo.bar',
      success: true,
    });
    await logToolCall('reverie_set', 'foo.bar', 'mcp');

    const auditEntries = loadAuditLog();
    const telemetryEntries = loadTelemetry();

    expect(auditEntries).toHaveLength(1);
    expect(telemetryEntries).toHaveLength(1);
    expect(auditEntries[0].session).toBe(telemetryEntries[0].session);
  });

  it('the shared session matches getSessionId()', async () => {
    const expected = getSessionId();
    await logAudit({
      src: 'cli',
      tool: 'reverie_get',
      op: 'read',
      key: 'foo.bar',
      success: true,
    });
    await logToolCall('reverie_get', 'foo.bar', 'cli');

    const auditEntries = loadAuditLog();
    const telemetryEntries = loadTelemetry();

    expect(auditEntries[0].session).toBe(expected);
    expect(telemetryEntries[0].session).toBe(expected);
  });

  it('session ID is stable across multiple calls in the same process', async () => {
    const first = getSessionId();
    const second = getSessionId();
    const third = getSessionId();
    expect(first).toBe(second);
    expect(second).toBe(third);
    expect(first).toMatch(/^[a-f0-9]{8}$/);
  });
});
