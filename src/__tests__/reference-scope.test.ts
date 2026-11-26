// #280: a reference resolves in the store of the entry that holds it.
//
// `${key}` and `$(key)` read project-first whatever entry they were written
// in, so the user's own global command, run inside a cloned repository —
// even with `run -G` — was filled in from the repository's entries, and its
// `$(key)` ran the repository's command. `--dry`, the confirm prompt and the
// JSON preview all showed `$(key)` as written, so nothing showed the swap.
//
// Now a global entry's references, and the aliases they name, read the
// global store only, all the way down; a project entry's read the project,
// then the global store, as before. Every read path follows the same rule,
// so `get` shows what `run` runs, and the confirmation gate checks what runs.
//
// Spawns the built dist (assumes `bun run build` has run). The global store
// is a temp RVR_DATA_DIR; the "cloned repo" is a temp git directory whose
// `.reverie/` files are written by hand, as an attacker would commit them.

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { assertDistHonorsDataDir } from './helpers/spawnGuard';
import { openMcpSession, type McpSession } from './helpers/mcpSession';

interface Envelope {
  ok: boolean;
  result?: Record<string, unknown>;
  error?: { code: string; message: string };
}

const SLOW_TEST_MS = 60_000;

describe('#280: a reference resolves in the store of the entry that holds it', () => {
  const cli = path.resolve('dist/index.js');
  let root: string;
  let dataDir: string;
  let clone: string;
  let outside: string;

  const env = (): NodeJS.ProcessEnv => {
    const e: Record<string, string | undefined> = { ...process.env, RVR_DATA_DIR: dataDir, RVR_AGENT_NAME: 'test' };
    for (const k of ['RVR_SESSION', 'RVR_NO_PROJECT', 'RVR_PROJECT', 'RVR_OUTPUT']) delete e[k];
    return e as NodeJS.ProcessEnv;
  };
  const rvrIn = (cwd: string, ...args: string[]) => {
    const r = spawnSync('bun', [cli, ...args], { cwd, env: env(), input: '' });
    return { stdout: r.stdout.toString(), stderr: r.stderr.toString(), status: r.status };
  };
  const rvr = (...args: string[]) => rvrIn(clone, ...args);
  const json = (...args: string[]): Envelope => JSON.parse(rvr('--json', ...args).stdout) as Envelope;
  const setGlobal = (key: string, value: string) => { expect(rvrIn(outside, 'set', '-G', key, value).status).toBe(0); };

  const marker = (name: string) => path.join(root, `ran-${name}`);
  const touch = (name: string) => `touch ${marker(name)}`;
  const ran = (name: string) => fs.existsSync(marker(name));
  const ship = (file: string, content: unknown) => {
    fs.writeFileSync(path.join(clone, '.reverie', file), JSON.stringify(content));
  };
  const shipEntry = (key: string, value: string) => { ship(`${key}.json`, { value }); };

  beforeAll(() => { assertDistHonorsDataDir(); });

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'reverie-ref-scope-'));
    dataDir = path.join(root, 'data');
    clone = path.join(root, 'clone');
    outside = path.join(root, 'outside');
    for (const d of [dataDir, path.join(clone, '.reverie'), outside]) fs.mkdirSync(d, { recursive: true });
    spawnSync('git', ['init', '-q', clone]);
    // The audit's global store: the user's own commands and settings.
    setGlobal('cfg.ver', 'echo 1.0');
    setGlobal('cfg.host', 'prod.example');
    setGlobal('cmd.tag', 'echo tag=$(cfg.ver)');
    setGlobal('cmd.deploy', 'echo deploying to ${cfg.host}');
    // The cloned repository ships entries under the same names.
    shipEntry('cfg.ver', `${touch('exec')}; echo 9`);
    shipEntry('cfg.host', `x; ${touch('value')} #`);
  });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  it('run -G: a $(key) in a global command runs the global command, and --dry shows the text it runs', () => {
    expect(rvr('run', '-G', 'cmd.tag', '--dry').stdout).toContain('echo tag=$(cfg.ver)');
    const r = rvr('run', '-G', 'cmd.tag');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('tag=1.0');
    expect(ran('exec')).toBe(false);
  }, SLOW_TEST_MS);

  it('run -G: a ${key} in a global command is filled in from the global store, in the preview and the run', () => {
    const preview = json('run', '-G', 'cmd.deploy', '--dry');
    expect(preview.result?.command).toBe('echo deploying to prod.example');
    const r = rvr('run', '-G', 'cmd.deploy');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('deploying to prod.example');
    expect(ran('value')).toBe(false);
  }, SLOW_TEST_MS);

  it('run without -G: a global command the project does not override resolves in the global store too', () => {
    expect(rvr('run', 'cmd.tag').stdout).toContain('tag=1.0');
    expect(rvr('run', 'cmd.deploy').stdout).toContain('deploying to prod.example');
    expect(rvr('run', 'cmd.tag:cmd.deploy').stdout).toContain('tag=1.0 echo deploying to prod.example');
    expect(ran('exec')).toBe(false);
    expect(ran('value')).toBe(false);
  }, SLOW_TEST_MS);

  it('a project alias does not redirect a global command\'s reference', () => {
    ship('_aliases.json', { 'cfg.ver': 'evil.ver' });
    shipEntry('evil.ver', `${touch('alias')}; echo 6`);
    expect(rvr('run', '-G', 'cmd.tag').stdout).toContain('tag=1.0');
    expect(ran('alias')).toBe(false);
  }, SLOW_TEST_MS);

  it('a global chain runs the global entries it lists', () => {
    setGlobal('cmd.both', 'cfg.ver cmd.tag');
    const r = rvr('run', '--chain', 'cmd.both');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('1.0');
    expect(ran('exec')).toBe(false);
  }, SLOW_TEST_MS);

  it('a project entry\'s references read the project, then the global store, as before', () => {
    setGlobal('g.only', 'from-global');
    shipEntry('p.cmd', 'echo ${cfg.ver} ${g.only}');
    expect(json('get', 'p.cmd').result?.['p.cmd']).toBe(`echo ${touch('exec')}; echo 9 from-global`);
    // Reached from a project entry, a global entry's own references are still global.
    shipEntry('p.wrap', 'echo [${cmd.deploy}]');
    expect(json('get', 'p.wrap').result?.['p.wrap']).toBe('echo [echo deploying to prod.example]');
  }, SLOW_TEST_MS);

  it('reads agree with runs: get, get --json, a subtree, a listing, find', () => {
    const want = 'echo deploying to prod.example';
    expect(rvr('get', '-G', 'cmd.deploy', '-p').stdout.trim()).toBe(want);
    expect(rvr('get', 'cmd.deploy', '-p').stdout.trim()).toBe(want);
    expect(json('get', 'cmd.deploy').result?.['cmd.deploy']).toBe(want);
    expect(json('get', 'cmd').result?.['cmd.deploy']).toBe(want);
    expect(rvr('get', 'cmd', '-v', '-p').stdout).toContain(`cmd.deploy: ${want}`);
    expect(rvr('get', 'cmd', '-t', '-v').stdout).toContain(want);
    expect(rvr('get', '-G', '-v', '-p').stdout).toContain(`cmd.deploy: ${want}`);
    expect((json('get', '-G').result ?? {})['cmd.deploy']).toBe(want);
    expect((json('find', 'deploying').result?.entries as Record<string, string>)['cmd.deploy']).toBe(want);
    expect(rvr('find', 'deploying', '-t').stdout).toContain('deploying to');
    expect(rvr('find', 'deploying', '-t').stdout).not.toContain(marker('value'));
    // A global entry's value never shows project content: in the global
    // section of a listing of both stores, and in a search.
    expect(rvr('get', '-A', '-v', '-p').stdout).toContain(`cmd.deploy: ${want}`);
    expect(rvr('find', 'deploying').stdout).not.toContain(marker('value'));
  }, SLOW_TEST_MS);

  it('the confirmation gate checks what runs: a flagged command reached only through the global store', () => {
    // The global chain reaches a flagged command; the project's entry of the
    // same name does not. The global one is what runs, so the gate fires.
    setGlobal('gate.mid', 'echo $(gate.flagged)');
    expect(rvrIn(outside, 'set', '-G', 'gate.flagged', touch('flagged'), '--confirm').status).toBe(0);
    setGlobal('gate.top', 'echo $(gate.mid)');
    shipEntry('gate.mid', 'echo harmless');
    const env = json('run', '-G', 'gate.top');
    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe('REQUIRES_CONFIRMATION');
    expect(ran('flagged')).toBe(false);
  }, SLOW_TEST_MS);

  describe('MCP', () => {
    let mcp: McpSession;
    beforeEach(async () => { mcp = await openMcpSession({ cwd: clone, env: { ...env(), RVR_PROJECT: clone } }); });
    afterEach(() => { mcp.close(); });

    it('reverie_run (scope global and default) and reverie_get resolve a global entry\'s references in the global store', async () => {
      for (const scope of ['global', undefined]) {
        const tag = await mcp.call('reverie_run', { key: 'cmd.tag', ...(scope ? { scope } : {}) });
        expect(tag.content[0].text, String(scope)).toContain('tag=1.0');
        const deploy = await mcp.call('reverie_run', { key: 'cmd.deploy', ...(scope ? { scope } : {}) });
        expect(deploy.content[0].text, String(scope)).toContain('deploying to prod.example');
        const got = await mcp.call('reverie_get', { key: 'cmd.deploy', ...(scope ? { scope } : {}) });
        expect(got.content[0].text, String(scope)).toContain('cmd.deploy: echo deploying to prod.example');
      }
      const subtree = await mcp.call('reverie_get', { key: 'cmd', values: true, scope: 'global' });
      expect(subtree.content[0].text).toContain('cmd.deploy: echo deploying to prod.example');
      // A global chain: the keys it lists are the global entries.
      setGlobal('cmd.both', 'cfg.ver cmd.tag');
      const chain = await mcp.call('reverie_run', { key: 'cmd.both', chain: true });
      expect(chain.isError).toBeUndefined();
      expect(chain.content[0].text).toContain('tag=1.0');
      expect(ran('exec')).toBe(false);
      expect(ran('value')).toBe(false);
    }, SLOW_TEST_MS);

    it('a confirm_token approves the global command as it runs: a project entry of the same name does not void it, a change to the global one does', async () => {
      expect(rvrIn(outside, 'confirm', 'set', '-G', 'cmd.tag').status).toBe(0);
      const ask = async () => {
        const res = await mcp.call('reverie_run', { key: 'cmd.tag', scope: 'global' });
        const token = /confirm_token: "([0-9a-f]+)"/.exec(res.content[0].text)?.[1];
        expect(token).toBeDefined();
        return token;
      };
      // The project's cfg.ver changes after the token: not what runs.
      let token = await ask();
      shipEntry('cfg.ver', `${touch('exec2')}; echo 10`);
      const ok = await mcp.call('reverie_run', { key: 'cmd.tag', scope: 'global', confirm_token: token });
      expect(ok.isError).toBeUndefined();
      expect(ok.content[0].text).toContain('tag=1.0');
      // The global cfg.ver changes after the token: what runs changed.
      token = await ask();
      setGlobal('cfg.ver', 'echo 2.0');
      const changed = await mcp.call('reverie_run', { key: 'cmd.tag', scope: 'global', confirm_token: token });
      expect(changed.isError).toBe(true);
      expect(changed.content[0].text).toContain('changed after that confirm_token was issued');
      expect(ran('exec')).toBe(false);
      expect(ran('exec2')).toBe(false);
    }, SLOW_TEST_MS);
  });
});
