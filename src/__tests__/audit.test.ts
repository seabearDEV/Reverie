import fs from 'fs';
import path from 'path';
import os from 'os';

let tmpDir: string;

let mockProjectFile: string | null = null;

vi.mock('../utils/paths', () => ({
  getDataDirectory: () => tmpDir,
  findProjectFile: () => mockProjectFile,
}));

vi.mock('../utils/crypto', () => ({
  isEncrypted: (v: string) => v.startsWith('ENC:'),
}));

import { logAudit, loadAuditLog, queryAuditLog, sanitizeValue, sanitizeParams, AuditEntry } from '../utils/audit';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-audit-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.RVR_AGENT_NAME;
  mockProjectFile = null;
});

describe('sanitizeValue', () => {
  it('returns undefined for undefined input', () => {
    expect(sanitizeValue(undefined)).toBeUndefined();
  });

  it('returns [encrypted] for encrypted values', () => {
    expect(sanitizeValue('ENC:abc123')).toBe('[encrypted]');
  });

  it('truncates long values', () => {
    const long = 'x'.repeat(600);
    const result = sanitizeValue(long);
    expect(result).toHaveLength(500 + '...[truncated]'.length);
    expect(result).toContain('...[truncated]');
  });

  it('passes through short values unchanged', () => {
    expect(sanitizeValue('hello')).toBe('hello');
  });
});

describe('sanitizeParams', () => {
  it('redacts password field', () => {
    const result = sanitizeParams({ key: 'x', password: 'secret123' });
    expect(result.key).toBe('x');
    expect(result.password).toBe('[redacted]');
  });

  it('truncates long string values', () => {
    const long = 'y'.repeat(600);
    const result = sanitizeParams({ value: long });
    expect(typeof result.value).toBe('string');
    expect((result.value as string).length).toBeLessThan(600);
    expect((result.value as string)).toContain('...[truncated]');
  });

  it('passes through non-string values unchanged', () => {
    const result = sanitizeParams({ flag: true, count: 42 });
    expect(result.flag).toBe(true);
    expect(result.count).toBe(42);
  });
});

describe('logAudit', () => {
  it('creates audit.jsonl and writes a valid entry', async () => {
    await logAudit({
      src: 'mcp',
      tool: 'reverie_set',
      op: 'write',
      key: 'arch.mcp',
      scope: 'project',
      success: true,
      before: 'old',
      after: 'new',
    });
    const content = fs.readFileSync(path.join(tmpDir, 'audit.jsonl'), 'utf8');
    const entry = JSON.parse(content.trim()) as AuditEntry;
    expect(entry.tool).toBe('reverie_set');
    expect(entry.op).toBe('write');
    expect(entry.key).toBe('arch.mcp');
    expect(entry.success).toBe(true);
    expect(entry.before).toBe('old');
    expect(entry.after).toBe('new');
    expect(entry.session).toMatch(/^[a-f0-9]{8}$/);
    expect(entry.ts).toBeGreaterThan(0);
  });

  it('captures RVR_AGENT_NAME env var', async () => {
    process.env.RVR_AGENT_NAME = 'cursor';
    await logAudit({
      src: 'mcp',
      tool: 'reverie_get',
      op: 'read',
      success: true,
    });
    const entries = loadAuditLog();
    expect(entries[0].agent).toBe('cursor');
  });

  it('leaves agent undefined when env var not set', async () => {
    await logAudit({
      src: 'cli',
      tool: 'reverie_set',
      op: 'write',
      success: true,
    });
    const entries = loadAuditLog();
    expect(entries[0].agent).toBeUndefined();
  });

  it('records project directory from findProjectFile', async () => {
    mockProjectFile = '/home/user/myproject/.codexcli.json';
    await logAudit({
      src: 'mcp',
      tool: 'reverie_set',
      op: 'write',
      success: true,
    });
    const entries = loadAuditLog();
    expect(entries[0].project).toBe('/home/user/myproject');
  });

  it('leaves project undefined when no project file found', async () => {
    mockProjectFile = null;
    await logAudit({
      src: 'cli',
      tool: 'reverie_set',
      op: 'write',
      success: true,
    });
    const entries = loadAuditLog();
    expect(entries[0].project).toBeUndefined();
  });

  it('appends multiple entries', async () => {
    await logAudit({ src: 'mcp', tool: 'reverie_set', op: 'write', success: true });
    await logAudit({ src: 'cli', tool: 'reverie_get', op: 'read', success: true });
    const entries = loadAuditLog();
    expect(entries).toHaveLength(2);
  });

  it('writes synchronously when sync=true', () => {
    logAudit({ src: 'cli', tool: 'reverie_set', op: 'write', success: true }, true);
    // File should exist immediately (sync write)
    const entries = loadAuditLog();
    expect(entries.length).toBe(1);
    expect(entries[0].tool).toBe('reverie_set');
    expect(entries[0].src).toBe('cli');
  });
});

describe('loadAuditLog', () => {
  it('returns empty array when no file exists', () => {
    expect(loadAuditLog()).toEqual([]);
  });

  it('skips malformed lines', () => {
    const auditPath = path.join(tmpDir, 'audit.jsonl');
    fs.writeFileSync(auditPath, [
      JSON.stringify({ ts: 1, session: 'x', src: 'mcp', tool: 'a', op: 'read', success: true }),
      'not json',
      JSON.stringify({ ts: 2, session: 'x', src: 'cli', tool: 'b', op: 'write', success: false }),
    ].join('\n') + '\n');
    const entries = loadAuditLog();
    expect(entries).toHaveLength(2);
    expect(entries[0].tool).toBe('a');
    expect(entries[1].tool).toBe('b');
  });
});

describe('queryAuditLog', () => {
  function writeEntries(entries: AuditEntry[]) {
    const auditPath = path.join(tmpDir, 'audit.jsonl');
    fs.writeFileSync(auditPath, entries.map(e => JSON.stringify(e)).join('\n') + '\n');
  }

  const now = Date.now();
  const day = 86400000;

  it('filters by exact key', () => {
    writeEntries([
      { ts: now, session: 's1', src: 'mcp', tool: 'reverie_set', op: 'write', key: 'arch.mcp', success: true },
      { ts: now, session: 's1', src: 'mcp', tool: 'reverie_set', op: 'write', key: 'project.name', success: true },
    ]);
    const result = queryAuditLog({ key: 'arch.mcp' });
    expect(result).toHaveLength(1);
    expect(result[0].key).toBe('arch.mcp');
  });

  it('filters by key prefix', () => {
    writeEntries([
      { ts: now, session: 's1', src: 'mcp', tool: 'reverie_set', op: 'write', key: 'arch.mcp', success: true },
      { ts: now, session: 's1', src: 'mcp', tool: 'reverie_set', op: 'write', key: 'arch.cli', success: true },
      { ts: now, session: 's1', src: 'mcp', tool: 'reverie_set', op: 'write', key: 'project.name', success: true },
    ]);
    const result = queryAuditLog({ key: 'arch' });
    expect(result).toHaveLength(2);
  });

  it('filters by period', () => {
    writeEntries([
      { ts: now - 60 * day, session: 'old', src: 'mcp', tool: 'reverie_set', op: 'write', success: true },
      { ts: now - 1000, session: 'new', src: 'mcp', tool: 'reverie_set', op: 'write', success: true },
    ]);
    const result = queryAuditLog({ periodDays: 7 });
    expect(result).toHaveLength(1);
  });

  it('filters writes only', () => {
    writeEntries([
      { ts: now, session: 's1', src: 'mcp', tool: 'reverie_set', op: 'write', success: true },
      { ts: now, session: 's1', src: 'mcp', tool: 'reverie_get', op: 'read', success: true },
      { ts: now, session: 's1', src: 'mcp', tool: 'reverie_run', op: 'exec', success: true },
    ]);
    const result = queryAuditLog({ writesOnly: true });
    expect(result).toHaveLength(1);
    expect(result[0].op).toBe('write');
  });

  it('returns newest first', () => {
    writeEntries([
      { ts: now - 3000, session: 's1', src: 'mcp', tool: 'reverie_set', op: 'write', key: 'first', success: true },
      { ts: now - 1000, session: 's1', src: 'mcp', tool: 'reverie_set', op: 'write', key: 'second', success: true },
      { ts: now - 2000, session: 's1', src: 'mcp', tool: 'reverie_set', op: 'write', key: 'middle', success: true },
    ]);
    const result = queryAuditLog({});
    expect(result[0].key).toBe('second');
    expect(result[1].key).toBe('middle');
    expect(result[2].key).toBe('first');
  });

  it('applies limit', () => {
    writeEntries(Array.from({ length: 10 }, (_, i) => ({
      ts: now - i * 1000, session: 's1', src: 'mcp' as const, tool: 'reverie_set', op: 'write' as const, success: true,
    })));
    const result = queryAuditLog({ limit: 3 });
    expect(result).toHaveLength(3);
  });

  it('filters by src', () => {
    writeEntries([
      { ts: now, session: 's1', src: 'mcp', tool: 'reverie_set', op: 'write', success: true },
      { ts: now, session: 's1', src: 'cli', tool: 'reverie_set', op: 'write', success: true },
      { ts: now, session: 's1', src: 'mcp', tool: 'reverie_get', op: 'read', success: true },
    ]);
    const mcp = queryAuditLog({ src: 'mcp' });
    expect(mcp).toHaveLength(2);
    expect(mcp.every(e => e.src === 'mcp')).toBe(true);

    const cli = queryAuditLog({ src: 'cli' });
    expect(cli).toHaveLength(1);
    expect(cli[0].src).toBe('cli');
  });

  it('filters by project', () => {
    writeEntries([
      { ts: now, session: 's1', src: 'mcp', tool: 'reverie_set', op: 'write', key: 'a', project: '/home/user/projectA', success: true },
      { ts: now, session: 's1', src: 'mcp', tool: 'reverie_set', op: 'write', key: 'b', project: '/home/user/projectB', success: true },
      { ts: now, session: 's1', src: 'cli', tool: 'reverie_set', op: 'write', key: 'c', success: true },
    ]);
    const result = queryAuditLog({ project: '/home/user/projectA' });
    expect(result).toHaveLength(1);
    expect(result[0].key).toBe('a');
  });

  it('returns all with period 0', () => {
    writeEntries([
      { ts: now - 365 * day, session: 'old', src: 'mcp', tool: 'reverie_set', op: 'write', success: true },
      { ts: now, session: 'new', src: 'mcp', tool: 'reverie_set', op: 'write', success: true },
    ]);
    const result = queryAuditLog({ periodDays: 0 });
    expect(result).toHaveLength(2);
  });

  it('filters by hitsOnly', () => {
    writeEntries([
      { ts: now, session: 's1', src: 'mcp', tool: 'reverie_get', op: 'read', key: 'a', success: true, hit: true },
      { ts: now, session: 's1', src: 'mcp', tool: 'reverie_get', op: 'read', key: 'b', success: false, hit: false },
      { ts: now, session: 's1', src: 'mcp', tool: 'reverie_set', op: 'write', key: 'c', success: true },
    ]);
    const result = queryAuditLog({ hitsOnly: true });
    expect(result).toHaveLength(1);
    expect(result[0].key).toBe('a');
  });

  it('filters by missesOnly', () => {
    writeEntries([
      { ts: now, session: 's1', src: 'mcp', tool: 'reverie_get', op: 'read', key: 'a', success: true, hit: true },
      { ts: now, session: 's1', src: 'mcp', tool: 'reverie_get', op: 'read', key: 'b', success: false, hit: false },
      { ts: now, session: 's1', src: 'mcp', tool: 'reverie_set', op: 'write', key: 'c', success: true },
    ]);
    const result = queryAuditLog({ missesOnly: true });
    expect(result).toHaveLength(1);
    expect(result[0].key).toBe('b');
  });

  it('filters by redundantOnly', () => {
    writeEntries([
      { ts: now, session: 's1', src: 'mcp', tool: 'reverie_set', op: 'write', key: 'a', success: true, redundant: true },
      { ts: now, session: 's1', src: 'mcp', tool: 'reverie_set', op: 'write', key: 'b', success: true },
      { ts: now, session: 's1', src: 'mcp', tool: 'reverie_get', op: 'read', key: 'c', success: true, hit: true },
    ]);
    const result = queryAuditLog({ redundantOnly: true });
    expect(result).toHaveLength(1);
    expect(result[0].key).toBe('a');
  });
});

describe('token-efficiency metrics', () => {
  it('preserves all metric fields through log/load roundtrip', async () => {
    await logAudit({
      src: 'mcp',
      tool: 'reverie_context',
      op: 'read',
      success: true,
      responseSize: 4200,
      requestSize: 35,
      hit: true,
      tier: 'standard',
      entryCount: 13,
    });
    const entries = loadAuditLog();
    expect(entries).toHaveLength(1);
    expect(entries[0].responseSize).toBe(4200);
    expect(entries[0].requestSize).toBe(35);
    expect(entries[0].hit).toBe(true);
    expect(entries[0].tier).toBe('standard');
    expect(entries[0].entryCount).toBe(13);
    expect(entries[0].redundant).toBeUndefined();
  });

  it('preserves redundant flag through roundtrip', async () => {
    await logAudit({
      src: 'mcp',
      tool: 'reverie_set',
      op: 'write',
      success: true,
      before: 'same',
      after: 'same',
      redundant: true,
      responseSize: 50,
      requestSize: 120,
    });
    const entries = loadAuditLog();
    expect(entries[0].redundant).toBe(true);
  });

  it('omits undefined metric fields from JSON', async () => {
    await logAudit({
      src: 'cli',
      tool: 'reverie_set',
      op: 'write',
      success: true,
    });
    const raw = fs.readFileSync(path.join(tmpDir, 'audit.jsonl'), 'utf8').trim();
    const parsed = JSON.parse(raw);
    expect(parsed).not.toHaveProperty('responseSize');
    expect(parsed).not.toHaveProperty('hit');
    expect(parsed).not.toHaveProperty('tier');
    expect(parsed).not.toHaveProperty('entryCount');
    expect(parsed).not.toHaveProperty('redundant');
  });
});
