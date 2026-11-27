// #260: each store's alias list changes only for the aliases that live in
// it; a command in one scope never writes the other store's alias map.
//
// In the default scope, a rename that re-pointed an alias, and MCP
// `reverie_remove` with `is_alias`, wrote the view that lays the project's
// aliases over the global ones into the project's `_aliases.json`: every
// global alias was copied into the project. The removal of a global-only
// alias reported success, and the alias still resolved from the global list.
// Owner decisions (2026-11-27):
//   1. A default-scope rename re-points only the project's aliases. A global
//      alias of the key is left alone (in another project it may mean that
//      project's entry), and the output says it still points at the old key.
//   2. A project list that already holds copies of global aliases is left as
//      it is: they are the project's aliases now.
//   3. A default-scope alias removal by name removes from the project only.
//      With a global alias of the name too, it says that one still
//      resolves; with only a global one, it refuses (NOT_FOUND, nothing
//      changed) and says to pass -G / scope "global".
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
  result?: Record<string, unknown>;
  error?: { code: string; message: string };
  warnings?: { code: string; message: string }[];
}

const SLOW_TEST_MS = 60_000;

describe('#260: an alias command changes only the aliases of the store it writes', () => {
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

  const projectAliasFile = () => path.join(project, '.reverie', '_aliases.json');
  const globalAliasFile = () => path.join(dataDir, 'store', '_aliases.json');
  const read = (f: string): Record<string, string> => JSON.parse(fs.readFileSync(f, 'utf8')) as Record<string, string>;
  const projectAliases = () => read(projectAliasFile());
  const globalAliases = () => read(globalAliasFile());
  const write = (f: string, m: Record<string, string>) => fs.writeFileSync(f, JSON.stringify(m, null, 2));

  /** Both alias files, byte for byte: what "nothing changed" means here. */
  const aliasFiles = () => [fs.readFileSync(projectAliasFile(), 'utf8'), fs.readFileSync(globalAliasFile(), 'utf8')];

  beforeAll(() => { assertDistHonorsDataDir(); });

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'reverie-alias-origin-'));
    dataDir = path.join(root, 'data');
    project = path.join(root, 'proj');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(project, { recursive: true });
    spawnSync('git', ['init', '-q', project]);
    expect(rvr('init', '--no-scan', '--no-claude', '--no-agents').status).toBe(0);
    expect(rvr('set', 'pk', 'project value').status).toBe(0);
    expect(rvr('set', '-G', 'gk', 'global value').status).toBe(0);
    // pa: project only; ga: global only; dup: in both; gp: a global alias of the project's key name.
    write(projectAliasFile(), { pa: 'pk', dup: 'pk' });
    write(globalAliasFile(), { ga: 'gk', dup: 'gk', gp: 'pk' });
  });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  describe('rule 1: a default-scope rename re-points the project\'s aliases only', () => {
    it('the issue\'s repro: no global alias is copied into the project', () => {
      write(projectAliasFile(), { pa: 'pk' });
      write(globalAliasFile(), { ga: 'gk' });
      expect(rvr('rename', 'pk', 'pk2').status).toBe(0);
      expect(projectAliases()).toEqual({ pa: 'pk2' });
      expect(globalAliases()).toEqual({ ga: 'gk' });
    }, SLOW_TEST_MS);

    it('CLI: the project\'s aliases move; a global alias of the key stays, and the output says so', () => {
      const env1 = json('rename', 'pk', 'pk2');
      expect(env1.ok).toBe(true);
      expect(projectAliases()).toEqual({ pa: 'pk2', dup: 'pk2' });
      expect(globalAliases()).toEqual({ ga: 'gk', dup: 'gk', gp: 'pk' });
      expect(env1.warnings?.map(w => w.message)).toEqual([expect.stringContaining("global alias 'gp' still points at 'pk'")]);
      // Text mode says it too.
      write(projectAliasFile(), { pa: 'pk2' });
      expect(rvr('rename', 'pk2', 'pk3').stdout).not.toContain('global alias');
      write(globalAliasFile(), { gp: 'pk3' });
      expect(rvr('rename', 'pk3', 'pk4').stdout).toContain("The global alias 'gp' still points at 'pk3'");
    }, SLOW_TEST_MS);

    it('CLI: one alias name in both stores pointing at the key: the project\'s moves, the global one stays and is named', () => {
      write(projectAliasFile(), { pa: 'pk' });
      write(globalAliasFile(), { pa: 'pk' });
      const env1 = json('rename', 'pk', 'pk2');
      expect(env1.ok).toBe(true);
      expect(projectAliases()).toEqual({ pa: 'pk2' });
      expect(globalAliases()).toEqual({ pa: 'pk' });
      expect(env1.warnings?.map(w => w.message)).toEqual([expect.stringContaining("The global alias 'pa' still points at 'pk'")]);
    }, SLOW_TEST_MS);

    it('CLI: a global entry renamed in the default scope is copied, and its global aliases are left alone', () => {
      write(projectAliasFile(), { pg: 'gk' });
      const env1 = json('rename', 'gk', 'gk2');
      expect(env1.ok).toBe(true);
      expect(projectAliases()).toEqual({ pg: 'gk2' });
      expect(globalAliases()).toEqual({ ga: 'gk', dup: 'gk', gp: 'pk' });
      // The global entry stays, and so does what its aliases name: the note says that, not "another project".
      expect(env1.warnings?.map(w => w.message).sort()).toEqual([
        "The global alias 'dup' still points at 'gk', which stays in the global store: a rename without a scope copies a global entry into the project and re-points only this project's aliases.",
        "The global alias 'ga' still points at 'gk', which stays in the global store: a rename without a scope copies a global entry into the project and re-points only this project's aliases.",
      ]);
    }, SLOW_TEST_MS);

    it('CLI -G: the global aliases move, the project\'s stay, nothing to say', () => {
      const env1 = json('rename', '-G', 'gk', 'gk2');
      expect(env1.ok).toBe(true);
      expect(globalAliases()).toEqual({ ga: 'gk2', dup: 'gk2', gp: 'pk' });
      expect(projectAliases()).toEqual({ pa: 'pk', dup: 'pk' });
      expect(env1.warnings ?? []).toEqual([]);
    }, SLOW_TEST_MS);

    it('rename --set-alias works on the project\'s list', () => {
      expect(json('rename', 'pk', 'pk2', '--set-alias', 'n').ok).toBe(true);
      expect(projectAliases()).toEqual({ pa: 'pk2', n: 'pk2' });
      expect(globalAliases()).toEqual({ ga: 'gk', dup: 'gk', gp: 'pk' });
    }, SLOW_TEST_MS);
  });

  describe('rule 2: copies a project list already holds are the project\'s aliases', () => {
    it('are left in place by a rename, and removed by a removal that names them', () => {
      write(projectAliasFile(), { pa: 'pk', ga: 'gk' });   // ga: a copy #260 made
      expect(json('rename', 'pk', 'pk2').ok).toBe(true);
      expect(projectAliases()).toEqual({ pa: 'pk2', ga: 'gk' });
      const env1 = json('alias', 'remove', 'ga');
      expect(env1.ok).toBe(true);
      expect(projectAliases()).toEqual({ pa: 'pk2' });
      expect(globalAliases()).toEqual({ ga: 'gk', dup: 'gk', gp: 'pk' });
      expect(env1.warnings?.map(w => w.message)).toEqual([expect.stringContaining("A global alias 'ga' (-> gk) still resolves here")]);
    }, SLOW_TEST_MS);
  });

  describe('rule 3: a default-scope removal by name removes the project\'s alias only', () => {
    for (const argv of [['alias', 'remove'], ['remove', '-a']]) {
      const cmd = argv.join(' ');
      it(`CLI ${cmd}: project only, both, global only, -G`, () => {
        // Project only: removed, nothing to say.
        let env1 = json(...argv, 'pa');
        expect(env1.ok).toBe(true);
        expect(env1.warnings ?? []).toEqual([]);
        expect(projectAliases()).toEqual({ dup: 'pk' });
        // Both: the project's goes; the global one still resolves, and the output says so.
        env1 = json(...argv, 'dup');
        expect(env1.ok).toBe(true);
        expect(projectAliases()).toEqual({});
        expect(globalAliases()).toEqual({ ga: 'gk', dup: 'gk', gp: 'pk' });
        expect(env1.warnings?.map(w => w.message)).toEqual([expect.stringContaining("A global alias 'dup' (-> gk) still resolves here. To remove it too, pass -G.")]);
        // Global only: refused, nothing changed, and it says how.
        const before = aliasFiles();
        env1 = json(...argv, 'ga');
        expect(env1.ok).toBe(false);
        expect(env1.error?.code).toBe('NOT_FOUND');
        expect(env1.error?.message).toContain("Alias 'ga' is a global alias (-> gk), not one of this project's, so nothing was removed. To remove it, pass -G.");
        expect(aliasFiles()).toEqual(before);
        // Nowhere: not found, as before.
        expect(json(...argv, 'nope').error?.message).toBe("Alias 'nope' not found.");
        // -G removes the global one.
        expect(json(...argv, 'ga', '-G').ok).toBe(true);
        expect(globalAliases()).toEqual({ dup: 'gk', gp: 'pk' });
      }, SLOW_TEST_MS);

      it(`CLI ${cmd} -G: the global list only — a project-only name is not found, a name in both keeps the project's`, () => {
        let env1 = json(...argv, 'pa', '-G');
        expect(env1.error?.code).toBe('NOT_FOUND');
        expect(env1.error?.message).toBe("Alias 'pa' not found.");
        expect(projectAliases()).toEqual({ pa: 'pk', dup: 'pk' });
        env1 = json(...argv, 'dup', '-G');
        expect(env1.ok).toBe(true);
        expect(env1.warnings ?? []).toEqual([]);
        expect(globalAliases()).toEqual({ ga: 'gk', gp: 'pk' });
        expect(projectAliases()).toEqual({ pa: 'pk', dup: 'pk' });
      }, SLOW_TEST_MS);
    }
  });

  describe('MCP', () => {
    let mcp: McpSession;
    beforeEach(async () => { mcp = await openMcpSession({ cwd: project, env: { ...env(), RVR_PROJECT: project } }); });
    afterEach(() => { mcp.close(); });

    it('rule 1: reverie_rename without a scope re-points the project\'s aliases and names the global one it left', async () => {
      const res = await mcp.call('reverie_rename', { oldKey: 'pk', newKey: 'pk2' });
      expect(res.isError).toBeUndefined();
      expect(res.content[0].text).toBe("Renamed: pk -> pk2\nnote: The global alias 'gp' still points at 'pk': a rename without a scope re-points only this project's aliases (in another project 'pk' may be that project's own entry).");
      expect(projectAliases()).toEqual({ pa: 'pk2', dup: 'pk2' });
      expect(globalAliases()).toEqual({ ga: 'gk', dup: 'gk', gp: 'pk' });
      // scope "global": the global list only, nothing to say.
      const g = await mcp.call('reverie_rename', { oldKey: 'gk', newKey: 'gk2', scope: 'global' });
      expect(g.content[0].text).toBe('Renamed: gk -> gk2');
      expect(globalAliases()).toEqual({ ga: 'gk2', dup: 'gk2', gp: 'pk' });
      expect(projectAliases()).toEqual({ pa: 'pk2', dup: 'pk2' });
    }, SLOW_TEST_MS);

    for (const [tool, nameArg, extra] of [['reverie_remove', 'key', { is_alias: true }], ['reverie_alias_remove', 'alias', {}]] as const) {
      it(`rule 3: ${tool} without a scope: project only, both, global only, scope "global"`, async () => {
        const call = (name: string, more: Record<string, unknown> = {}) => mcp.call(tool, { [nameArg]: name, ...extra, ...more });
        let res = await call('pa');
        expect(res.isError).toBeUndefined();
        expect(res.content[0].text).toBe('Alias removed: pa');
        expect(projectAliases()).toEqual({ dup: 'pk' });
        res = await call('dup');
        expect(res.isError).toBeUndefined();
        expect(res.content[0].text).toBe('Alias removed: dup\nnote: A global alias \'dup\' (-> gk) still resolves here. To remove it too, pass scope: "global".');
        expect(projectAliases()).toEqual({});
        expect(globalAliases()).toEqual({ ga: 'gk', dup: 'gk', gp: 'pk' });
        const before = aliasFiles();
        res = await call('ga');
        expect(res.isError).toBe(true);
        expect(res.content[0].text).toBe('Alias \'ga\' is a global alias (-> gk), not one of this project\'s, so nothing was removed. To remove it, pass scope: "global".');
        expect(aliasFiles()).toEqual(before);
        res = await call('nope');
        expect(res.content[0].text).toBe("Alias 'nope' not found.");
        res = await call('ga', { scope: 'global' });
        expect(res.isError).toBeUndefined();
        expect(globalAliases()).toEqual({ dup: 'gk', gp: 'pk' });
      }, SLOW_TEST_MS);

      it(`${tool} with scope "global": the global list only`, async () => {
        const call = (name: string) => mcp.call(tool, { [nameArg]: name, ...extra, scope: 'global' });
        let res = await call('pa');
        expect(res.isError).toBe(true);
        expect(res.content[0].text).toBe("Alias 'pa' not found.");
        res = await call('dup');
        expect(res.content[0].text).toBe('Alias removed: dup');
        expect(globalAliases()).toEqual({ ga: 'gk', gp: 'pk' });
        expect(projectAliases()).toEqual({ pa: 'pk', dup: 'pk' });
      }, SLOW_TEST_MS);
    }
  });
});
