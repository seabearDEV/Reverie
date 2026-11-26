/**
 * #213 / #273 end to end: `rvr config get|set|unset` against the built
 * dist/index.js (assumes `bun run build` has run, like the other spawn suites).
 */
import { spawnSync, spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { assertDistHonorsDataDir } from './helpers/spawnGuard';

let dir = '';
let configPath = '';

const env = (dataDir = dir) => ({ ...process.env, RVR_DATA_DIR: dataDir, RVR_NO_PROJECT: '1' });

function run(...args: string[]): { stdout: string; stderr: string; status: number } {
  const r = spawnSync('bun', ['dist/index.js', ...args], { env: env(), stdio: ['ignore', 'pipe', 'pipe'] });
  return { stdout: r.stdout.toString(), stderr: r.stderr.toString(), status: r.status ?? 1 };
}

function runAsync(...args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn('bun', ['dist/index.js', ...args], { env: env(), stdio: 'ignore' });
    child.on('error', reject);
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

const onDisk = (): Record<string, unknown> => JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
const json = (r: { stdout: string }) => JSON.parse(r.stdout) as { ok: boolean; command: string; result?: unknown; error?: { code: string; message: string } };
const auditRows = (): { tool: string; before?: string; after?: string; scope?: string }[] =>
  fs.readFileSync(path.join(dir, 'audit.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l) as { tool: string });
/** v1.2.0–v1.3.0's config.json: every default of the day, no marker. */
const V130_FILE = { colors: true, theme: 'default', max_backups: 10, import_max_bytes: 52428800, bootstrap_max_response_bytes: 38912 };

beforeAll(() => { assertDistHonorsDataDir(); });
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rvr-213-cli-'));
  configPath = path.join(dir, 'config.json');
});
afterEach(() => {
  try { fs.chmodSync(dir, 0o700); } catch { /* already gone */ }
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('#213: rvr config', () => {
  it('the first command on a data dir that does not exist yet still logs its telemetry row', () => {
    const nested = path.join(dir, 'fresh');
    const r = spawnSync('bun', ['dist/index.js', 'config', 'get', 'theme'], { env: env(nested), stdio: ['ignore', 'pipe', 'pipe'] });
    expect(r.stdout.toString()).toContain('theme: default');
    expect(fs.existsSync(path.join(nested, 'telemetry.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(nested, 'config.json'))).toBe(false);
  });

  it('config get on a fresh data dir reports every effective value and writes no config.json', () => {
    const env = json(run('--json', 'config', 'get'));
    expect(env.ok).toBe(true);
    expect(env.result).toEqual({
      colors: true, theme: 'default', max_backups: 10, import_max_bytes: 52428800,
      bootstrap_max_response_bytes: 28672, bootstrap_gist_chars: 160,
    });
    expect(fs.existsSync(configPath)).toBe(false);
  });

  it('config unset returns a key to its default, in the --json envelope too', () => {
    expect(run('config', 'set', 'theme', 'dark').status).toBe(0);
    expect(run('config', 'set', 'max_backups', '3').status).toBe(0);
    expect(onDisk()).toEqual({ _format: 2, theme: 'dark', max_backups: 3 });

    const r = run('--json', 'config', 'unset', 'theme');
    expect(r.status).toBe(0);
    const env = json(r);
    expect(env.ok).toBe(true);
    expect(env.command).toBe('config unset');
    expect(env.result).toEqual({ key: 'theme', value: 'default', previous: 'dark' });
    expect(onDisk()).toEqual({ _format: 2, max_backups: 3 });
    expect(run('config', 'get', 'theme').stdout).toContain('theme: default');
  });

  it('config unset of an unknown key fails with NOT_FOUND', () => {
    const r = run('--json', 'config', 'unset', 'no_such_setting');
    expect(r.status).not.toBe(0);
    const env = json(r);
    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe('NOT_FOUND');
    expect(fs.existsSync(configPath)).toBe(false);
  });

  it('an install that persisted an old budget default gets the current one, and can still choose the old value (#212)', () => {
    fs.writeFileSync(configPath, JSON.stringify(V130_FILE, null, 2));
    const before = fs.readFileSync(configPath, 'utf8');
    expect(json(run('--json', 'config', 'get', 'bootstrap_max_response_bytes')).result).toEqual({ bootstrap_max_response_bytes: 28672 });
    expect(fs.readFileSync(configPath, 'utf8')).toBe(before); // a read never rewrites it

    expect(run('config', 'set', 'bootstrap_max_response_bytes', '38912').status).toBe(0);
    expect(onDisk()).toEqual({ _format: 2, bootstrap_max_response_bytes: 38912 });
    expect(fs.existsSync(path.join(dir, 'config.format'))).toBe(true);
    expect(json(run('--json', 'config', 'get', 'bootstrap_max_response_bytes')).result).toEqual({ bootstrap_max_response_bytes: 38912 });
  });

  it("an older Reverie rewriting config.json does not cost the user's 51200; it is noted once", () => {
    expect(run('config', 'set', 'bootstrap_max_response_bytes', '51200').status).toBe(0);
    // What v1.3.0's saveConfig leaves after `config set theme dark`: the
    // whole object, the user's 51200 in it, no marker.
    fs.writeFileSync(configPath, JSON.stringify({ ...V130_FILE, theme: 'dark', bootstrap_max_response_bytes: 51200 }, null, 2));
    const first = run('config', 'get', 'bootstrap_max_response_bytes');
    expect(first.stdout).toContain('bootstrap_max_response_bytes: 51200');
    expect(first.stderr.trim().split('\n').filter(l => l.includes('rewritten by an older Reverie'))).toHaveLength(1);
    const second = run('config', 'get', 'bootstrap_max_response_bytes');
    expect(second.stdout).toContain('bootstrap_max_response_bytes: 51200');
    expect(second.stderr).not.toContain('rewritten by an older Reverie');
  });

  it('parallel config set of different keys loses none of them', async () => {
    const settings: Record<string, string> = {
      colors: 'false', theme: 'dark', max_backups: '3', import_max_bytes: '1000',
      bootstrap_max_response_bytes: '40000', bootstrap_gist_chars: '100',
    };
    const codes = await Promise.all(Object.entries(settings).map(([k, v]) => runAsync('config', 'set', k, v)));
    expect(codes).toEqual(Object.keys(settings).map(() => 0));
    expect(onDisk()).toEqual({
      _format: 2, colors: false, theme: 'dark', max_backups: 3, import_max_bytes: 1000,
      bootstrap_max_response_bytes: 40000, bootstrap_gist_chars: 100,
    });
  });
});

describe('#213: a config write that fails says so', () => {
  const seed = () => fs.writeFileSync(configPath, JSON.stringify({ _format: 2, theme: 'dark' }, null, 2));

  it('a lock held for the whole wait: set and unset fail with IO and leave the file', () => {
    seed();
    const before = fs.readFileSync(configPath, 'utf8');
    fs.writeFileSync(configPath + '.lock', '99999');
    for (const args of [['config', 'set', 'theme', 'light'], ['config', 'unset', 'theme']]) {
      const r = run('--json', ...args);
      expect(r.status, args.join(' ')).toBe(1);
      const env = json(r);
      expect(env.ok).toBe(false);
      expect(env.error?.code).toBe('IO');
      expect(env.error?.message).toContain('nothing was written');
      expect(fs.readFileSync(configPath, 'utf8')).toBe(before);
    }
  });

  it('the lock-timeout line is the plain #261 one', () => {
    seed();
    fs.writeFileSync(configPath + '.lock', '99999');
    const r = run('config', 'set', 'theme', 'light');
    expect(r.status).toBe(1);
    const lines = r.stderr.trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^✗ Unable to acquire lock on .*config\.json after 1000ms: another process held it the whole time, so nothing was written\./);
    expect(r.stdout).not.toContain('set to');
  });

  it('a data directory that cannot be written: set fails with IO and leaves the file', () => {
    if (process.getuid?.() === 0) return; // root writes anyway
    seed();
    const before = fs.readFileSync(configPath, 'utf8');
    run('config', 'get'); // let the first-run bookkeeping land first
    fs.chmodSync(dir, 0o555);
    const r = run('--json', 'config', 'set', 'theme', 'light');
    expect(r.status).toBe(1);
    expect(json(r).error?.code).toBe('IO');
    expect(fs.readFileSync(configPath, 'utf8')).toBe(before);
  });

  for (const text of ['{"colors":false,"theme":"dark","max_backups":3,}', '[]']) {
    it(`a config.json that does not parse (${text}) is refused, not replaced`, () => {
      fs.writeFileSync(configPath, text);
      for (const args of [['config', 'unset', 'theme'], ['config', 'set', 'theme', 'light']]) {
        const r = run('--json', ...args);
        expect(r.status, args.join(' ')).toBe(1);
        const env = json(r);
        expect(env.error?.code).toBe('IO');
        expect(env.error?.message).toContain(configPath);
        expect(fs.readFileSync(configPath, 'utf8')).toBe(text);
      }
      // A read falls back to the defaults with one plain line.
      const get = run('config', 'get', 'theme');
      expect(get.status).toBe(0);
      expect(get.stdout).toContain('theme: default');
      expect(get.stderr.trim().split('\n')).toHaveLength(1);
      expect(get.stderr).toContain(`Warning: ${configPath}`);
    });
  }
});

describe('#273: config set refuses what it rejects', () => {
  const cases: [string[], string][] = [
    [['theme', 'neon'], 'INVALID_INPUT'],
    [['max_backups', '-1'], 'INVALID_INPUT'],
    [['nosuch', '1'], 'NOT_FOUND'],
  ];
  for (const [args, code] of cases) {
    it(`config set ${args.join(' ')} fails with ${code} and writes nothing`, () => {
      const r = run('--json', 'config', 'set', ...args);
      expect(r.status).toBe(1);
      const env = json(r);
      expect(env.ok).toBe(false);
      expect(env.error?.code).toBe(code);
      expect(fs.existsSync(configPath)).toBe(false);
      const human = run('config', 'set', ...args);
      expect(human.status).toBe(1);
      expect(human.stdout).not.toContain('set to');
    });
  }

  it("the audit row's before is the setting's previous value, not a store entry of the same name", () => {
    expect(run('config', 'set', 'theme', 'dark').status).toBe(0);
    expect(run('set', 'theme', 'an entry named theme', '--global').status).toBe(0);
    expect(run('config', 'set', 'theme', 'light').status).toBe(0);
    expect(run('config', 'unset', 'theme').status).toBe(0);
    const rows = auditRows().filter(r => r.tool.startsWith('reverie_config_'));
    expect(rows.map(r => [r.tool, r.before, r.after, r.scope])).toEqual([
      ['reverie_config_set', 'default', 'dark', 'global'],
      ['reverie_config_set', 'dark', 'light', 'global'],
      ['reverie_config_unset', 'light', undefined, 'global'],
    ]);
  });

  it('a key that is an Object property name records no before', () => {
    expect(run('--json', 'config', 'set', 'constructor', '1').status).toBe(1);
    const row = auditRows().filter(r => r.tool === 'reverie_config_set').at(-1);
    expect(row?.before).toBeUndefined();
  });
});
