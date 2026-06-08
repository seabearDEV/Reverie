// End-to-end integration tests for the #117 WS1 structured-output envelope
// and WS2 manifest. Spawns the built dist/index.js exactly like the other
// integration suites (assumes `bun run build` has run — CI builds first).

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('CLI JSON envelope (#117)', () => {
  const testDir = path.join(os.tmpdir(), 'reverie-json-' + Math.random().toString(36).slice(2));
  const baseEnv = { ...process.env, RVR_DATA_DIR: testDir, RVR_NO_PROJECT: '1' };

  // Returns { stdout, status }. Writes auto-target the global store (#99): we
  // append `--global` after the verb token (skipping a leading `--json`), so
  // it lands on the leaf command's -G option rather than a command group.
  const run = (args: string, env: Record<string, string> = {}) => {
    const verb = args.replace(/^--json\s+/, '').split(/\s+/)[0];
    if (/^(set|rm|remove|copy|cp|rename|run)$/.test(verb)) {
      args = args.replace(new RegExp(`(\\b${verb}\\b)`), '$1 --global');
    } else if (verb === 'confirm' || verb === 'alias') {
      // group commands: -G lives on the leaf — append at the end.
      args = `${args} --global`;
    }
    try {
      const stdout = execSync(`bun dist/index.js ${args}`, {
        env: { ...baseEnv, ...env }, stdio: ['pipe', 'pipe', 'pipe'],
      }).toString();
      return { stdout, status: 0 };
    } catch (e: unknown) {
      const err = e as { stdout?: Buffer; status?: number };
      return { stdout: (err.stdout ?? Buffer.from('')).toString(), status: err.status ?? 1 };
    }
  };

  const parse = (s: string) => JSON.parse(s);

  beforeAll(() => { fs.mkdirSync(testDir, { recursive: true }); });
  afterAll(() => { fs.rmSync(testDir, { recursive: true, force: true }); });

  it('wraps a successful read in the versioned envelope', () => {
    run('set env.k "hello"');
    const env = parse(run('--json get env.k').stdout);
    expect(env.reverie).toBe('1');
    expect(env.ok).toBe(true);
    expect(env.command).toBe('get');
    expect(env.result).toEqual({ 'env.k': 'hello' });
  });

  it('RVR_OUTPUT=json enables JSON mode session-wide', () => {
    run('set env.k2 "v2"');
    const env = parse(run('get env.k2', { RVR_OUTPUT: 'json' }).stdout);
    expect(env.ok).toBe(true);
    expect(env.result).toEqual({ 'env.k2': 'v2' });
  });

  it('emits a structured error with non-zero exit for a missing key', () => {
    const r = run('--json get env.does.not.exist');
    expect(r.status).not.toBe(0);
    const env = parse(r.stdout);
    expect(env.ok).toBe(false);
    expect(env.error.code).toBe('NOT_FOUND');
  });

  it('emits exactly one envelope on stdout for a mutation', () => {
    const out = run('--json set env.m "x"').stdout.trim();
    expect(out.split('\n').filter(l => l === '}').length).toBe(1); // one closing brace at col 0
    const env = parse(out);
    expect(env.ok).toBe(true);
    expect(env.command).toBe('set');
    expect(env.result.key).toBe('env.m');
  });

  it('run --dry returns the resolved command preview', () => {
    run('set env.cmd "echo hi"');
    const env = parse(run('--json run env.cmd --dry').stdout);
    expect(env.ok).toBe(true);
    expect(env.result.command).toBe('echo hi');
  });

  it('run executes and captures stdout/exitCode', () => {
    run('set env.cmd2 "echo captured"');
    const env = parse(run('--json run env.cmd2 --yes').stdout);
    expect(env.ok).toBe(true);
    expect(env.result.exitCode).toBe(0);
    expect(env.result.stdout).toContain('captured');
  });

  it('run on a confirm entry without --yes refuses with E_REQUIRES_CONFIRMATION', () => {
    run('set env.danger "echo boom"');
    run('confirm set env.danger');
    const r = run('--json run env.danger');
    expect(r.status).not.toBe(0);
    const env = parse(r.stdout);
    expect(env.ok).toBe(false);
    expect(env.error.code).toBe('REQUIRES_CONFIRMATION');
    expect(env.error.preview).toBe('echo boom');
    expect(env.result.command).toBe('echo boom');
  });

  it('manifest --json describes the command tree and MCP map', () => {
    const env = parse(run('--json manifest').stdout);
    expect(env.ok).toBe(true);
    expect(env.command).toBe('manifest');
    expect(env.result.envelope.version).toBe('1');
    expect(Object.keys(env.result.mcpToolMap)).toHaveLength(19);
    expect(env.result.commands.some((c: { name: string }) => c.name === 'get')).toBe(true);
  });
});
