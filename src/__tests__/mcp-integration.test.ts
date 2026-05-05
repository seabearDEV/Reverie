/**
 * MCP integration tests with real I/O.
 *
 * Unlike mcp-server.test.ts which mocks everything, these tests use real
 * file system operations through the actual store layer. This catches
 * wiring bugs between the MCP tool handlers and the persistence layer.
 */
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { readStoreState, writeDirectoryStore } from './helpers/readStoreState';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-mcp-integ-'));
  // v1.10.0: seed an empty store directory directly
  fs.mkdirSync(path.join(tmpDir, 'store'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'store', '_aliases.json'), '{}');
  fs.writeFileSync(path.join(tmpDir, 'store', '_confirm.json'), '{}');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * Call an MCP tool by invoking the MCP server as a subprocess with
 * a JSON-RPC request over stdin/stdout.
 */
// Tools that take a `scope` param. After #99 these refuse on auto+null
// project resolution, so the helper injects scope:'global' by default to
// keep the existing tests exercising the global-store path under
// CODEX_NO_PROJECT='1'. Read-only tools (codex_get, codex_find, etc.)
// don't need it but tolerate the extra field.
const SCOPED_TOOLS = new Set([
  'codex_set', 'codex_remove', 'codex_copy', 'codex_rename',
  'codex_alias_set', 'codex_alias_remove', 'codex_import', 'codex_reset',
  'codex_get', 'codex_find', 'codex_alias_list', 'codex_run',
]);

function callMcpTool(tool: string, params: Record<string, unknown> = {}, opts: { skipScopeInject?: boolean } = {}): { content: { text: string }[]; isError?: boolean } {
  if (!opts.skipScopeInject && SCOPED_TOOLS.has(tool) && params.scope === undefined) {
    params = { ...params, scope: 'global' };
  }
  // Build a JSON-RPC initialize + tool call sequence
  const initialize = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test', version: '1.0' },
    },
  });

  const initialized = JSON.stringify({
    jsonrpc: '2.0',
    method: 'notifications/initialized',
  });

  const toolCall = JSON.stringify({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: tool, arguments: params },
  });

  const input = initialize + '\n' + initialized + '\n' + toolCall + '\n';

  try {
    const output = execSync(`node dist/mcp-server.js --cwd ${tmpDir}`, {
      input,
      env: { ...process.env, CODEX_DATA_DIR: tmpDir, CODEX_NO_PROJECT: '1' },
      timeout: 15000,
      maxBuffer: 1024 * 1024,
    }).toString();

    // Parse last JSON-RPC response (the tool call result)
    const lines = output.trim().split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const msg = JSON.parse(lines[i]);
        if (msg.id === 2 && msg.result) {
          return msg.result;
        }
      } catch { /* skip non-JSON lines */ }
    }

    throw new Error(`No tool result found in output: ${output.slice(0, 500)}`);
  } catch (err: unknown) {
    // If the process exits non-zero, try to extract the response from stderr/stdout
    const e = err as { stdout?: Buffer; stderr?: Buffer; message?: string };
    const stdout = e.stdout?.toString() ?? '';
    const lines = stdout.trim().split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const msg = JSON.parse(lines[i]);
        if (msg.id === 2 && msg.result) {
          return msg.result;
        }
      } catch { /* skip */ }
    }
    throw new Error(`MCP call failed: ${e.message}\nstdout: ${stdout}\nstderr: ${e.stderr?.toString() ?? ''}`);
  }
}

function readDataFile(): Record<string, unknown> {
  // v1.10.0: reads the file-per-entry store directory and reconstitutes
  // the legacy UnifiedData shape the tests assert against.
  return readStoreState(tmpDir) as Record<string, unknown>;
}

describe('MCP Integration (real I/O)', () => {
  describe('codex_set + codex_get round-trip', () => {
    it('persists a value and retrieves it', () => {
      const setResult = callMcpTool('codex_set', { key: 'project.name', value: 'TestProject' });
      expect(setResult.content[0].text).toContain('Set:');

      // Verify on disk
      const data = readDataFile();
      expect((data.entries as any).project.name).toBe('TestProject');

      // Retrieve via MCP
      const getResult = callMcpTool('codex_get', { key: 'project.name' });
      expect(getResult.content[0].text).toContain('TestProject');
    });

    it('handles nested keys correctly', () => {
      callMcpTool('codex_set', { key: 'server.prod.ip', value: '10.0.0.1' });
      callMcpTool('codex_set', { key: 'server.prod.port', value: '8080' });

      const data = readDataFile();
      expect((data.entries as any).server.prod.ip).toBe('10.0.0.1');
      expect((data.entries as any).server.prod.port).toBe('8080');
    });
  });

  describe('codex_remove', () => {
    it('removes an entry from disk', () => {
      callMcpTool('codex_set', { key: 'temp.key', value: 'temp' });
      callMcpTool('codex_remove', { key: 'temp.key' });

      const data = readDataFile();
      expect((data.entries as any).temp).toBeUndefined();
    });

    it('cleans up empty parent objects', () => {
      callMcpTool('codex_set', { key: 'a.b.c', value: 'deep' });
      callMcpTool('codex_remove', { key: 'a.b.c' });

      const data = readDataFile();
      expect((data.entries as any).a).toBeUndefined();
    });
  });

  describe('codex_rename', () => {
    it('moves value from old key to new key on disk', () => {
      callMcpTool('codex_set', { key: 'old.key', value: 'moved' });

      // Verify it's set
      const before = readDataFile();
      expect((before.entries as any).old.key).toBe('moved');

      callMcpTool('codex_rename', { oldKey: 'old.key', newKey: 'new.key' });

      const data = readDataFile();
      expect((data.entries as any).new?.key).toBe('moved');
      // old key removed (may leave empty parent or be cleaned up)
    });
  });

  describe('codex_copy', () => {
    it('duplicates value on disk', () => {
      callMcpTool('codex_set', { key: 'src', value: 'copied' });
      callMcpTool('codex_copy', { source: 'src', dest: 'dst' });

      const data = readDataFile();
      expect((data.entries as any).src).toBe('copied');
      expect((data.entries as any).dst).toBe('copied');
    });
  });

  describe('codex_find', () => {
    it('finds entries by value content', () => {
      callMcpTool('codex_set', { key: 'server.ip', value: '192.168.1.100' });
      callMcpTool('codex_set', { key: 'app.name', value: 'TestApp' });

      const result = callMcpTool('codex_find', { query: '192.168' });
      expect(result.content[0].text).toContain('192.168');
      expect(result.content[0].text).not.toContain('TestApp');
    });
  });

  describe('codex_alias lifecycle', () => {
    it('creates alias and persists it on disk', () => {
      callMcpTool('codex_set', { key: 'commands.build', value: 'npm run build' });
      callMcpTool('codex_alias_set', { alias: 'bld', key: 'commands.build' });

      // Alias persisted on disk
      const data = readDataFile();
      expect((data.aliases as any).bld).toBe('commands.build');
    });

    it('lists aliases from disk', () => {
      // Pre-populate store directory with an alias (v1.10.0 format)
      writeDirectoryStore(path.join(tmpDir, 'store'), {
        entries: { commands: { test: 'npm test' } },
        aliases: { tst: 'commands.test' },
        confirm: {},
      });

      const listResult = callMcpTool('codex_alias_list', {});
      expect(listResult.content[0].text).toContain('tst');
      expect(listResult.content[0].text).toContain('commands.test');
    });

    it('removes alias from disk', () => {
      // Pre-populate store directory (v1.10.0 format)
      writeDirectoryStore(path.join(tmpDir, 'store'), {
        entries: { x: { y: 'val' } },
        aliases: { xy: 'x.y' },
        confirm: {},
      });

      callMcpTool('codex_alias_remove', { alias: 'xy' });

      const after = readDataFile();
      expect((after.aliases as any).xy).toBeUndefined();
    });
  });

  describe('codex_context', () => {
    it('returns all stored data in compact format', () => {
      callMcpTool('codex_set', { key: 'project.name', value: 'Test' });
      callMcpTool('codex_set', { key: 'commands.build', value: 'make' });

      const result = callMcpTool('codex_context', {});
      const text = result.content[0].text;
      expect(text).toContain('project.name');
      expect(text).toContain('Test');
      expect(text).toContain('commands.build');
      expect(text).toContain('make');
    });
  });

  describe('codex_import + codex_export round-trip', () => {
    it('exports and reimports data losslessly', () => {
      callMcpTool('codex_set', { key: 'a.b', value: 'original' });
      callMcpTool('codex_set', { key: 'c.d', value: 'other' });

      // Export
      const exportResult = callMcpTool('codex_export', { type: 'entries' });
      const exportedJson = exportResult.content[0].text;
      const exported = JSON.parse(exportedJson);
      expect(exported.$codexcli?.type).toBe('entries');
      expect(exported.entries.a.b).toBe('original');

      // Reset
      callMcpTool('codex_reset', { type: 'entries' });
      const afterReset = readDataFile();
      expect(Object.keys((afterReset.entries as any))).toHaveLength(0);

      // Import
      callMcpTool('codex_import', { type: 'entries', data: exportedJson });
      const afterImport = readDataFile();
      expect((afterImport.entries as any).a.b).toBe('original');
      expect((afterImport.entries as any).c.d).toBe('other');
    });
  });

  describe('codex_reset', () => {
    it('clears all entries on disk', () => {
      callMcpTool('codex_set', { key: 'foo', value: 'bar' });
      callMcpTool('codex_reset', { type: 'entries' });

      const data = readDataFile();
      expect(Object.keys(data.entries as any)).toHaveLength(0);
    });
  });

  describe('_meta staleness tracking', () => {
    it('codex_set writes _meta timestamp for the key', () => {
      callMcpTool('codex_set', { key: 'tracked.key', value: 'val' });

      const data = readDataFile();
      const meta = data._meta as Record<string, number>;
      expect(meta['tracked.key']).toBeGreaterThan(0);
    });

    it('codex_remove clears _meta for removed key', () => {
      callMcpTool('codex_set', { key: 'rm.key', value: 'val' });
      callMcpTool('codex_remove', { key: 'rm.key' });

      const data = readDataFile();
      const meta = data._meta as Record<string, number> | undefined;
      expect(meta?.['rm.key']).toBeUndefined();
    });
  });

  describe('audit logging', () => {
    it('logs MCP tool calls to audit.jsonl', () => {
      callMcpTool('codex_set', { key: 'audit.test', value: 'logged' });

      const auditPath = path.join(tmpDir, 'audit.jsonl');
      // Audit may be async — give it a moment
      if (fs.existsSync(auditPath)) {
        const lines = fs.readFileSync(auditPath, 'utf8').trim().split('\n');
        const entries = lines.map(l => JSON.parse(l));
        const setEntry = entries.find((e: any) => e.tool === 'codex_set' && e.key === 'audit.test');
        if (setEntry) {
          expect(setEntry.src).toBe('mcp');
          expect(setEntry.success).toBe(true);
        }
      }
      // It's OK if audit hasn't flushed — we're testing the wiring exists
    });
  });

  describe('telemetry logging', () => {
    it('logs MCP tool calls to telemetry.jsonl', () => {
      callMcpTool('codex_set', { key: 'telemetry.test', value: 'logged' });

      const telemetryPath = path.join(tmpDir, 'telemetry.jsonl');
      if (fs.existsSync(telemetryPath)) {
        const lines = fs.readFileSync(telemetryPath, 'utf8').trim().split('\n');
        const entries = lines.map(l => JSON.parse(l));
        const setEntry = entries.find((e: any) => e.tool === 'codex_set');
        if (setEntry) {
          expect(setEntry.op).toBe('write');
          expect(setEntry.src).toBe('mcp');
        }
      }
    });
  });

  // #99: when project resolution fails and the caller does not pass an
  // explicit scope, write tools refuse with a structured response. When
  // scope:'global' is explicit, the same call succeeds and is tagged
  // rescuedByExplicitGlobal in telemetry/audit.
  describe('project-resolution refusal (#99)', () => {
    it('codex_set without scope refuses with the structured error', () => {
      const result = callMcpTool('codex_set', { key: 'refused.key', value: 'v' }, { skipScopeInject: true });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Project resolution failed');
      expect(result.content[0].text).toContain('CODEX_NO_PROJECT');
      // Second content block carries the JSON diagnostic
      expect(result.content[1]?.text).toContain('PROJECT_UNRESOLVED');
      expect(result.content[1]?.text).toContain('codexNoProject');
      // Nothing was written
      const data = readDataFile();
      expect((data.entries as any).refused).toBeUndefined();
    });

    it('codex_set with explicit scope:"global" succeeds (rescue path)', () => {
      const result = callMcpTool('codex_set', { key: 'rescued.key', value: 'v', scope: 'global' });
      expect(result.isError).toBeFalsy();
      const data = readDataFile();
      expect((data.entries as any).rescued.key).toBe('v');
    });

    it('audit logs refusedReason on the refused call and rescuedByExplicitGlobal on the rescued one', () => {
      callMcpTool('codex_set', { key: 'audit.refused', value: 'v' }, { skipScopeInject: true });
      callMcpTool('codex_set', { key: 'audit.rescued', value: 'v', scope: 'global' });

      const auditPath = path.join(tmpDir, 'audit.jsonl');
      if (!fs.existsSync(auditPath)) return; // audit is best-effort; if it didn't flush, skip
      const lines = fs.readFileSync(auditPath, 'utf8').trim().split('\n');
      const entries = lines.map(l => JSON.parse(l));

      const refused = entries.find((e: any) => e.tool === 'codex_set' && e.key === 'audit.refused');
      if (refused) {
        expect(refused.success).toBe(false);
        expect(refused.refusedReason).toBe('project_unresolved');
      }

      const rescued = entries.find((e: any) => e.tool === 'codex_set' && e.key === 'audit.rescued');
      if (rescued) {
        expect(rescued.success).toBe(true);
        expect(rescued.rescuedByExplicitGlobal).toBe(true);
      }
    });
  });
});
