// #289: the gate never knows less than the run executes.
//
// Before a run executes anything, a collect pass walks every `${key}` and
// `$(key)` it reaches so the gate can ask about flagged commands. It walked a
// `$(key)` each time it met one, where the exec pass runs it once and takes
// later uses from its cache. A deep composite command therefore made collect
// hit the depth limit on a second walk of a `$(x)` and stop — the gate then
// checked only what it had seen — while exec got a cache hit, carried on, and
// ran a flagged `$(fl)` further along. Now:
//
//   (b) collect walks as exec runs: in order, one exec cache per run (per
//       chain member over MCP), so a `$(key)` already walked is not walked
//       again;
//   (a) a walk that stops on an error after passing a command exec would run
//       gates the run, saying not every reference could be checked. One that
//       stops before any command keeps its own error: exec stops there too,
//       with nothing run.
//
// Spawns the built dist (assumes `bun run build` has run). The stores are
// temp directories whose entry files are written directly.

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
const UNCHECKED = 'not every reference it reaches could be checked';

/** The issue's chain: `${s}` runs `$(x)`; `${d1}` reaches `$(x)` again eight levels down; then `$(fl)`. */
const chain = (): Record<string, string> => ({
  top: 'echo ${s} ${d1} $(fl)',
  s: '$(x)',
  x: 'echo X ${y1}',
  y1: '${y2}', y2: '${y3}', y3: '${y4}', y4: '${y5}', y5: 'w',
  d1: '${d2}', d2: '${d3}', d3: '${d4}', d4: '${d5}', d5: '${d6}', d6: '${d7}', d7: '${d8}', d8: '$(x)',
});

/**
 * The same shape split over the segments of one run: `pre` runs `$(x)`, and
 * `tail` reaches it again before `$(fl)`. `all` lists both for --chain.
 */
const segments = (): Record<string, string> => {
  const entries = chain();
  delete entries.top;
  return { ...entries, pre: 'echo $(x)', tail: 'echo ${d1} $(fl)', all: 'pre tail' };
};

describe('#289: the reference walk follows the run', () => {
  const cli = path.resolve('dist/index.js');
  let root: string;
  let dataDir: string;
  let project: string;

  const env = (): NodeJS.ProcessEnv => {
    const e: Record<string, string | undefined> = { ...process.env, RVR_DATA_DIR: dataDir, RVR_AGENT_NAME: 'test' };
    for (const k of ['RVR_SESSION', 'RVR_NO_PROJECT', 'RVR_PROJECT', 'RVR_OUTPUT']) delete e[k];
    return e as NodeJS.ProcessEnv;
  };
  const rvr = (...args: string[]) => {
    const r = spawnSync('bun', [cli, ...args], { cwd: project, env: env(), input: '' });
    return { stdout: r.stdout.toString(), stderr: r.stderr.toString(), status: r.status };
  };
  const json = (...args: string[]): Envelope => JSON.parse(rvr('--json', ...args).stdout) as Envelope;

  const globalStore = () => path.join(dataDir, 'store');
  const projectStore = () => path.join(project, '.reverie');
  const write = (dir: string, entries: Record<string, string>) => {
    for (const [k, v] of Object.entries(entries)) fs.writeFileSync(path.join(dir, `${k}.json`), JSON.stringify({ value: v }));
  };
  const flag = (dir: string, ...keys: string[]) => {
    fs.writeFileSync(path.join(dir, '_confirm.json'), JSON.stringify(Object.fromEntries(keys.map(k => [k, true]))));
  };
  const marker = (name: string) => path.join(root, `ran-${name}`);
  const touch = (name: string) => `touch ${marker(name)}`;
  const ran = (name: string) => fs.existsSync(marker(name));

  beforeAll(() => { assertDistHonorsDataDir(); });

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'reverie-ref-walk-'));
    dataDir = path.join(root, 'data');
    project = path.join(root, 'proj');
    fs.mkdirSync(globalStore(), { recursive: true });
    fs.mkdirSync(projectStore(), { recursive: true });
    spawnSync('git', ['init', '-q', project]);
    // The user's flagged global command, as in the issue.
    write(globalStore(), { fl: `${touch('flagged')}; echo F` });
    flag(globalStore(), 'fl');
  });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  describe('the issue\'s chains', () => {
    it('all in the project: run is refused for confirmation; the flagged command does not run', () => {
      write(projectStore(), chain());
      const env = json('run', 'top');
      expect(env.ok).toBe(false);
      expect(env.error?.code).toBe('REQUIRES_CONFIRMATION');
      const text = rvr('run', 'top');
      expect(text.status).toBe(1);
      expect(text.stderr).toContain('Entry requires confirmation');
      expect(ran('flagged')).toBe(false);
    }, SLOW_TEST_MS);

    it('in the global store, with a project d1 (the #280 case): run -G is refused', () => {
      write(globalStore(), chain());
      write(projectStore(), { d1: 'w' });
      expect(json('run', '-G', 'top').error?.code).toBe('REQUIRES_CONFIRMATION');
      expect(ran('flagged')).toBe(false);
    }, SLOW_TEST_MS);

    it('across a:b segments and a --chain, where exec shares one cache for the run', () => {
      write(projectStore(), segments());
      expect(json('run', 'pre:tail').error?.code).toBe('REQUIRES_CONFIRMATION');
      expect(json('run', 'pre', 'tail').error?.code).toBe('REQUIRES_CONFIRMATION');
      expect(json('run', '--chain', 'all').error?.code).toBe('REQUIRES_CONFIRMATION');
      expect(ran('flagged')).toBe(false);
    }, SLOW_TEST_MS);

    it('with nothing flagged, the deep run still runs without asking', () => {
      flag(globalStore());
      write(projectStore(), chain());
      const env = json('run', 'top');
      expect(env.ok).toBe(true);
      expect(env.result?.stdout).toBe('X w X w F\n');
      expect(ran('flagged')).toBe(true);
    }, SLOW_TEST_MS);

    it('with nothing flagged, the deep run split over segments and a --chain runs without asking', () => {
      // 1.3.0 failed these with "depth limit exceeded": it interpolated the
      // joined segments in one pass, every ${…} before any $(…). Each
      // segment now runs in turn (#280), so `tail` finds $(x) already run.
      flag(globalStore());
      write(projectStore(), segments());
      for (const args of [['pre:tail'], ['pre', 'tail'], ['--chain', 'all']]) {
        const run = json('run', ...args);
        expect(run.ok, args.join(' ')).toBe(true);
        expect(run.result?.stdout, args.join(' ')).toContain('X w F');
      }
    }, SLOW_TEST_MS);
  });

  describe('a walk that stops on an error', () => {
    // e1 … e12: too deep to resolve from inside a $(…).
    const tooDeep = (): Record<string, string> => {
      const out: Record<string, string> = {};
      for (let i = 1; i < 12; i++) out[`e${i}`] = `\${e${i + 1}}`;
      out.e12 = 'w';
      return out;
    };

    it('past a command the run would execute: refused, saying so; nothing runs', () => {
      // ${p} runs $(a) first; then $(q) cannot be walked to the end.
      write(projectStore(), { ...tooDeep(), top: 'echo ${p} $(q)', p: '$(a)', a: `${touch('a')}; echo a`, q: 'echo ${e1}' });
      const env = json('run', 'top');
      expect(env.error?.code).toBe('REQUIRES_CONFIRMATION');
      expect(env.error?.message).toContain(UNCHECKED);
      expect(env.error?.message).toContain('depth limit');
      expect(rvr('run', 'top').stderr).toContain(UNCHECKED);
      expect(ran('a')).toBe(false);
      // --yes runs it, and the run fails with its own error.
      const yes = rvr('run', 'top', '--yes');
      expect(yes.status).toBe(1);
      expect(yes.stderr).toContain('depth limit');
    }, SLOW_TEST_MS);

    it('before any command: the run fails with its own error, not a confirmation refusal', () => {
      write(projectStore(), {
        missing: 'echo $(q)', q: 'echo ${nope}',
        required: 'echo $(r)', r: 'echo ${need:?need must be set}',
        cycle: '$(c1)', c1: '$(c2)', c2: '$(c1)',
      });
      const cases: [string, string][] = [['missing', '"nope" not found'], ['required', 'need must be set'], ['cycle', 'Circular interpolation']];
      for (const [key, error] of cases) {
        const env = json('run', key);
        expect(env.ok, key).toBe(false);
        expect(env.error?.code, key).not.toBe('REQUIRES_CONFIRMATION');
        expect(env.error?.message, key).toContain(error);
      }
    }, SLOW_TEST_MS);
  });

  describe('MCP reverie_run', () => {
    let mcp: McpSession | undefined;
    const open = async () => {
      mcp = await openMcpSession({ cwd: project, env: { ...env(), RVR_PROJECT: project } });
      return mcp;
    };
    afterEach(() => { mcp?.close(); mcp = undefined; });

    it('asks for a confirm_token for the project chain; nothing runs', async () => {
      write(projectStore(), chain());
      const session = await open();
      for (const args of [{ key: 'top' }, { key: 'top', scope: 'project' }]) {
        const res = await session.call('reverie_run', args);
        expect(res.content[0].text, JSON.stringify(args)).toContain('confirm_token');
      }
      expect(ran('flagged')).toBe(false);
    }, SLOW_TEST_MS);

    it('asks for a confirm_token for the global chain with a project d1, and for chain:true; nothing runs', async () => {
      write(globalStore(), { ...chain(), ...segments() });
      write(projectStore(), { d1: 'w' });
      const session = await open();
      const res = await session.call('reverie_run', { key: 'top', scope: 'global' });
      expect(res.content[0].text).toContain('confirm_token');
      // chain:true runs each member with its own exec cache: `tail` walks
      // $(x) again, and exec does too and stops there. The gate cannot see
      // past it, and says so.
      const chained = await session.call('reverie_run', { key: 'all', chain: true, scope: 'global' });
      expect(chained.content[0].text).toContain('confirm_token');
      expect(chained.content[0].text).toContain('Not every reference it reaches could be checked');
      expect(ran('flagged')).toBe(false);
    }, SLOW_TEST_MS);

    it('with nothing flagged, the deep run runs without a token', async () => {
      flag(globalStore());
      write(projectStore(), chain());
      const session = await open();
      const res = await session.call('reverie_run', { key: 'top' });
      expect(res.isError).toBeUndefined();
      expect(res.content[0].text).toContain('X w X w F');
      expect(ran('flagged')).toBe(true);
    }, SLOW_TEST_MS);

    it('a walk that stops past a command: the preview says what could not be checked', async () => {
      const deep: Record<string, string> = {};
      for (let i = 1; i < 12; i++) deep[`e${i}`] = `\${e${i + 1}}`;
      deep.e12 = 'w';
      write(projectStore(), { ...deep, top: 'echo ${p} $(q)', p: '$(a)', a: `${touch('a')}; echo a`, q: 'echo ${e1}' });
      const session = await open();
      const res = await session.call('reverie_run', { key: 'top' });
      expect(res.content[0].text).toContain('confirm_token');
      expect(res.content[0].text).toContain('Not every reference it reaches could be checked');
      expect(ran('a')).toBe(false);
    }, SLOW_TEST_MS);
  });
});
