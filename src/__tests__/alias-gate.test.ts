// #279: an alias does not take a run past a confirmation flag.
//
// resolveKey looks a name up in the alias map before it looks for an entry,
// and the run gate checked only the key an alias points to. Two ways in:
//
//   1. A cloned repository. Its committed `.reverie/_aliases.json` is layered
//      over the user's global aliases, so `{"cmd.danger": "evil.cmd"}` made
//      the user's globally flagged `cmd.danger` run the repo's command,
//      unasked — typed to `run`, listed by a chain, or written as a reference
//      in another command. The gate now checks every lookup under the name as
//      written as well as the key its alias names (and, where project aliases
//      are read, the key the global map gives it).
//   2. A merge import (or `alias set`) adding an alias named after an existing
//      entry. Every write that adds an alias now refuses a name that is an
//      entry's key, in either store, as INVALID_INPUT.
//
// Spawns the built dist (assumes `bun run build` has run): the global store
// is a temp RVR_DATA_DIR, the "cloned repo" a temp git directory whose
// `.reverie/` files are written by hand, as an attacker would commit them.
// stdin is an empty pipe, so a gated run refuses instead of prompting, and a
// run that gets past the gate leaves its marker file.

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

describe('#279: an alias over a flagged name does not skip the confirmation gate', () => {
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
  const jsonIn = (cwd: string, ...args: string[]): Envelope => JSON.parse(rvrIn(cwd, '--json', ...args).stdout) as Envelope;

  const marker = (name: string) => path.join(root, `ran-${name}`);
  const touch = (name: string) => `touch ${marker(name)}`;
  const ran = (name: string) => fs.existsSync(marker(name));

  /** Commit a file to the clone's store by hand, as the repository ships it. */
  const ship = (file: string, content: unknown) => {
    fs.writeFileSync(path.join(clone, '.reverie', file), JSON.stringify(content));
  };
  const shipEntry = (key: string, value: string) => { ship(`${key}.json`, { value }); };
  const aliasFile = (storeDir: string) => path.join(storeDir, '_aliases.json');
  const readAliases = (storeDir: string): Record<string, string> =>
    fs.existsSync(aliasFile(storeDir)) ? JSON.parse(fs.readFileSync(aliasFile(storeDir), 'utf8')) as Record<string, string> : {};
  const globalStore = () => path.join(dataDir, 'store');
  const projectStore = () => path.join(clone, '.reverie');

  beforeAll(() => { assertDistHonorsDataDir(); });

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'reverie-alias-gate-'));
    dataDir = path.join(root, 'data');
    clone = path.join(root, 'clone');
    outside = path.join(root, 'outside');
    for (const d of [dataDir, path.join(clone, '.reverie'), outside]) fs.mkdirSync(d, { recursive: true });
    spawnSync('git', ['init', '-q', clone]);
    // The user's own global store: a flagged command.
    expect(rvrIn(outside, 'set', '-G', 'cmd.danger', touch('danger'), '--confirm').status).toBe(0);
  });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  // ── 1. a cloned repository's aliases ─────────────────────────────────

  describe('a project alias over the flagged name', () => {
    beforeEach(() => {
      ship('_aliases.json', { 'cmd.danger': 'evil.cmd' });
      shipEntry('evil.cmd', `${touch('evil')}; echo ok`);
    });

    it('run <name>: refused for confirmation, in text and JSON mode; the repo command does not run', () => {
      const text = rvr('run', 'cmd.danger');
      expect(text.status).toBe(1);
      expect(text.stderr).toContain('Entry requires confirmation');
      const env = json('run', 'cmd.danger');
      expect(env.ok).toBe(false);
      expect(env.error?.code).toBe('REQUIRES_CONFIRMATION');
      expect(ran('evil')).toBe(false);
      // The flag is still listed, as it always was: the gate now reads it.
      expect((json('confirm', 'list').result as { confirmKeys: string[] }).confirmKeys).toContain('cmd.danger');
      // --yes is the opt-in: then it runs (what the alias names).
      expect(rvr('run', 'cmd.danger', '--yes').status).toBe(0);
      expect(ran('evil')).toBe(true);
      expect(ran('danger')).toBe(false);
    }, SLOW_TEST_MS);

    it('a reference to the name in a project command — $(name) and ${name} — is gated', () => {
      // Project entries: their references read the project, then the global
      // store (#280), so the project alias applies — and the gate must see
      // the name as written.
      shipEntry('cmd.wrapexec', 'echo v=$(cmd.danger)');
      shipEntry('cmd.wrapvalue', 'sh -c "${cmd.danger}"');
      for (const key of ['cmd.wrapexec', 'cmd.wrapvalue']) {
        const env = json('run', key);
        expect(env.ok, key).toBe(false);
        expect(env.error?.code, key).toBe('REQUIRES_CONFIRMATION');
      }
      expect(ran('evil')).toBe(false);
    }, SLOW_TEST_MS);

    it('a reference in the user\'s own global command is gated (the audit\'s cmd.wrapx)', () => {
      expect(rvrIn(outside, 'set', '-G', 'cmd.wrapx', 'echo v=$(cmd.danger)').status).toBe(0);
      expect(jsonIn(outside, 'run', '-G', 'cmd.wrapx').error?.code).toBe('REQUIRES_CONFIRMATION');
      for (const args of [['run', '-G', 'cmd.wrapx'], ['run', 'cmd.wrapx']]) {
        const env = json(...args);
        expect(env.ok, args.join(' ')).toBe(false);
        expect(env.error?.code, args.join(' ')).toBe('REQUIRES_CONFIRMATION');
      }
      expect(ran('evil')).toBe(false);
      expect(ran('danger')).toBe(false);
    }, SLOW_TEST_MS);

    it('run --chain: the chain entry\'s own name, and each name it lists, are gated as typed', () => {
      // The name typed to --chain, aliased by the repo to a list of its own.
      ship('_aliases.json', { 'cmd.danger': 'evil.list' });
      shipEntry('evil.list', 'evil.cmd');
      expect(json('run', '--chain', 'cmd.danger').error?.code).toBe('REQUIRES_CONFIRMATION');
      // A project chain listing the flagged name, which the repo aliases.
      ship('_aliases.json', { 'cmd.danger': 'evil.cmd' });
      shipEntry('proj.all', 'cmd.danger');
      expect(json('run', '--chain', 'proj.all').error?.code).toBe('REQUIRES_CONFIRMATION');
      expect(ran('evil')).toBe(false);
    }, SLOW_TEST_MS);

    it('run seg:seg composition: a flagged name in any segment is gated', () => {
      shipEntry('cmd.pre', 'echo pre');
      expect(json('run', 'cmd.pre:cmd.danger').error?.code).toBe('REQUIRES_CONFIRMATION');
      expect(json('run', 'cmd.pre', 'cmd.danger').error?.code).toBe('REQUIRES_CONFIRMATION');
      expect(ran('evil')).toBe(false);
    }, SLOW_TEST_MS);
  });

  it('a project alias over the user\'s global alias to a flagged command is gated', () => {
    expect(rvrIn(outside, 'alias', 'set', '-G', 'dp', 'cmd.danger').status).toBe(0);
    ship('_aliases.json', { dp: 'evil.cmd' });
    shipEntry('evil.cmd', touch('evil'));
    expect(json('run', 'dp').error?.code).toBe('REQUIRES_CONFIRMATION');
    expect(ran('evil')).toBe(false);
  }, SLOW_TEST_MS);

  describe('MCP reverie_run', () => {
    let mcp: McpSession;
    beforeEach(async () => {
      ship('_aliases.json', { 'cmd.danger': 'evil.cmd' });
      shipEntry('evil.cmd', touch('evil'));
      shipEntry('cmd.wrapexec', 'echo v=$(cmd.danger)');
      shipEntry('proj.all', 'cmd.danger');
      mcp = await openMcpSession({ cwd: clone, env: { ...env(), RVR_PROJECT: clone } });
    });
    afterEach(() => { mcp.close(); });

    it('asks for a confirm_token for the aliased name, a reference to it, and a chain listing it; runs nothing', async () => {
      for (const args of [{ key: 'cmd.danger' }, { key: 'cmd.wrapexec' }, { key: 'proj.all', chain: true }]) {
        const res = await mcp.call('reverie_run', args);
        expect(res.content[0].text, JSON.stringify(args)).toContain('requires confirmation');
        expect(res.content[0].text, JSON.stringify(args)).toContain('confirm_token');
      }
      expect(ran('evil')).toBe(false);
      // The token flow still works: the preview shows what runs.
      const first = await mcp.call('reverie_run', { key: 'cmd.danger' });
      const token = /confirm_token: "([0-9a-f]+)"/.exec(first.content[0].text)?.[1];
      expect(token).toBeDefined();
      const second = await mcp.call('reverie_run', { key: 'cmd.danger', confirm_token: token });
      expect(second.isError).toBeUndefined();
      expect(ran('evil')).toBe(true);
    }, SLOW_TEST_MS);
  });

  // ── 2. writes that add an alias ──────────────────────────────────────

  describe('an alias named after an entry is refused', () => {
    const importFile = (content: unknown) => {
      const file = path.join(root, `import-${Math.random().toString(36).slice(2)}.json`);
      fs.writeFileSync(file, JSON.stringify(content));
      return file;
    };
    // The audit's file: an attacker's command and an alias over the gated name.
    const attack = () => ({ entries: { x: { evil: touch('evil') } }, aliases: { 'deploy.prod': 'x.evil' } });

    beforeEach(() => {
      // The victim's project store, with a gated entry.
      expect(rvr('init', '--no-scan', '--no-claude', '--no-agents').status).toBe(0);
      expect(rvr('set', 'deploy.prod', touch('deploy'), '--confirm').status).toBe(0);
      expect(rvr('set', 'deploy.stage', 'echo stage').status).toBe(0);
    });

    it('merge import (the audit\'s exploit): INVALID_INPUT, the alias map unchanged, the name still gated', () => {
      const before = readAliases(projectStore());
      const env = json('data', 'import', 'all', importFile(attack()), '--merge', '--force');
      expect(env.ok).toBe(false);
      expect(env.error?.code).toBe('INVALID_INPUT');
      expect(env.error?.message).toContain("alias 'deploy.prod'");
      expect(readAliases(projectStore())).toEqual(before);
      // Nothing of the file was written: the import is one transaction.
      expect(json('get', 'x.evil').ok).toBe(false);
      expect(json('run', 'deploy.prod').error?.code).toBe('REQUIRES_CONFIRMATION');
      expect(ran('evil')).toBe(false);
      expect(ran('deploy')).toBe(false);
    }, SLOW_TEST_MS);

    it('import --preview refuses it too, rather than show an import the apply would refuse', () => {
      const r = rvr('data', 'import', 'all', importFile(attack()), '--merge', '--preview');
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("alias 'deploy.prod'");
    }, SLOW_TEST_MS);

    it('import: an entry the file brings, another case, the other store\'s entry', () => {
      const cases: [string, unknown][] = [
        ['an entry in the same file', { entries: { y: { run: 'echo y' } }, aliases: { 'y.run': 'deploy.stage' } }],
        ['another case of a stored entry', { aliases: { 'Deploy.Prod': 'deploy.stage' } }],
        ['an entry of the global store', { aliases: { 'cmd.danger': 'deploy.stage' } }],
      ];
      for (const [label, content] of cases) {
        const env = json('data', 'import', 'all', importFile(content), '--merge', '--force');
        expect(env.error?.code, label).toBe('INVALID_INPUT');
      }
      expect(readAliases(projectStore())).toEqual({});
    }, SLOW_TEST_MS);

    it('import: a spelling the filesystem folds onto the entry is refused where it folds', () => {
      // U+017F LONG S: a case-insensitive APFS volume opens `deploy.stage`'s
      // file for it; elsewhere it is another key, and the alias is allowed.
      const folded = `deploy.${String.fromCodePoint(0x17f)}tage`;
      const opens = fs.existsSync(path.join(projectStore(), `${folded}.json`));
      const env = json('data', 'import', 'aliases', importFile({ [folded]: 'deploy.prod' }), '--merge', '--force');
      expect(env.ok).toBe(!opens);
      if (opens) expect(env.error?.code).toBe('INVALID_INPUT');
    }, SLOW_TEST_MS);

    it('import: an alias the store already has, unchanged, passes; a replace drops the entries it replaces', () => {
      // A backup restored as it was: the alias is already there, same target.
      ship('_aliases.json', { 'deploy.stage': 'deploy.prod' });
      expect(json('data', 'import', 'aliases', importFile({ 'deploy.stage': 'deploy.prod' }), '--merge', '--force').ok).toBe(true);
      // Replace with an entries section: the store's entries are the file's.
      ship('_aliases.json', {});
      const env = json('data', 'import', 'all', importFile({ entries: { other: { k: 'v' } }, aliases: { 'deploy.stage': 'other.k' } }), '--force');
      expect(env.ok).toBe(true);
    }, SLOW_TEST_MS);

    it('alias set, alias set -G, alias rename: INVALID_INPUT, nothing written', () => {
      const a = json('alias', 'set', 'deploy.prod', 'deploy.stage');
      expect(a.error?.code).toBe('INVALID_INPUT');
      expect(rvr('alias', 'set', 'deploy.prod', 'deploy.stage').stderr).toContain("alias 'deploy.prod'");
      // -G: the project's entry counts too ("either store").
      expect(json('alias', 'set', '-G', 'deploy.prod', 'cmd.danger').error?.code).toBe('INVALID_INPUT');
      expect(readAliases(globalStore())).toEqual({});
      expect(json('alias', 'set', 'ok.name', 'deploy.stage').ok).toBe(true);
      expect(json('alias', 'rename', 'ok.name', 'deploy.prod').error?.code).toBe('INVALID_INPUT');
      expect(readAliases(projectStore())).toEqual({ 'ok.name': 'deploy.stage' });
    }, SLOW_TEST_MS);

    it('set -a and rename --set-alias: refused before anything is written; the old key of a rename is free', () => {
      expect(json('set', 'x.evil', touch('evil'), '-a', 'deploy.prod').error?.code).toBe('INVALID_INPUT');
      expect(json('get', 'x.evil').ok).toBe(false);
      expect(json('set', 'deploy.stage', '--confirm', '-a', 'deploy.prod').error?.code).toBe('INVALID_INPUT');
      expect(readAliases(projectStore())).toEqual({});
      expect(json('rename', 'deploy.stage', 'deploy.qa', '--set-alias', 'deploy.prod').error?.code).toBe('INVALID_INPUT');
      expect(json('get', 'deploy.stage').ok).toBe(true);
      // Renamed away, the old key names nothing: it may become the alias.
      expect(json('rename', 'deploy.stage', 'deploy.qa', '--set-alias', 'deploy.stage').ok).toBe(true);
      expect(readAliases(projectStore())).toEqual({ 'deploy.stage': 'deploy.qa' });
    }, SLOW_TEST_MS);

    describe('MCP', () => {
      let mcp: McpSession;
      beforeEach(async () => { mcp = await openMcpSession({ cwd: clone, env: { ...env(), RVR_PROJECT: clone } }); });
      afterEach(() => { mcp.close(); });

      it('reverie_alias_set, reverie_set alias, reverie_import (and its preview) refuse; nothing is written', async () => {
        const alias = await mcp.call('reverie_alias_set', { alias: 'deploy.prod', key: 'deploy.stage' });
        expect(alias.isError).toBe(true);
        expect(alias.content[0].text).toContain("alias 'deploy.prod'");
        const set = await mcp.call('reverie_set', { key: 'x.evil', value: touch('evil'), alias: 'deploy.prod' });
        expect(set.isError).toBe(true);
        const data = JSON.stringify(attack());
        const preview = await mcp.call('reverie_import', { type: 'all', data, merge: true, preview: true });
        expect(preview.isError).toBe(true);
        expect(preview.content[0].text).toContain("alias 'deploy.prod'");
        const imported = await mcp.call('reverie_import', { type: 'all', data, merge: true });
        expect(imported.isError).toBe(true);
        expect(imported.content[0].text).toContain("alias 'deploy.prod'");
        expect(readAliases(projectStore())).toEqual({});
        expect(json('get', 'x.evil').ok).toBe(false);
        const run = await mcp.call('reverie_run', { key: 'deploy.prod' });
        expect(run.content[0].text).toContain('requires confirmation');
        expect(ran('evil')).toBe(false);
      }, SLOW_TEST_MS);
    });
  });
});
