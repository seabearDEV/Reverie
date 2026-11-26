// #261: when another process holds the store lock for the whole wait, a
// write gives up. Several commands then printed a Bun source excerpt and a
// stack trace; --json said RUNTIME. The refusal is one line now — nothing
// was written, try again — with the code IO on every surface.

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { assertDistHonorsDataDir } from './helpers/spawnGuard';

describe('a write that cannot get the store lock (#261)', () => {
  let dataDir: string;
  const env = () => ({ ...process.env, RVR_DATA_DIR: dataDir, RVR_NO_PROJECT: '1' });
  const rvr = (...args: string[]) => {
    const r = spawnSync('bun', ['dist/index.js', ...args], { env: env(), input: '', timeout: 15000 });
    return { stdout: r.stdout.toString(), stderr: r.stderr.toString(), status: r.status };
  };
  /** Hold the global store's lock, as a writer in another process would. */
  const hold = () => fs.writeFileSync(path.join(dataDir, 'store.lock'), '99999');

  beforeAll(() => assertDistHonorsDataDir());
  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reverie-locktimeout-'));
    expect(rvr('set', '-G', 'k', 'v').status).toBe(0);
    expect(rvr('alias', 'set', '-G', 'al', 'k').status).toBe(0);
    hold();
  });
  afterEach(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  it.each([
    ['set', ['set', '-G', 'k', 'v2']],
    ['rm', ['rm', '-G', 'k', '-f']],
    ['confirm set', ['confirm', 'set', '-G', 'k']],
    ['alias remove', ['alias', 'remove', '-G', 'al']],
  ])('%s: one line saying nothing was written, exit 1; --json says IO', (_name, args) => {
    const text = rvr(...args);
    expect(text.status).toBe(1);
    expect(text.stderr).toContain('nothing was written');
    expect(text.stderr).not.toMatch(/^\s+at /m);
    expect(text.stderr).not.toContain('LockTimeoutError');
    expect(text.stderr).not.toContain('Failed to');
    const json = rvr('--json', ...args);
    expect(json.status).toBe(1);
    expect((JSON.parse(json.stdout) as { error: { code: string } }).error.code).toBe('IO');
  }, 30000);

  it('reverie_set over MCP: an error result with the same message', () => {
    const lines = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'reverie_set', arguments: { key: 'k', value: 'v3', scope: 'global' } } },
    ].map(m => JSON.stringify(m)).join('\n') + '\n';
    const r = spawnSync('bun', ['dist/index.js', 'mcp-server'], { env: env(), input: lines, timeout: 15000 });
    const reply = r.stdout.toString().trim().split('\n').map(l => { try { return JSON.parse(l) as { id?: number; result?: { isError?: boolean; content: { text: string }[] } }; } catch { return {}; } })
      .find(m => m.id === 2);
    expect(reply?.result?.isError).toBe(true);
    expect(reply?.result?.content[0].text).toMatch(/^Unable to acquire lock on .* nothing was written/);
    // The code reaches the telemetry row, as on the CLI.
    const rows = fs.readFileSync(path.join(dataDir, 'telemetry.jsonl'), 'utf8').trim().split('\n')
      .map(l => JSON.parse(l) as { tool?: string; src?: string; errorCode?: string });
    const row = rows.reverse().find(x => x.tool === 'reverie_set' && x.src === 'mcp');
    expect(row?.errorCode).toBe('IO');
  }, 30000);
});
