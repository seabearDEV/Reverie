/**
 * #213 end to end: `rvr config get|set|unset` against the built dist/index.js
 * (assumes `bun run build` has run, like the other spawn suites).
 */
import { execFileSync, spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { assertDistHonorsDataDir } from './helpers/spawnGuard';

let dir = '';
let configPath = '';

const env = () => ({ ...process.env, RVR_DATA_DIR: dir, RVR_NO_PROJECT: '1' });

function run(...args: string[]): { stdout: string; status: number } {
  try {
    const stdout = execFileSync('bun', ['dist/index.js', ...args], { env: env(), stdio: ['ignore', 'pipe', 'pipe'] }).toString();
    return { stdout, status: 0 };
  } catch (e: unknown) {
    const err = e as { stdout?: Buffer; status?: number };
    return { stdout: (err.stdout ?? Buffer.from('')).toString(), status: err.status ?? 1 };
  }
}

function runAsync(...args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn('bun', ['dist/index.js', ...args], { env: env(), stdio: 'ignore' });
    child.on('error', reject);
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

const onDisk = (): Record<string, unknown> => JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;

beforeAll(() => { assertDistHonorsDataDir(); });
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rvr-213-cli-'));
  configPath = path.join(dir, 'config.json');
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('#213: rvr config', () => {
  it('the first command on a data dir that does not exist yet still logs its telemetry row', () => {
    const nested = path.join(dir, 'fresh');
    const r = execFileSync('bun', ['dist/index.js', 'config', 'get', 'theme'], {
      env: { ...env(), RVR_DATA_DIR: nested }, stdio: ['ignore', 'pipe', 'pipe'],
    }).toString();
    expect(r).toContain('theme: default');
    expect(fs.existsSync(path.join(nested, 'telemetry.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(nested, 'config.json'))).toBe(false);
  });

  it('config get on a fresh data dir reports every effective value and writes no config.json', () => {
    const env = JSON.parse(run('--json', 'config', 'get').stdout);
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
    const env = JSON.parse(r.stdout);
    expect(env.ok).toBe(true);
    expect(env.command).toBe('config unset');
    expect(env.result).toEqual({ key: 'theme', value: 'default', previous: 'dark' });
    expect(onDisk()).toEqual({ _format: 2, max_backups: 3 });
    expect(run('config', 'get', 'theme').stdout).toContain('theme: default');
  });

  it('config unset of an unknown key fails with NOT_FOUND', () => {
    const r = run('--json', 'config', 'unset', 'no_such_setting');
    expect(r.status).not.toBe(0);
    const env = JSON.parse(r.stdout);
    expect(env.ok).toBe(false);
    expect(env.error.code).toBe('NOT_FOUND');
    expect(fs.existsSync(configPath)).toBe(false);
  });

  it('an install that persisted an old budget default gets the current one, and can still choose the old value (#212)', () => {
    fs.writeFileSync(configPath, JSON.stringify({
      colors: true, theme: 'default', max_backups: 10, import_max_bytes: 52428800, bootstrap_max_response_bytes: 38912,
    }, null, 2));
    expect(JSON.parse(run('--json', 'config', 'get', 'bootstrap_max_response_bytes').stdout).result)
      .toEqual({ bootstrap_max_response_bytes: 28672 });
    expect(onDisk()).toEqual({ _format: 2 });

    expect(run('config', 'set', 'bootstrap_max_response_bytes', '38912').status).toBe(0);
    expect(JSON.parse(run('--json', 'config', 'get', 'bootstrap_max_response_bytes').stdout).result)
      .toEqual({ bootstrap_max_response_bytes: 38912 });
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
