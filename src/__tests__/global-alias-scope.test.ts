// #284: with -G, a name resolves through the global alias map only.
//
// The CLI resolved a name typed with -G through the default view, which
// layers the project's aliases over the global ones. A cloned repository
// controls its `.reverie/_aliases.json`, so `{"notes": "commands.deploy"}`
// made `set -G notes` overwrite the user's global `commands.deploy`, `rm -G
// notes` delete it, `rename -G notes …` move it, `copy -G notes …` read it,
// and `confirm remove -G notes` clear its flag. `run -G` already read the
// global map alone; now every command does, and so does every MCP tool
// called with scope "global" (which already did).
//
// In the default scope a project alias still applies, as a lookup by key
// does, but a write there lands in the project store (a rename copies a
// global entry into it), so it cannot reach a global entry: asserted below.
//
// Spawns the built dist (assumes `bun run build` has run) against a temp
// global store and a temp git project whose alias file is written by hand.

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

describe('#284: -G resolves a name through the global aliases only', () => {
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
  const json = (...args: string[]): Envelope => JSON.parse(rvr('--json', ...args).stdout) as Envelope;

  const globalFile = (key: string) => path.join(dataDir, 'store', `${key}.json`);
  const projectFile = (key: string) => path.join(project, '.reverie', `${key}.json`);
  const valueIn = (file: string): string | undefined =>
    fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')) as { value: string }).value : undefined;
  const globalDeploy = () => valueIn(globalFile('commands.deploy'));
  const globalFlags = (): Record<string, unknown> => {
    const f = path.join(dataDir, 'store', '_confirm.json');
    return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) as Record<string, unknown> : {};
  };

  beforeAll(() => { assertDistHonorsDataDir(); });

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'reverie-g-alias-'));
    dataDir = path.join(root, 'data');
    project = path.join(root, 'proj');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(project, { recursive: true });
    spawnSync('git', ['init', '-q', project]);
    expect(rvr('init', '--no-scan', '--no-claude', '--no-agents').status).toBe(0);
    // The user's own flagged global command.
    expect(rvr('set', '-G', 'commands.deploy', 'real deploy').status).toBe(0);
    expect(rvr('confirm', 'set', '-G', 'commands.deploy').status).toBe(0);
    // The repository's alias over it, written as the repository ships it.
    fs.writeFileSync(path.join(project, '.reverie', '_aliases.json'), JSON.stringify({ notes: 'commands.deploy' }));
  });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  it('set -G writes the name typed, not the global entry the project alias names', () => {
    expect(rvr('set', '-G', 'notes', 'my note').status).toBe(0);
    expect(globalDeploy()).toBe('real deploy');
    expect(valueIn(globalFile('notes'))).toBe('my note');
  }, SLOW_TEST_MS);

  it('a batch set -G writes the name typed', () => {
    expect(rvr('set', '-G', 'notes=batch note').status).toBe(0);
    expect(globalDeploy()).toBe('real deploy');
    expect(valueIn(globalFile('notes'))).toBe('batch note');
  }, SLOW_TEST_MS);

  // One test per command: each is a call site of its own.
  const notFound: [string, string[]][] = [
    ['rm -G (no TTY, no --force)', ['rm', '-G', 'notes']],
    ['rm -G --force', ['rm', '-G', 'notes', '--force']],
    ['rename -G', ['rename', '-G', 'notes', 'misc.moved']],
    ['copy -G', ['copy', '-G', 'notes', 'misc.copy']],
    ['get -G', ['get', '-G', 'notes']],
    ['edit -G', ['edit', '-G', 'notes']],
  ];
  for (const [label, args] of notFound) {
    it(`${label}: the name is not found, and the global entry is untouched`, () => {
      const editor = path.join(root, 'editor.sh');
      fs.writeFileSync(editor, '#!/bin/sh\necho edited > "$1"\n', { mode: 0o755 });
      const r = spawnSync('bun', [cli, ...args], { cwd: project, env: { ...env(), EDITOR: editor }, input: '' });
      // rm of a name that names nothing warns and exits 0, as it always has;
      // the others fail with "not found".
      expect(r.stdout.toString() + r.stderr.toString()).toContain("'notes' not found");
      expect(globalDeploy()).toBe('real deploy');
      expect(fs.existsSync(globalFile('misc.moved'))).toBe(false);
      expect(fs.existsSync(globalFile('misc.copy'))).toBe(false);
    }, SLOW_TEST_MS);
  }

  it('confirm remove -G does not clear the global entry\'s flag; confirm set -G names nothing', () => {
    const removed = json('confirm', 'remove', '-G', 'notes');
    expect(removed.result?.key).toBe('notes');
    expect(globalFlags()).toEqual({ 'commands.deploy': true });
    expect(json('run', '-G', 'commands.deploy').error?.code).toBe('REQUIRES_CONFIRMATION');
    expect(json('confirm', 'set', '-G', 'notes').error?.code).toBe('NOT_FOUND');
    expect(globalFlags()).toEqual({ 'commands.deploy': true });
  }, SLOW_TEST_MS);

  it('a global alias still resolves under -G', () => {
    expect(rvr('alias', 'set', '-G', 'dp', 'commands.deploy').status).toBe(0);
    expect(json('get', '-G', 'dp').result?.['commands.deploy']).toBe('real deploy');
    expect(rvr('set', '-G', 'dp', 'via global alias').status).toBe(0);
    expect(globalDeploy()).toBe('via global alias');
  }, SLOW_TEST_MS);

  it('the default scope: a project alias applies, but a write cannot reach the global entry', () => {
    // Each step starts from the repository's alias: a rename re-points it,
    // and a removal takes the aliases of what it removes.
    const shipAlias = () => {
      fs.writeFileSync(path.join(project, '.reverie', '_aliases.json'), JSON.stringify({ notes: 'commands.deploy' }));
    };
    // A rename in the default scope copies a global source into the project.
    shipAlias();
    expect(rvr('rename', 'notes', 'misc.moved').status).toBe(0);
    expect(valueIn(projectFile('misc.moved'))).toBe('real deploy');
    // A flag removal clears the project's list only: the global flag stays, and says so.
    shipAlias();
    expect(rvr('confirm', 'remove', 'notes').status).toBe(1);
    // A write lands in the project store.
    shipAlias();
    expect(rvr('set', 'notes', 'project value').status).toBe(0);
    expect(valueIn(projectFile('commands.deploy'))).toBe('project value');
    shipAlias();
    expect(rvr('rm', 'notes', '--force').status).toBe(0);
    expect(fs.existsSync(projectFile('commands.deploy'))).toBe(false);
    // With no project entry left, the removal does not fall through to the global one.
    shipAlias();
    expect(json('rm', 'notes', '--force').error?.code).toBe('NOT_FOUND');
    expect(globalDeploy()).toBe('real deploy');
    expect(globalFlags()).toEqual({ 'commands.deploy': true });
  }, SLOW_TEST_MS);

  describe('MCP', () => {
    let mcp: McpSession;
    beforeEach(async () => { mcp = await openMcpSession({ cwd: project, env: { ...env(), RVR_PROJECT: project } }); });
    afterEach(() => { mcp.close(); });

    it('scope "global" (and "project") never act on the global entry a project alias names', async () => {
      const set = await mcp.call('reverie_set', { key: 'notes', value: 'my note', scope: 'global' });
      expect(set.isError).toBeUndefined();
      expect(valueIn(globalFile('notes'))).toBe('my note');
      fs.rmSync(globalFile('notes'));
      for (const [tool, args] of [
        ['reverie_get', { key: 'notes', scope: 'global' }],
        ['reverie_remove', { key: 'notes', scope: 'global' }],
        ['reverie_rename', { oldKey: 'notes', newKey: 'misc.moved', scope: 'global' }],
        ['reverie_copy', { source: 'notes', dest: 'misc.copy', scope: 'global' }],
        ['reverie_remove', { key: 'notes', scope: 'project' }],
      ] as const) {
        const res = await mcp.call(tool, args);
        expect(res.isError, `${tool} ${JSON.stringify(args)}`).toBe(true);
        expect(res.content[0].text, `${tool} ${JSON.stringify(args)}`).toContain('not found');
      }
      expect(globalDeploy()).toBe('real deploy');
      expect(fs.existsSync(globalFile('misc.moved'))).toBe(false);
      expect(fs.existsSync(globalFile('misc.copy'))).toBe(false);
      expect(globalFlags()).toEqual({ 'commands.deploy': true });
    }, SLOW_TEST_MS);
  });
});
