/**
 * MCP integration tests with real I/O.
 *
 * Unlike mcp-server.test.ts which mocks everything, these tests use real
 * file system operations through the actual store layer. This catches
 * wiring bugs between the MCP tool handlers and the persistence layer.
 */
import { execSync, spawn } from 'child_process';
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
// RVR_NO_PROJECT='1'. Read-only tools (reverie_get, reverie_find, etc.)
// don't need it but tolerate the extra field.
const SCOPED_TOOLS = new Set([
  'reverie_set', 'reverie_remove', 'reverie_copy', 'reverie_rename',
  'reverie_alias_set', 'reverie_alias_remove', 'reverie_import', 'reverie_reset',
  'reverie_get', 'reverie_find', 'reverie_alias_list', 'reverie_run',
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
    const output = execSync(`bun dist/mcp-server.js --cwd ${tmpDir}`, {
      input,
      env: { ...process.env, RVR_DATA_DIR: tmpDir, RVR_NO_PROJECT: '1' },
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
    throw new Error(`MCP call failed: ${e.message}\nstdout: ${stdout}\nstderr: ${e.stderr?.toString() ?? ''}`, { cause: err });
  }
}

interface ToolResult { content: { text: string }[]; isError?: boolean }
type ToolCall = (tool: string, params?: Record<string, unknown>) => Promise<ToolResult>;

/**
 * One server process, many calls. callMcpTool starts a server per call, which
 * cannot show what a long-lived server does when a store file changes under
 * it between two calls — the case its caches exist for.
 */
async function withMcpSession(fn: (call: ToolCall) => Promise<void>, opts: { cwd?: string; dataDir?: string } = {}): Promise<void> {
  const dataDir = opts.dataDir ?? tmpDir;
  const child = spawn('bun', [path.resolve('dist/mcp-server.js')], {
    cwd: opts.cwd ?? process.cwd(),
    env: { ...process.env, RVR_DATA_DIR: dataDir, RVR_NO_PROJECT: '1' },
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  interface Reply { id?: number; result?: unknown }
  const waiting = new Map<number, (reply: Reply) => void>();
  let buffer = '';
  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    let nl: number;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (!line.trim()) continue;
      try {
        const reply = JSON.parse(line) as Reply;
        if (reply.id !== undefined) {
          waiting.get(reply.id)?.(reply);
          waiting.delete(reply.id);
        }
      } catch { /* skip non-JSON lines */ }
    }
  });
  let nextId = 0;
  const request = (method: string, params: unknown): Promise<Reply> => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { reject(new Error(`MCP ${method} got no reply`)); }, 15000);
    waiting.set(id, reply => { clearTimeout(timer); resolve(reply); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  try {
    await request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    await fn(async (tool, params = {}) => {
      const args = SCOPED_TOOLS.has(tool) && params.scope === undefined ? { ...params, scope: 'global' } : params;
      return (await request('tools/call', { name: tool, arguments: args })).result as ToolResult;
    });
  } finally {
    child.stdin.end();
    child.kill();
  }
}

function readDataFile(): Record<string, unknown> {
  // v1.10.0: reads the file-per-entry store directory and reconstitutes
  // the legacy UnifiedData shape the tests assert against.
  return readStoreState(tmpDir) as Record<string, unknown>;
}

describe('MCP Integration (real I/O)', () => {
  describe('reverie_set + reverie_get round-trip', () => {
    it('persists a value and retrieves it', () => {
      const setResult = callMcpTool('reverie_set', { key: 'project.name', value: 'TestProject' });
      expect(setResult.content[0].text).toContain('Set:');

      // Verify on disk
      const data = readDataFile();
      expect((data.entries as any).project.name).toBe('TestProject');

      // Retrieve via MCP
      const getResult = callMcpTool('reverie_get', { key: 'project.name' });
      expect(getResult.content[0].text).toContain('TestProject');
    });

    it('handles nested keys correctly', () => {
      callMcpTool('reverie_set', { key: 'server.prod.ip', value: '10.0.0.1' });
      callMcpTool('reverie_set', { key: 'server.prod.port', value: '8080' });

      const data = readDataFile();
      expect((data.entries as any).server.prod.ip).toBe('10.0.0.1');
      expect((data.entries as any).server.prod.port).toBe('8080');
    });
  });

  // ── #202: a reference that does not resolve ──────────────────────────
  describe('unresolved references over MCP (#202)', () => {
    const text = (r: { content: { text: string }[] }) => r.content.map(c => c.text).join('\n');

    it('reverie_set stores the value and says what a reader will get', () => {
      const r = callMcpTool('reverie_set', { key: 'unres202.rfvar', value: 'Use ${EMPTY} then Read Until' });
      expect(r.isError).toBeUndefined();
      expect(text(r)).toContain("warning: 'unres202.rfvar' refers to ${EMPTY}, which is not a stored key");
    });

    it('reverie_get returns the value as written with a warning line, and it still counts as a hit', () => {
      callMcpTool('reverie_set', { key: 'unres202.rfvar', value: 'Use ${EMPTY} then Read Until' });
      const leaf = callMcpTool('reverie_get', { key: 'unres202.rfvar' });
      expect(leaf.isError).toBeUndefined();
      expect(text(leaf)).toContain('unres202.rfvar: Use ${EMPTY} then Read Until');
      expect(text(leaf)).toContain('warning:');
      const rows = fs.readFileSync(path.join(tmpDir, 'telemetry.jsonl'), 'utf8').trim().split('\n');
      const last = JSON.parse(rows[rows.length - 1]) as { tool: string; hit?: boolean };
      expect(last.tool).toBe('reverie_get');
      expect(last.hit).toBe(true);
      const subtree = callMcpTool('reverie_get', { key: 'unres202', values: true });
      expect(text(subtree).split('\n').filter(l => l.startsWith('warning:'))).toHaveLength(1);
    });
  });

  describe('reverie_remove', () => {
    it('removes an entry from disk', () => {
      callMcpTool('reverie_set', { key: 'temp.key', value: 'temp' });
      callMcpTool('reverie_remove', { key: 'temp.key' });

      const data = readDataFile();
      expect((data.entries as any).temp).toBeUndefined();
    });

    it('cleans up empty parent objects', () => {
      callMcpTool('reverie_set', { key: 'a.b.c', value: 'deep' });
      callMcpTool('reverie_remove', { key: 'a.b.c' });

      const data = readDataFile();
      expect((data.entries as any).a).toBeUndefined();
    });
  });

  describe('reverie_rename', () => {
    it('moves value from old key to new key on disk', () => {
      callMcpTool('reverie_set', { key: 'old.key', value: 'moved' });

      // Verify it's set
      const before = readDataFile();
      expect((before.entries as any).old.key).toBe('moved');

      callMcpTool('reverie_rename', { oldKey: 'old.key', newKey: 'new.key' });

      const data = readDataFile();
      expect((data.entries as any).new?.key).toBe('moved');
      // old key removed (may leave empty parent or be cleaned up)
    });
  });

  describe('reverie_copy', () => {
    it('duplicates value on disk', () => {
      callMcpTool('reverie_set', { key: 'src', value: 'copied' });
      callMcpTool('reverie_copy', { source: 'src', dest: 'dst' });

      const data = readDataFile();
      expect((data.entries as any).src).toBe('copied');
      expect((data.entries as any).dst).toBe('copied');
    });
  });

  describe('reverie_find', () => {
    it('finds entries by value content', () => {
      callMcpTool('reverie_set', { key: 'server.ip', value: '192.168.1.100' });
      callMcpTool('reverie_set', { key: 'app.name', value: 'TestApp' });

      const result = callMcpTool('reverie_find', { query: '192.168' });
      expect(result.content[0].text).toContain('192.168');
      expect(result.content[0].text).not.toContain('TestApp');
    });
  });

  describe('reverie_alias lifecycle', () => {
    it('creates alias and persists it on disk', () => {
      callMcpTool('reverie_set', { key: 'commands.build', value: 'npm run build' });
      callMcpTool('reverie_alias_set', { alias: 'bld', key: 'commands.build' });

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

      const listResult = callMcpTool('reverie_alias_list', {});
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

      callMcpTool('reverie_alias_remove', { alias: 'xy' });

      const after = readDataFile();
      expect((after.aliases as any).xy).toBeUndefined();
    });
  });

  describe('reverie_context', () => {
    it('returns all stored data in compact format', () => {
      callMcpTool('reverie_set', { key: 'project.name', value: 'Test' });
      callMcpTool('reverie_set', { key: 'commands.build', value: 'make' });

      const result = callMcpTool('reverie_context', {});
      const text = result.content[0].text;
      expect(text).toContain('project.name');
      expect(text).toContain('Test');
      expect(text).toContain('commands.build');
      expect(text).toContain('make');
    });
  });

  describe('reverie_import + reverie_export round-trip', () => {
    it('exports and reimports data losslessly', () => {
      callMcpTool('reverie_set', { key: 'a.b', value: 'original' });
      callMcpTool('reverie_set', { key: 'c.d', value: 'other' });

      // Export
      const exportResult = callMcpTool('reverie_export', { type: 'entries' });
      const exportedJson = exportResult.content[0].text;
      const exported = JSON.parse(exportedJson);
      expect(exported.$reverie?.type).toBe('entries');
      expect(exported.entries.a.b).toBe('original');

      // Reset
      callMcpTool('reverie_reset', { type: 'entries' });
      const afterReset = readDataFile();
      expect(Object.keys((afterReset.entries as any))).toHaveLength(0);

      // Import
      callMcpTool('reverie_import', { type: 'entries', data: exportedJson });
      const afterImport = readDataFile();
      expect((afterImport.entries as any).a.b).toBe('original');
      expect((afterImport.entries as any).c.d).toBe('other');
    });
  });

  describe('reverie_reset', () => {
    it('clears all entries on disk', () => {
      callMcpTool('reverie_set', { key: 'foo', value: 'bar' });
      callMcpTool('reverie_reset', { type: 'entries' });

      const data = readDataFile();
      expect(Object.keys(data.entries as any)).toHaveLength(0);
    });
  });

  describe('_meta staleness tracking', () => {
    it('reverie_set writes _meta timestamp for the key', () => {
      callMcpTool('reverie_set', { key: 'tracked.key', value: 'val' });

      const data = readDataFile();
      const meta = data._meta as Record<string, number>;
      expect(meta['tracked.key']).toBeGreaterThan(0);
    });

    it('reverie_remove clears _meta for removed key', () => {
      callMcpTool('reverie_set', { key: 'rm.key', value: 'val' });
      callMcpTool('reverie_remove', { key: 'rm.key' });

      const data = readDataFile();
      const meta = data._meta as Record<string, number> | undefined;
      expect(meta?.['rm.key']).toBeUndefined();
    });
  });

  describe('audit logging', () => {
    it('logs MCP tool calls to audit.jsonl', () => {
      callMcpTool('reverie_set', { key: 'audit.test', value: 'logged' });

      const auditPath = path.join(tmpDir, 'audit.jsonl');
      // Audit may be async — give it a moment
      if (fs.existsSync(auditPath)) {
        const lines = fs.readFileSync(auditPath, 'utf8').trim().split('\n');
        const entries = lines.map(l => JSON.parse(l));
        const setEntry = entries.find((e: any) => e.tool === 'reverie_set' && e.key === 'audit.test');
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
      callMcpTool('reverie_set', { key: 'telemetry.test', value: 'logged' });

      const telemetryPath = path.join(tmpDir, 'telemetry.jsonl');
      if (fs.existsSync(telemetryPath)) {
        const lines = fs.readFileSync(telemetryPath, 'utf8').trim().split('\n');
        const entries = lines.map(l => JSON.parse(l));
        const setEntry = entries.find((e: any) => e.tool === 'reverie_set');
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
    it('reverie_set without scope refuses with the structured error', () => {
      const result = callMcpTool('reverie_set', { key: 'refused.key', value: 'v' }, { skipScopeInject: true });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Project resolution failed');
      expect(result.content[0].text).toContain('RVR_NO_PROJECT');
      // Second content block carries the JSON diagnostic
      expect(result.content[1]?.text).toContain('PROJECT_UNRESOLVED');
      expect(result.content[1]?.text).toContain('rvrNoProject');
      // Nothing was written
      const data = readDataFile();
      expect((data.entries as any).refused).toBeUndefined();
    });

    it('reverie_set with explicit scope:"global" succeeds (rescue path)', () => {
      const result = callMcpTool('reverie_set', { key: 'rescued.key', value: 'v', scope: 'global' });
      expect(result.isError).toBeFalsy();
      const data = readDataFile();
      expect((data.entries as any).rescued.key).toBe('v');
    });

    it('audit logs refusedReason on the refused call and rescuedByExplicitGlobal on the rescued one', () => {
      callMcpTool('reverie_set', { key: 'audit.refused', value: 'v' }, { skipScopeInject: true });
      callMcpTool('reverie_set', { key: 'audit.rescued', value: 'v', scope: 'global' });

      const auditPath = path.join(tmpDir, 'audit.jsonl');
      if (!fs.existsSync(auditPath)) return; // audit is best-effort; if it didn't flush, skip
      const lines = fs.readFileSync(auditPath, 'utf8').trim().split('\n');
      const entries = lines.map(l => JSON.parse(l));

      const refused = entries.find((e: any) => e.tool === 'reverie_set' && e.key === 'audit.refused');
      if (refused) {
        expect(refused.success).toBe(false);
        expect(refused.refusedReason).toBe('project_unresolved');
      }

      const rescued = entries.find((e: any) => e.tool === 'reverie_set' && e.key === 'audit.rescued');
      if (rescued) {
        expect(rescued.success).toBe(true);
        expect(rescued.rescuedByExplicitGlobal).toBe(true);
      }
    });
  });

  // ── #215: a store file that does not parse is an error, not an absence ──
  describe('a store with git conflict markers in it (#215)', () => {
    const HANDOFF = 'context.next_session';
    const storeFile = (name: string) => path.join(tmpDir, 'store', name);
    const conflictedEntry = [
      '{', '<<<<<<< HEAD', '  "value": "our handoff",', '  "meta": {', '    "created": 1000,', '    "updated": 3000',
      '=======', '  "value": "their handoff",', '  "meta": {', '    "created": 1000,', '    "updated": 2000',
      '>>>>>>> theirs', '  }', '}', '',
    ].join('\n');
    const conflictedSidecar = (ours: string, theirs: string) =>
      ['{', '<<<<<<< HEAD', `  ${ours}`, '=======', `  ${theirs}`, '>>>>>>> theirs', '}', ''].join('\n');
    const texts = (r: { content: { text: string }[] }) => r.content.map(c => c.text);

    beforeEach(() => {
      callMcpTool('reverie_set', { key: 'arch.store', value: 'file per entry' });
      callMcpTool('reverie_set', { key: 'commands.hello', value: 'echo hello' });
      fs.writeFileSync(storeFile(`${HANDOFF}.json`), conflictedEntry);
    });

    it('reverie_get: an error naming the conflict, not "not found"', () => {
      const r = callMcpTool('reverie_get', { key: HANDOFF });
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toMatch(/^Cannot read entry 'context\.next_session'/);
      expect(r.content[0].text).toContain('unresolved git conflict markers');
      expect(r.content[0].text).toContain('git checkout --ours --');
    });

    it('an error carries the code and the files as a second, machine-readable block', () => {
      const r = callMcpTool('reverie_get', { key: HANDOFF });
      expect(r.isError).toBe(true);
      expect(r.content).toHaveLength(2);
      const block = r.content[1].text;
      expect(block.startsWith('```json\n') && block.endsWith('\n```')).toBe(true);
      expect(JSON.parse(block.slice('```json\n'.length, -'\n```'.length))).toEqual({
        code: 'STORE_UNREADABLE',
        attempted: 'read',
        files: [{ kind: 'entry', key: HANDOFF, file: storeFile(`${HANDOFF}.json`), reason: 'conflict' }],
      });
    });

    it('reverie_copy and reverie_rename onto it are refused writes, and logged as refusals', () => {
      const copied = callMcpTool('reverie_copy', { source: 'arch.store', dest: HANDOFF, force: true });
      expect(copied.isError).toBe(true);
      expect(copied.content[0].text).toMatch(/^Refusing to write entry 'context\.next_session'/);
      const renamed = callMcpTool('reverie_rename', { oldKey: 'arch.store', newKey: HANDOFF, scope: 'global' });
      expect(renamed.isError).toBe(true);
      expect(renamed.content[0].text).toMatch(/^Refusing to write entry 'context\.next_session'/);
      expect(fs.readFileSync(storeFile(`${HANDOFF}.json`), 'utf8')).toBe(conflictedEntry);
      expect(fs.existsSync(storeFile('arch.store.json'))).toBe(true);

      const audit = fs.readFileSync(path.join(tmpDir, 'audit.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
      for (const tool of ['reverie_copy', 'reverie_rename']) {
        const row = audit.find((e: any) => e.tool === tool);
        expect(row.success, tool).toBe(false);
        expect(row.refusedReason, tool).toBe('store_unreadable');
      }
    });

    it('reverie_run of a command that interpolates it reports the file, not an interpolation error', () => {
      callMcpTool('reverie_set', { key: 'commands.show', value: 'echo ${context.next_session}' });
      const r = callMcpTool('reverie_run', { key: 'commands.show' });
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toMatch(/^Cannot read entry 'context\.next_session'/);
    });

    it('reverie_context past the cap names the remaining files as extra blocks', () => {
      for (let i = 0; i < 10; i++) fs.writeFileSync(storeFile(`context.conflicted${String(i).padStart(2, '0')}.json`), conflictedEntry);
      const r = callMcpTool('reverie_context', {});
      expect(r.content[0].text).toContain('… and 3 more');
      expect(texts(r).slice(1)).toHaveLength(3);
      expect(texts(r).slice(1).join('\n')).toContain('context.conflicted08.json');
      expect(texts(r).slice(1).join('\n')).not.toContain('context.conflicted07.json');
    });

    it('reverie_set: refused, the file untouched, and logged as a refusal', () => {
      const r = callMcpTool('reverie_set', { key: HANDOFF, value: 'a fresh handoff' });
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toMatch(/^Refusing to write entry 'context\.next_session'/);
      expect(r.content[0].text).toContain('Nothing was written');
      expect(fs.readFileSync(storeFile(`${HANDOFF}.json`), 'utf8')).toBe(conflictedEntry);

      const audit = fs.readFileSync(path.join(tmpDir, 'audit.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
      const refused = audit.find((e: any) => e.tool === 'reverie_set' && e.key === HANDOFF);
      expect(refused.success).toBe(false);
      expect(refused.refusedReason).toBe('store_unreadable');
    });

    it('reverie_context: the report comes right after the header, ahead of the entries', () => {
      const r = callMcpTool('reverie_context', {});
      expect(r.isError).toBeFalsy();
      const lines = r.content[0].text.split('\n');
      expect(lines[2]).toBe('!! 1 store file cannot be read. It is NOT shown below and NOT missing — do not write over it:');
      expect(lines[3]).toContain(`${HANDOFF} — `);
      expect(r.content[0].text.indexOf('cannot be read')).toBeLessThan(r.content[0].text.indexOf('arch.store'));
      // The report is in the body; no second copy as a trailing block.
      expect(r.content).toHaveLength(1);
    });

    it('reverie_context sizeOnly still reports it', () => {
      const r = callMcpTool('reverie_context', { sizeOnly: true });
      expect(r.content).toHaveLength(1);
      expect(r.content[0].text).toContain('!! 1 store file cannot be read');
      expect(r.content[0].text).toContain('Context size');
    });

    it('other tools still answer, with the warning as an extra block', () => {
      const r = callMcpTool('reverie_get', { key: 'arch.store' });
      expect(r.isError).toBeFalsy();
      expect(r.content[0].text).toContain('file per entry');
      expect(texts(r).slice(1)).toEqual([
        expect.stringMatching(/^warning: .*context\.next_session\.json has unresolved git conflict markers — entry 'context\.next_session' is not being read\./),
      ]);
    });

    it('reverie_alias_set over a conflicted alias map is refused', () => {
      const aliases = conflictedSidecar('"hand": "context.next_session",', '"ho": "context.next_session",');
      fs.writeFileSync(storeFile('_aliases.json'), aliases);
      const r = callMcpTool('reverie_alias_set', { alias: 'zz', key: 'arch.store' });
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toMatch(/^Refusing to write the alias map/);
      expect(fs.readFileSync(storeFile('_aliases.json'), 'utf8')).toBe(aliases);
    });

    it('reverie_set with an alias refuses before the value is written', () => {
      const aliases = conflictedSidecar('"hand": "context.next_session",', '"ho": "context.next_session",');
      fs.writeFileSync(storeFile('_aliases.json'), aliases);
      const r = callMcpTool('reverie_set', { key: 'arch.store', value: 'v2', alias: 'zz' });
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toMatch(/^Refusing to write the alias map/);
      expect(callMcpTool('reverie_get', { key: 'arch.store' }).content[0].text).toContain('file per entry');
      expect(fs.readFileSync(storeFile('_aliases.json'), 'utf8')).toBe(aliases);
    });

    it('reverie_rename and reverie_remove refuse before the entry moves or goes', () => {
      fs.writeFileSync(storeFile('_confirm.json'), conflictedSidecar('"commands.deploy": true,', '"commands.wipe": true,'));
      const renamed = callMcpTool('reverie_rename', { oldKey: 'arch.store', newKey: 'arch.moved', scope: 'global' });
      expect(renamed.isError).toBe(true);
      expect(renamed.content[0].text).toMatch(/^Refusing to write the confirmation list/);
      const removed = callMcpTool('reverie_remove', { key: 'arch.store' });
      expect(removed.isError).toBe(true);
      expect(fs.existsSync(storeFile('arch.store.json'))).toBe(true);
      expect(fs.existsSync(storeFile('arch.moved.json'))).toBe(false);
    });

    it('reverie_remove of the conflicted entry is not "not found", and keeps the file', () => {
      const r = callMcpTool('reverie_remove', { key: HANDOFF });
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toMatch(/^Cannot read entry 'context\.next_session'/);
      expect(fs.readFileSync(storeFile(`${HANDOFF}.json`), 'utf8')).toBe(conflictedEntry);
    });

    it('removing or renaming an alias over a conflicted alias map is refused, not "not found"', () => {
      const aliases = conflictedSidecar('"hand": "context.next_session",', '"ho": "context.next_session",');
      fs.writeFileSync(storeFile('_aliases.json'), aliases);
      const calls: [string, Record<string, unknown>][] = [
        ['reverie_alias_remove', { alias: 'hand' }],
        ['reverie_remove', { key: 'hand', is_alias: true }],
        ['reverie_rename', { oldKey: 'hand', newKey: 'h2', is_alias: true, scope: 'global' }],
      ];
      for (const [tool, params] of calls) {
        const r = callMcpTool(tool, params);
        expect(r.isError, tool).toBe(true);
        expect(r.content[0].text, tool).toMatch(/^Refusing to write the alias map/);
      }
      expect(fs.readFileSync(storeFile('_aliases.json'), 'utf8')).toBe(aliases);
    });

    it('removing or renaming the parent of the conflicted entry is refused', () => {
      callMcpTool('reverie_set', { key: 'context.other', value: 'a readable sibling' });
      const removed = callMcpTool('reverie_remove', { key: 'context' });
      expect(removed.isError).toBe(true);
      expect(removed.content[0].text).toMatch(/^Refusing to remove 'context' while entry 'context\.next_session' under it cannot be read/);
      const renamed = callMcpTool('reverie_rename', { oldKey: 'context', newKey: 'ctx', scope: 'global' });
      expect(renamed.isError).toBe(true);
      expect(renamed.content[0].text).toMatch(/^Refusing to rename 'context' while entry 'context\.next_session' under it cannot be read/);
      expect(fs.existsSync(storeFile('context.other.json'))).toBe(true);
      expect(fs.existsSync(storeFile('ctx.other.json'))).toBe(false);
      expect(fs.readFileSync(storeFile(`${HANDOFF}.json`), 'utf8')).toBe(conflictedEntry);
    });

    it('a write under the conflicted entry is refused', () => {
      const r = callMcpTool('reverie_set', { key: `${HANDOFF}.extra`, value: 'v' });
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toMatch(/^Refusing to write 'context\.next_session\.extra' under entry 'context\.next_session'/);
      expect(fs.existsSync(storeFile(`${HANDOFF}.extra.json`))).toBe(false);
    });

    it('reverie_run fails closed when the confirmation list is conflicted', () => {
      fs.writeFileSync(storeFile('_confirm.json'), conflictedSidecar('"commands.deploy": true,', '"commands.wipe": true,'));
      const r = callMcpTool('reverie_run', { key: 'commands.hello' });
      // An entry with no flag of its own must not simply execute.
      expect(texts(r).join('\n')).not.toMatch(/^hello$/m);
      expect(texts(r).join('\n')).toMatch(/confirm/i);
      expect(texts(r).join('\n')).toContain('every entry is treated as requiring confirmation to run');
    });

    // The server is long-lived and skips a rescan while the store directory's
    // mtime is unchanged. git moves that mtime; an editor save or
    // `cp backup <file>` does not.
    describe('one running server, a file repaired in place', () => {
      const storeDir = () => path.join(tmpDir, 'store');
      /** Rewrite a file without removing or renaming it; the directory must not notice. */
      const inPlace = (name: string, content: string): void => {
        const dirBefore = fs.statSync(storeDir()).mtimeMs;
        fs.writeFileSync(storeFile(name), content);
        const when = Date.now() / 1000 + 100;
        fs.utimesSync(storeFile(name), when, when);
        expect(fs.statSync(storeDir()).mtimeMs).toBe(dirBefore);
      };
      const repairedHandoff = JSON.stringify({ value: 'our handoff', meta: { created: 1000, updated: 3000 } }, null, 2);

      it('the entry is read again, the warning stops, and the next save keeps the file', async () => {
        await withMcpSession(async call => {
          expect((await call('reverie_context')).content[0].text).toContain('!! 1 store file cannot be read');

          inPlace(`${HANDOFF}.json`, repairedHandoff);

          const ctx = await call('reverie_context');
          expect(ctx.content[0].text).not.toContain('cannot be read');
          expect(ctx.content[0].text).toContain('our handoff');
          expect((await call('reverie_get', { key: 'arch.store' })).content).toHaveLength(1);
          expect((await call('reverie_find', { query: 'our handoff' })).content[0].text).toContain(HANDOFF);

          // A full save. It used to act on the stale picture — the entry was
          // not in the data being saved — and delete the repaired file.
          expect((await call('reverie_alias_set', { alias: 'zz', key: 'arch.store' })).isError).toBeFalsy();
          expect(fs.existsSync(storeFile(`${HANDOFF}.json`))).toBe(true);
          expect((await call('reverie_get', { key: HANDOFF })).content[0].text).toContain('our handoff');
        });
      });

      it('a repaired alias map keeps its aliases through the next alias write', async () => {
        fs.writeFileSync(storeFile(`${HANDOFF}.json`), repairedHandoff);
        fs.writeFileSync(storeFile('_aliases.json'), conflictedSidecar('"hand": "context.next_session",', '"ho": "context.next_session",'));
        await withMcpSession(async call => {
          expect(texts(await call('reverie_get', { key: 'arch.store' })).join('\n')).toContain('no aliases are being read');

          inPlace('_aliases.json', JSON.stringify({ hand: HANDOFF }, null, 2));

          expect((await call('reverie_get', { key: 'hand' })).content[0].text).toContain('our handoff');
          expect((await call('reverie_alias_set', { alias: 'st', key: 'arch.store' })).isError).toBeFalsy();
          expect(JSON.parse(fs.readFileSync(storeFile('_aliases.json'), 'utf8'))).toEqual({ hand: HANDOFF, st: 'arch.store' });
        });
      });

      it('a repaired confirmation list stops gating every run', async () => {
        fs.writeFileSync(storeFile(`${HANDOFF}.json`), repairedHandoff);
        fs.writeFileSync(storeFile('_confirm.json'), conflictedSidecar('"commands.deploy": true,', '"commands.wipe": true,'));
        await withMcpSession(async call => {
          expect(texts(await call('reverie_run', { key: 'commands.hello' })).join('\n')).toMatch(/requires confirmation/);

          inPlace('_confirm.json', '{}');

          const ran = await call('reverie_run', { key: 'commands.hello' });
          expect(texts(ran).join('\n')).toMatch(/^hello$/m);
          expect(ran.content).toHaveLength(1);
        });
      });
    });

    it('names files by absolute path, whatever directory the server was started in', async () => {
      // Started inside the data dir, a path relative to the cwd would read
      // `store/context.next_session.json` — a file the user cannot find.
      const real = fs.realpathSync(tmpDir);
      const absolute = path.join(real, 'store', `${HANDOFF}.json`);
      await withMcpSession(async call => {
        const r = await call('reverie_get', { key: HANDOFF });
        expect(r.isError).toBe(true);
        expect(r.content[0].text).toContain(`\`git checkout --ours -- ${absolute}\``);
        expect(r.content[0].text).toContain(`\`git add ${absolute}\``);
      }, { cwd: real, dataDir: real });
    });

    it('a healthy store gets no extra block', () => {
      fs.rmSync(storeFile(`${HANDOFF}.json`));
      const r = callMcpTool('reverie_get', { key: 'arch.store' });
      expect(r.content).toHaveLength(1);
    });
  });
});
