// #279: the global target of a name gates a run wherever the name is looked up.
//
// One name, `dup`, in both alias maps: the project's points at a plain
// entry, the global one at a flagged entry. A project alias must not take
// the name away from the user's own global alias to a flagged command, so
// every lookup that reads the project's aliases also gates the key the
// global map alone gives the name. Every way of reaching `dup` here must ask:
// typed, in an a:b segment, in a ${…}, a $(…) and a :- default, as a chain
// member, and `cc` as a chain entry — on the CLI and over MCP, with scope
// omitted and "project". Each position was once dropped by a mutant that
// every other test passed (the review of the resolver, 2026-11-27).
//
// Spawns the built dist (assumes `bun run build` has run) against a temp
// global store and a temp git project.

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { assertDistHonorsDataDir } from './helpers/spawnGuard';
import { openMcpSession, type McpSession } from './helpers/mcpSession';

interface Envelope {
  ok: boolean;
  error?: { code: string; message: string };
}

const SLOW_TEST_MS = 60_000;

describe('#279: the global target of a name gates the run in every lookup position', () => {
  const cli = path.resolve('dist/index.js');
  let root: string;
  let dataDir: string;
  let project: string;

  const env = (): NodeJS.ProcessEnv => {
    const e: Record<string, string | undefined> = { ...process.env, RVR_DATA_DIR: dataDir, RVR_AGENT_NAME: 'test' };
    for (const k of ['RVR_SESSION', 'RVR_NO_PROJECT', 'RVR_PROJECT', 'RVR_OUTPUT', 'VISUAL']) delete e[k];
    return e as NodeJS.ProcessEnv;
  };
  const rvr = (...args: string[]) => {
    const r = spawnSync('bun', [cli, ...args], { cwd: project, env: env(), input: '' });
    return { stdout: r.stdout.toString(), stderr: r.stderr.toString(), status: r.status };
  };

  beforeAll(() => { assertDistHonorsDataDir(); });

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'reverie-gate-target-'));
    dataDir = path.join(root, 'data');
    project = path.join(root, 'proj');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(project, { recursive: true });
    spawnSync('git', ['init', '-q', project]);
    expect(rvr('init', '--no-scan', '--no-claude', '--no-agents').status).toBe(0);
    for (const [k, v] of [
      ['p.only', 'echo P-ONLY'],
      ['p.dupref', 'echo DR ${dup}'],
      ['p.duprefx', 'echo DX $(dup)'],
      ['p.dupdefault', 'echo DD ${nope:-${dup}}'],
      ['p.dupchain', 'dup'],
      ['p.plainchain', 'p.only'],
    ]) expect(rvr('set', k, v).status).toBe(0);
    expect(rvr('set', '-G', 'g.flag', 'echo G-FLAG').status).toBe(0);
    expect(rvr('confirm', 'set', '-G', 'g.flag').status).toBe(0);
    // Written as a repository and a user would have them: one alias per
    // entry would not let `alias set` put both global names on g.flag.
    fs.writeFileSync(path.join(project, '.reverie', '_aliases.json'), JSON.stringify({ dup: 'p.only', cc: 'p.plainchain' }));
    fs.writeFileSync(path.join(dataDir, 'store', '_aliases.json'), JSON.stringify({ dup: 'g.flag', cc: 'g.flag' }));
  });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  const CLI_RUNS: [string, string[]][] = [
    ['typed', ['dup']],
    ['${…}', ['p.dupref']],
    ['$(…)', ['p.duprefx']],
    [':- default', ['p.dupdefault']],
    ['a chain member', ['--chain', 'p.dupchain']],
    ['an a:b segment, first', ['dup:p.only']],
    ['an a:b segment, second', ['p.only:dup']],
    ['a chain entry', ['--chain', 'cc']],
  ];
  for (const [where, argv] of CLI_RUNS) {
    it(`CLI: ${where} (rvr run ${argv.join(' ')}) asks`, () => {
      const r = rvr('--json', 'run', ...argv);
      const env1 = JSON.parse(r.stdout) as Envelope;
      expect(env1.ok).toBe(false);
      expect(env1.error?.code).toBe('REQUIRES_CONFIRMATION');
    }, SLOW_TEST_MS);
  }

  describe('MCP', () => {
    let mcp: McpSession;
    beforeEach(async () => { mcp = await openMcpSession({ cwd: project, env: { ...env(), RVR_PROJECT: project } }); });
    afterEach(() => { mcp.close(); });

    const MCP_RUNS: [string, Record<string, unknown>][] = [
      ['typed', { key: 'dup' }],
      ['${…}', { key: 'p.dupref' }],
      ['$(…)', { key: 'p.duprefx' }],
      [':- default', { key: 'p.dupdefault' }],
      ['a chain member', { key: 'p.dupchain', chain: true }],
      ['a chain entry', { key: 'cc', chain: true }],
    ];
    for (const scope of [undefined, 'project'] as const) {
      it(`every position asks, scope ${scope ?? 'omitted'}`, async () => {
        for (const [where, args] of MCP_RUNS) {
          const res = await mcp.call('reverie_run', { ...args, ...(scope ? { scope } : {}) });
          expect(res.content[0].text, `${where} ${JSON.stringify(args)}`).toContain('requires confirmation before execution');
        }
      }, SLOW_TEST_MS);
    }
  });
});
