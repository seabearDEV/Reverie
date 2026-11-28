// #305 PR 3, gate and cache: the items checked through the built CLI and a
// running MCP server.
//
// - L7 (#270 item 4) and L10 (#303 item 3): a running MCP server kept a store
//   file rewritten in place — an entry broken or changed, the alias map
//   rewritten — until the store directory changed. It now reads the stores
//   from disk at the start of every tool call, as each CLI command does.
// - L8 (#303 item 1): while the global alias map cannot be read, a run whose
//   lookups read project aliases asks (owner decision, as for an unreadable
//   _confirm.json): the gate cannot see whether a project alias stands in
//   front of a global alias to a flagged entry.
// - L9 (#303 item 2): an alias map with a target that is not a string is an
//   unreadable alias map, not a crash.
// - L11 (#291 item 4): an alias may not be named after an entry whose file
//   cannot be read.
// - L13: `get` of a name that is no entry, while an alias map the lookup
//   reads cannot be read, is STORE_UNREADABLE, not NOT_FOUND.
//
// Spawns the built dist (assumes `bun run build` has run) with a private
// HOME, RVR_DATA_DIR and project directory. Every command appends its name to
// a log, so "it asked" is checked by what ran as well as by the reply.

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { assertDistHonorsDataDir } from './helpers/spawnGuard';
import { openMcpSession, type McpSession, type McpToolResult } from './helpers/mcpSession';

const CLI = path.resolve('dist/index.js');
const SLOW_TEST_MS = 60_000;
const ASKS = 'requires confirmation';
const CONFLICT = '<<<<<<< HEAD\n{"dup": "g.flag"}\n=======\n{}\n>>>>>>> theirs\n';
/** A round mtime, set before a server reads a file and put back after a write in place. */
const PINNED_S = 1_700_000_000;
const isRoot = process.getuid?.() === 0;

let root: string;
let home: string;
let dataDir: string;
let proj: string;
let runLog: string;
let session: McpSession | undefined;

function env(): NodeJS.ProcessEnv {
  const e: Record<string, string | undefined> = { ...process.env, HOME: home, RVR_DATA_DIR: dataDir };
  for (const name of ['RVR_NO_PROJECT', 'RVR_PROJECT', 'RVR_PROJECT_DIR', 'RVR_SESSION']) delete e[name];
  return e as NodeJS.ProcessEnv;
}

function rvr(args: string[]) {
  const r = spawnSync('bun', [CLI, ...args], { cwd: proj, env: env(), input: '' });
  return { stdout: r.stdout.toString(), stderr: r.stderr.toString(), status: r.status };
}

function ok(args: string[]): void {
  const r = rvr(args);
  expect(r.status, `rvr ${args.join(' ')}: ${r.stderr}`).toBe(0);
}

interface Envelope {
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string };
  warnings?: { code: string; message: string }[];
}

function json(args: string[]): Envelope & { stderr: string } {
  const r = rvr([...args, '--json']);
  return { ...(JSON.parse(r.stdout) as Envelope), stderr: r.stderr };
}

/** The commands that ran, in order. */
function ran(): string[] {
  return fs.existsSync(runLog) ? fs.readFileSync(runLog, 'utf8').split('\n').filter(Boolean) : [];
}

function text(r: McpToolResult): string {
  return r.content.map(c => c.text).join('\n');
}

const logs = (name: string) => `echo ${name} >> ${runLog}`;
const projectFile = (name: string) => path.join(proj, '.reverie', name);
const globalFile = (name: string) => path.join(dataDir, 'store', name);

function pin(file: string): void {
  fs.utimesSync(file, PINNED_S, PINNED_S);
}

/**
 * Rewrite a store file in place: the same inode, no directory entry added or
 * removed, and its mtime put back — nothing a timestamp could show.
 */
function writeInPlace(file: string, contents: string): void {
  const dir = path.dirname(file);
  const before = { ino: fs.lstatSync(file).ino, mtimeMs: fs.statSync(file).mtimeMs, dirMtimeMs: fs.statSync(dir).mtimeMs };
  fs.writeFileSync(file, contents);
  fs.utimesSync(file, PINNED_S, PINNED_S);
  expect(fs.lstatSync(file).ino).toBe(before.ino);
  expect(fs.statSync(file).mtimeMs).toBe(before.mtimeMs);
  expect(fs.statSync(dir).mtimeMs).toBe(before.dirMtimeMs);
}

async function server(): Promise<McpSession> {
  session = await openMcpSession({ cwd: proj, env: env() });
  return session;
}

beforeAll(() => { assertDistHonorsDataDir(); });

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'reverie-gate-cache-')));
  home = path.join(root, 'home');
  dataDir = path.join(root, 'data');
  proj = path.join(root, 'proj');
  runLog = path.join(root, 'ran.log');
  for (const d of [home, dataDir, proj]) fs.mkdirSync(d);
  ok(['init']);
});

afterEach(() => {
  session?.close();
  session = undefined;
  for (const f of [globalFile('_aliases.json'), projectFile('_aliases.json')]) {
    try { fs.chmodSync(f, 0o644); } catch { /* absent or a link */ }
  }
  fs.rmSync(root, { recursive: true, force: true });
});

describe('L7 (#270 item 4): a running MCP server sees an entry file rewritten in place', () => {
  beforeEach(() => {
    ok(['set', 'a.one', 'alpha-value']);
    ok(['set', 'b.two', 'beta-value']);
    pin(projectFile('a.one.json'));
  });

  it('broken in place: reverie_context and reverie_find report it, and stop serving its old value', async () => {
    const s = await server();
    expect(text(await s.call('reverie_context', { tier: 'full' }))).toContain('alpha-value');
    expect(text(await s.call('reverie_find', { query: 'alpha' }))).toContain('alpha-value');

    writeInPlace(projectFile('a.one.json'), '<<<<<<< HEAD\n{"value": "alpha-value"}\n=======\n{"value": "x"}\n>>>>>>> theirs\n');

    const ctx = text(await s.call('reverie_context', { tier: 'full' }));
    expect(ctx).toContain('a.one.json has unresolved git conflict markers');
    expect(ctx).not.toContain('alpha-value');
    expect(ctx).toContain('beta-value');
    const found = text(await s.call('reverie_find', { query: 'alpha' }));
    expect(found).toContain('a.one.json has unresolved git conflict markers');
    expect(found).not.toContain('alpha-value');
  }, SLOW_TEST_MS);

  it('changed in place: the next call serves the new value', async () => {
    const s = await server();
    expect(text(await s.call('reverie_context', { tier: 'full' }))).toContain('alpha-value');
    const wrapper = JSON.parse(fs.readFileSync(projectFile('a.one.json'), 'utf8')) as { value: string };
    writeInPlace(projectFile('a.one.json'), JSON.stringify({ ...wrapper, value: 'gamma-value' }));
    const ctx = text(await s.call('reverie_context', { tier: 'full' }));
    expect(ctx).toContain('gamma-value');
    expect(ctx).not.toContain('alpha-value');
    expect(text(await s.call('reverie_find', { query: 'gamma' }))).toContain('gamma-value');
  }, SLOW_TEST_MS);
});

describe('L10 (#303 item 3): a running MCP server sees _aliases.json rewritten in place', () => {
  beforeEach(() => {
    ok(['set', 't1', logs('t1')]);
    ok(['set', 't2', logs('t2')]);
    ok(['alias', 'set', 'al', 't1']);
    ok(['set', '-G', 'g1', logs('g1')]);
    ok(['set', '-G', 'g2', logs('g2')]);
    ok(['alias', 'set', '-G', 'gal', 'g1']);
    pin(projectFile('_aliases.json'));
    pin(globalFile('_aliases.json'));
  });

  it('the project map: run and get follow the new target', async () => {
    const s = await server();
    expect(text(await s.call('reverie_run', { key: 'al' }))).toContain('echo t1');
    writeInPlace(projectFile('_aliases.json'), JSON.stringify({ al: 't2' }));
    expect(text(await s.call('reverie_run', { key: 'al' }))).toContain('echo t2');
    expect(text(await s.call('reverie_get', { key: 'al' }))).toContain('echo t2');
    expect(ran()).toEqual(['t1', 't2']);
  }, SLOW_TEST_MS);

  it('the global map, in the default scope and in scope "global"', async () => {
    const s = await server();
    expect(text(await s.call('reverie_run', { key: 'gal' }))).toContain('echo g1');
    writeInPlace(globalFile('_aliases.json'), JSON.stringify({ gal: 'g2' }));
    expect(text(await s.call('reverie_run', { key: 'gal' }))).toContain('echo g2');
    expect(text(await s.call('reverie_run', { key: 'gal', scope: 'global' }))).toContain('echo g2');
    expect(ran()).toEqual(['g1', 'g2', 'g2']);
  }, SLOW_TEST_MS);
});

describe('L8 (#303 item 1): while the global alias map cannot be read, a run that reads project aliases asks', () => {
  beforeEach(() => {
    ok(['set', 'p.only', logs('P-ONLY')]);
    ok(['alias', 'set', 'dup', 'p.only']);
    ok(['set', '-G', 'g.flag', logs('G-FLAG')]);
    ok(['confirm', 'set', '-G', 'g.flag']);
    ok(['alias', 'set', '-G', 'dup', 'g.flag']);
    ok(['set', '-G', 'g.plain', logs('G-PLAIN')]);
    ok(['set', '-G', 'gch', 'g.plain']);
    // The control: with the map readable, the project alias over the user's
    // global alias to a flagged entry asks (#279).
    expect(json(['run', 'dup']).error?.code).toBe('REQUIRES_CONFIRMATION');
    expect(ran()).toEqual([]);
  });

  const breakers: [string, () => void][] = [
    ['conflict markers', () => { fs.writeFileSync(globalFile('_aliases.json'), CONFLICT); }],
    ['a dangling symbolic link', () => {
      fs.rmSync(globalFile('_aliases.json'));
      fs.symlinkSync(path.join(root, 'nowhere.json'), globalFile('_aliases.json'));
    }],
  ];
  if (!isRoot) breakers.push(['no read permission', () => { fs.chmodSync(globalFile('_aliases.json'), 0o000); }]);

  it.each(breakers)('%s: the CLI asks, and runs on --yes', (_label, breakIt) => {
    breakIt();
    const asked = json(['run', 'dup']);
    expect(asked.error?.code).toBe('REQUIRES_CONFIRMATION');
    expect(asked.error?.message).toContain('global alias map');
    const plain = rvr(['run', 'dup']);
    expect(plain.status).toBe(1);
    expect(plain.stderr).toContain(ASKS);
    // A global chain: its own name was looked up through project aliases.
    expect(json(['run', '--chain', 'gch']).error?.code).toBe('REQUIRES_CONFIRMATION');
    // "Project aliases were used" is the resolver's own reading: any lookup
    // that is not global-only, so a plain project entry asks too.
    expect(json(['run', 'p.only']).error?.code).toBe('REQUIRES_CONFIRMATION');
    expect(ran()).toEqual([]);
    expect(json(['run', 'dup', '--yes']).ok).toBe(true);
    expect(ran()).toEqual(['P-ONLY']);
  });

  it.each(breakers)('%s: a -G run reads no project alias, and does not ask', (_label, breakIt) => {
    breakIt();
    expect(json(['run', '-G', 'g.plain']).ok).toBe(true);
    expect(json(['run', '-G', '--chain', 'gch']).ok).toBe(true);
    expect(ran()).toEqual(['G-PLAIN', 'G-PLAIN']);
  });

  it('outside a project there are no project aliases: no ask', () => {
    fs.writeFileSync(globalFile('_aliases.json'), CONFLICT);
    const outside = path.join(root, 'outside');
    fs.mkdirSync(outside);
    const r = spawnSync('bun', [CLI, 'run', 'g.plain', '--json'], { cwd: outside, env: env(), input: '' });
    expect((JSON.parse(r.stdout.toString()) as Envelope).ok).toBe(true);
    expect(ran()).toEqual(['G-PLAIN']);
  });

  it('MCP: broken before the server starts, and broken in place while it runs', async () => {
    pin(globalFile('_aliases.json'));
    const s = await server();
    expect(text(await s.call('reverie_run', { key: 'p.only' }))).toContain('$ echo P-ONLY');
    expect(ran()).toEqual(['P-ONLY']);

    writeInPlace(globalFile('_aliases.json'), CONFLICT);

    const asked = text(await s.call('reverie_run', { key: 'dup' }));
    expect(asked).toContain(ASKS);
    expect(asked).toContain('global alias map');
    expect(text(await s.call('reverie_run', { key: 'p.only', scope: 'project' }))).toContain(ASKS);
    expect(text(await s.call('reverie_run', { key: 'gch', chain: true }))).toContain(ASKS);
    expect(text(await s.call('reverie_run', { key: 'g.plain', scope: 'global' }))).toContain('$ echo G-PLAIN');
    expect(ran()).toEqual(['P-ONLY', 'G-PLAIN']);
  }, SLOW_TEST_MS);
});

describe('L9 (#303 item 2): an alias target that is not a string makes the alias map unreadable, not a crash', () => {
  beforeEach(() => {
    ok(['set', 'real', 'echo real']);
    ok(['set', '-G', 'greal', 'echo greal']);
    fs.writeFileSync(projectFile('_aliases.json'), JSON.stringify({ pa: 5, po: { x: 1 } }));
    fs.writeFileSync(globalFile('_aliases.json'), JSON.stringify({ ga: true }));
  });

  it('get and run of such an alias fail cleanly; every other read works and says the map is not read', () => {
    for (const args of [['get', 'pa'], ['get', 'po'], ['get', '-G', 'ga'], ['run', 'pa'], ['run', '-G', 'ga']]) {
      const r = json(args);
      expect(r.ok, args.join(' ')).toBe(false);
      expect(r.stderr).not.toContain('TypeError');
      expect(r.error?.code, args.join(' ')).toBe(args[0] === 'get' ? 'STORE_UNREADABLE' : 'NOT_FOUND');
    }
    const got = json(['get', 'real']);
    expect(got.ok).toBe(true);
    expect(got.warnings?.map(w => w.message).join('\n')).toContain('_aliases.json is not a valid store file');
  });

  it('MCP: reverie_get and reverie_run of such an alias', async () => {
    const s = await server();
    const got = await s.call('reverie_get', { key: 'pa' });
    expect(got.isError).toBe(true);
    expect(text(got)).not.toContain('TypeError');
    expect(text(got)).toContain('Cannot read the alias map');
    const run = await s.call('reverie_run', { key: 'pa' });
    expect(run.isError).toBe(true);
    expect(text(run)).not.toContain('TypeError');
  }, SLOW_TEST_MS);
});

describe('L11 (#291 item 4): no alias named after an entry whose file cannot be read', () => {
  beforeEach(() => {
    ok(['set', 'a', 'echo a']);
    ok(['set', '-G', 'ga', 'echo ga']);
    fs.writeFileSync(projectFile('b.json'), '{not json');
    fs.writeFileSync(globalFile('gb.json'), '<<<<<<< HEAD\n{"value": "1"}\n=======\n{"value": "2"}\n>>>>>>> theirs\n');
  });

  const aliasesOnDisk = (file: string) => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, string> : {};

  it.each([
    ['alias set, the project entry', ['alias', 'set', 'b', 'a']],
    ['alias set, another case of it', ['alias', 'set', 'B', 'a']],
    ['alias set, the other store\'s entry', ['alias', 'set', 'gb', 'a']],
    ['alias set -G, the project entry', ['alias', 'set', '-G', 'b', 'ga']],
    ['set -a', ['set', 'c', 'echo c', '-a', 'b']],
  ])('%s is refused, and nothing is written', (_label, args) => {
    const r = json(args);
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('INVALID_INPUT');
    expect(Object.keys(aliasesOnDisk(projectFile('_aliases.json')))).toEqual([]);
    expect(Object.keys(aliasesOnDisk(globalFile('_aliases.json')))).toEqual([]);
    expect(json(['get', 'c']).ok).toBe(false);
  });

  it('a name that is no entry is still free', () => {
    expect(json(['alias', 'set', 'free', 'a']).ok).toBe(true);
  });

  it('MCP reverie_alias_set and reverie_set with an alias', async () => {
    const s = await server();
    expect((await s.call('reverie_alias_set', { alias: 'b', key: 'a' })).isError).toBe(true);
    expect((await s.call('reverie_set', { key: 'c', value: 'echo c', alias: 'gb' })).isError).toBe(true);
    expect(Object.keys(aliasesOnDisk(projectFile('_aliases.json')))).toEqual([]);
  }, SLOW_TEST_MS);
});

describe('L13: get of a name an unreadable alias map might hold is STORE_UNREADABLE', () => {
  beforeEach(() => {
    ok(['set', 'a', 'echo a']);
    ok(['alias', 'set', 'al', 'a']);
    ok(['set', '-G', 'gk', 'echo gk']);
    ok(['alias', 'set', '-G', 'gal', 'gk']);
  });

  it('the project map conflicted: get <alias> in the default scope, JSON and text', () => {
    fs.writeFileSync(projectFile('_aliases.json'), '<<<<<<< HEAD\n{"al": "a"}\n=======\n{}\n>>>>>>> theirs\n');
    const r = json(['get', 'al']);
    expect(r.error?.code).toBe('STORE_UNREADABLE');
    expect(r.error?.message).toContain('Cannot read the alias map');
    const t = rvr(['get', 'al']);
    expect(t.status).toBe(1);
    expect(t.stderr).toContain('Cannot read the alias map');
    expect(t.stderr).not.toContain("Entry 'al' not found");
    // Named once: the error, and no warning block repeating it.
    expect(t.stderr).not.toContain('warning:');
    // An entry still reads; a name the readable global map alone answers, with -G, is not found.
    expect(json(['get', 'a']).ok).toBe(true);
    expect(json(['get', '-G', 'nothere']).error?.code).toBe('NOT_FOUND');
    expect(json(['get', '-G', 'gal']).ok).toBe(true);
  });

  it('the global map conflicted: get in the default scope and with -G', () => {
    fs.writeFileSync(globalFile('_aliases.json'), '<<<<<<< HEAD\n{"gal": "gk"}\n=======\n{}\n>>>>>>> theirs\n');
    expect(json(['get', 'gal']).error?.code).toBe('STORE_UNREADABLE');
    expect(json(['get', '-G', 'gal']).error?.code).toBe('STORE_UNREADABLE');
    expect(json(['get', 'al']).ok).toBe(true);
  });

  it('MCP reverie_get', async () => {
    fs.writeFileSync(projectFile('_aliases.json'), '<<<<<<< HEAD\n{"al": "a"}\n=======\n{}\n>>>>>>> theirs\n');
    const s = await server();
    const r = await s.call('reverie_get', { key: 'al' });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('Cannot read the alias map');
    expect((await s.call('reverie_get', { key: 'nothere', scope: 'global' })).isError).toBe(true);
    expect(text(await s.call('reverie_get', { key: 'nothere', scope: 'global' }))).toContain('not found');
  }, SLOW_TEST_MS);
});
