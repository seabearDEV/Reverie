// #294, #296, end to end: an explicit project scope — CLI `-P` on the data
// commands, MCP `scope: "project"` on every tool that takes a scope — with no
// project refuses with PROJECT_UNRESOLVED and changes nothing. It used to
// fall back to the global store: `data reset entries -P --force` emptied it
// with no backup, `data import … -P` replaced it, and MCP `reverie_set` with
// an alias wrote the entry and then refused the alias.
//
// Spawns the built dist/ (assumes `bun run build` has run) with a private
// HOME, RVR_DATA_DIR and working directory. Outside a project means the
// walk-up from that directory finds no `.reverie/`: RVR_NO_PROJECT and
// RVR_PROJECT are unset, except where a test sets them on purpose.

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { assertDistHonorsDataDir } from './helpers/spawnGuard';
import { openMcpSession, type McpSession, type McpToolResult } from './helpers/mcpSession';

interface Envelope {
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string };
}

const CLI = path.resolve('dist/index.js');
const EXPLICIT = 'requested explicitly';

let root: string;
let home: string;
let dataDir: string;
let cwd: string;
let runLog: string;

function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const e: Record<string, string | undefined> = { ...process.env, HOME: home, RVR_DATA_DIR: dataDir, ...extra };
  for (const name of ['RVR_NO_PROJECT', 'RVR_PROJECT', 'RVR_PROJECT_DIR', 'RVR_SESSION']) {
    if (!(name in extra)) delete e[name];
  }
  return e as NodeJS.ProcessEnv;
}

function rvr(args: string[], opts: { cwd?: string; input?: string } = {}) {
  const r = spawnSync('bun', [CLI, ...args], { cwd: opts.cwd ?? cwd, env: env(), input: opts.input ?? '' });
  return { stdout: r.stdout.toString(), stderr: r.stderr.toString(), status: r.status };
}

function json(args: string[], opts: { cwd?: string } = {}): { envelope: Envelope; status: number | null } {
  const r = rvr(['--json', ...args], opts);
  return { envelope: JSON.parse(r.stdout) as Envelope, status: r.status };
}

/** Every file under `dir`, byte for byte (base64), and every directory. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string, rel: string) => {
    for (const name of fs.readdirSync(d).sort()) {
      const full = path.join(d, name);
      const r = rel ? `${rel}/${name}` : name;
      if (fs.lstatSync(full).isDirectory()) {
        out[`${r}/`] = '';
        walk(full, r);
      } else {
        out[r] = fs.readFileSync(full).toString('base64');
      }
    }
  };
  if (fs.existsSync(dir)) walk(dir, '');
  return out;
}

/** The global store, and what sits beside it — a backup included. The logs a refusal writes are left out. */
function globalState(): { store: Record<string, string>; dataDir: string[] } {
  const logs = new Set(['audit.jsonl', 'telemetry.jsonl', 'miss-paths.jsonl', 'sessions']);
  return {
    store: snapshot(path.join(dataDir, 'store')),
    dataDir: fs.readdirSync(dataDir).filter(n => !logs.has(n)).sort(),
  };
}

function expectExplicitRefusal(e: Envelope, status: number | null): void {
  expect(e.ok).toBe(false);
  expect(e.error?.code).toBe('PROJECT_UNRESOLVED');
  expect(e.error?.message).toContain(EXPLICIT);
  expect(e.error?.message).toContain('nothing was changed');
  expect(status).toBe(1);
}

interface McpRefusal { code?: string; requested?: string; unusable?: string }

function mcpBlock(r: McpToolResult): McpRefusal {
  const block = r.content[1]?.text;
  if (!block) return {};
  return JSON.parse(block.replace(/^```json\n/, '').replace(/\n```$/, '')) as McpRefusal;
}

function mcpCode(r: McpToolResult): string | undefined {
  return mcpBlock(r).code;
}

function expectMcpExplicitRefusal(r: McpToolResult, what: string): void {
  expect(r.isError, what).toBe(true);
  expect(mcpCode(r), what).toBe('PROJECT_UNRESOLVED');
  expect(mcpBlock(r).requested, what).toBe('project');
  expect(r.content[0].text, what).toContain(EXPLICIT);
}

beforeAll(() => { assertDistHonorsDataDir(); });

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'reverie-explicit-project-')));
  home = path.join(root, 'home');
  dataDir = path.join(root, 'data');
  cwd = path.join(root, 'cwd');
  runLog = path.join(root, 'ran.log');
  for (const d of [home, dataDir, cwd]) fs.mkdirSync(d);
  // A global store with entries, an alias and a command that leaves a trace.
  expect(rvr(['set', '-G', 'ent.a', 'hello', '-a', 'y']).status).toBe(0);
  expect(rvr(['set', '-G', 'ent.b', 'keep']).status).toBe(0);
  expect(rvr(['set', '-G', 'commands.log', `echo ran >> ${runLog}`]).status).toBe(0);
});

afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe('CLI data commands with -P outside a project (#296)', () => {
  const importFile = () => {
    const f = path.join(root, 'imp.json');
    fs.writeFileSync(f, JSON.stringify({ 'other.x': 'imported' }));
    return f;
  };

  const cases: [string, () => string[]][] = [
    ['data reset entries -P --force', () => ['data', 'reset', 'entries', '-P', '--force']],
    ['data reset all -P --force', () => ['data', 'reset', 'all', '-P', '--force']],
    ['data reset aliases -P --force', () => ['data', 'reset', 'aliases', '-P', '--force']],
    ['data import entries <file> -P --force', () => ['data', 'import', 'entries', importFile(), '-P', '--force']],
    ['data import entries <file> -P --merge --force', () => ['data', 'import', 'entries', importFile(), '-P', '--merge', '--force']],
    ['data export entries -P', () => ['data', 'export', 'entries', '-P', '-o', path.join(root, 'out.json')]],
    ['data export all -P', () => ['data', 'export', 'all', '-P', '-o', path.join(root, 'out.json')]],
  ];

  for (const [label, args] of cases) {
    it(`${label}: refused, and the global store is byte-identical`, () => {
      const before = globalState();
      const { envelope, status } = json(args());
      expectExplicitRefusal(envelope, status);
      expect(globalState()).toEqual(before);
      expect(fs.existsSync(path.join(root, 'out.json'))).toBe(false);
      expect(fs.readdirSync(cwd)).toEqual([]);
    });
  }

  it('text mode: the refusal on stderr, exit 1, no stack trace', () => {
    const before = globalState();
    const r = rvr(['data', 'reset', 'entries', '-P', '--force']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(EXPLICIT);
    expect(r.stderr).not.toContain('    at ');
    expect(r.stderr).not.toContain('auto-backup failed');
    expect(globalState()).toEqual(before);
  });

  // The prompt comes after the refusal: answering it "y" must not get as far as a reset.
  it('without --force the prompt is never shown, even with "y" waiting on stdin', () => {
    const before = globalState();
    const reset = rvr(['data', 'reset', 'entries', '-P'], { input: 'y\n' });
    expect(reset.status).toBe(1);
    expect(reset.stdout + reset.stderr).not.toContain('This will reset');
    expect(reset.stdout + reset.stderr).not.toContain('Continue?');
    expect(reset.stderr).toContain(EXPLICIT);

    const imp = rvr(['data', 'import', 'entries', importFile(), '-P'], { input: 'y\n' });
    expect(imp.status).toBe(1);
    expect(imp.stdout + imp.stderr).not.toContain('This will replace');
    expect(imp.stdout + imp.stderr).not.toContain('Continue?');
    expect(imp.stderr).toContain(EXPLICIT);
    expect(globalState()).toEqual(before);
  });

  it('RVR_PROJECT naming a directory with no store, or RVR_NO_PROJECT, refuses too', () => {
    const before = globalState();
    for (const extra of [{ RVR_PROJECT: cwd }, { RVR_NO_PROJECT: '1' }]) {
      const r = spawnSync('bun', [CLI, '--json', 'data', 'reset', 'entries', '-P', '--force'], { cwd, env: env(extra), input: '' });
      expectExplicitRefusal(JSON.parse(r.stdout.toString()) as Envelope, r.status);
    }
    expect(globalState()).toEqual(before);
  });
});

describe('CLI without -P outside a project: unchanged', () => {
  it('auto reads fall through to the global store; auto writes refuse as #99 designed', () => {
    const get = json(['get', 'ent.a']);
    expect(get.envelope.ok).toBe(true);
    expect(JSON.stringify(get.envelope.result)).toContain('hello');

    const before = globalState().store;
    const set = json(['set', 'x.y', 'v']);
    expect(set.envelope.error?.code).toBe('PROJECT_UNRESOLVED');
    expect(set.envelope.error?.message).toContain('refusing to write under scope:auto');
    expect(set.envelope.error?.message).not.toContain(EXPLICIT);
    expect(globalState().store).toEqual(before);

    const out = path.join(root, 'auto.json');
    expect(json(['data', 'export', 'entries', '-o', out]).envelope.ok).toBe(true);
    const exported = JSON.parse(fs.readFileSync(out, 'utf8')) as { $reverie: { scope: string } };
    expect(exported.$reverie.scope).toBe('global');
    expect(JSON.stringify(exported)).toContain('hello');
  });

  it('-G still works on every data command', () => {
    const out = path.join(root, 'g.json');
    expect(json(['data', 'export', 'entries', '-G', '-o', out]).envelope.ok).toBe(true);
    expect(JSON.stringify(JSON.parse(fs.readFileSync(out, 'utf8')))).toContain('keep');

    const reset = json(['data', 'reset', 'entries', '-G', '--force']);
    expect(reset.envelope.ok).toBe(true);
    expect(Object.keys(globalState().store).filter(f => f.startsWith('ent.'))).toEqual([]);
    // The reset was backed up.
    expect(fs.readdirSync(path.join(dataDir, '.backups')).some(n => n.startsWith('pre-reset-'))).toBe(true);
  });
});

describe('CLI data commands with -P inside a project', () => {
  let proj: string;
  beforeEach(() => {
    proj = path.join(root, 'proj');
    fs.mkdirSync(path.join(proj, '.reverie'), { recursive: true });
    expect(rvr(['set', 'p.one', 'projval'], { cwd: proj }).status).toBe(0);
  });

  it('export, import and reset act on the project store, with a project backup; the global store is untouched', () => {
    const before = globalState();
    const out = path.join(root, 'p.json');
    expect(json(['data', 'export', 'entries', '-P', '-o', out], { cwd: proj }).envelope.ok).toBe(true);
    const exported = JSON.parse(fs.readFileSync(out, 'utf8')) as { $reverie: { scope: string } };
    expect(exported.$reverie.scope).toBe('project');
    expect(JSON.stringify(exported)).toContain('projval');
    expect(JSON.stringify(exported)).not.toContain('hello');

    const f = path.join(root, 'imp.json');
    fs.writeFileSync(f, JSON.stringify({ 'other.x': 'imported' }));
    expect(json(['data', 'import', 'entries', f, '-P', '--force'], { cwd: proj }).envelope.ok).toBe(true);
    expect(fs.existsSync(path.join(proj, '.reverie', 'other.x.json'))).toBe(true);
    expect(fs.existsSync(path.join(proj, '.reverie', 'p.one.json'))).toBe(false);

    expect(json(['data', 'reset', 'entries', '-P', '--force'], { cwd: proj }).envelope.ok).toBe(true);
    expect(fs.existsSync(path.join(proj, '.reverie', 'other.x.json'))).toBe(false);
    const backups = fs.readdirSync(path.join(proj, '.reverie.backups'));
    expect(backups.some(n => n.startsWith('pre-import-'))).toBe(true);
    expect(backups.some(n => n.startsWith('pre-reset-'))).toBe(true);

    expect(globalState()).toEqual(before);
  });
});

// Every MCP tool that takes a scope.
const SCOPED_CALLS: [string, Record<string, unknown>][] = [
  ['reverie_set', { key: 'ent.a', value: 'NEW' }],
  ['reverie_get', { key: 'ent.a' }],
  ['reverie_get', {}],
  ['reverie_remove', { key: 'ent.a' }],
  ['reverie_remove', { key: 'y', is_alias: true }],
  ['reverie_copy', { source: 'ent.a', dest: 'ent.c', force: true }],
  ['reverie_rename', { oldKey: 'ent.a', newKey: 'ent.d' }],
  ['reverie_rename', { oldKey: 'y', newKey: 'y2', is_alias: true }],
  ['reverie_find', { query: 'hello' }],
  ['reverie_alias_set', { alias: 'q', key: 'ent.b' }],
  ['reverie_alias_remove', { alias: 'y' }],
  ['reverie_alias_list', {}],
  ['reverie_run', { key: 'commands.log' }],
  ['reverie_run', { key: 'commands.log', force: true }],
  ['reverie_export', { type: 'all' }],
  ['reverie_import', { data: { 'other.x': 'imported' }, type: 'entries', merge: false }],
  ['reverie_import', { data: { 'other.x': 'imported' }, type: 'entries', preview: true }],
  ['reverie_reset', { type: 'entries' }],
  ['reverie_reset', { type: 'all' }],
  ['reverie_context', {}],
  ['reverie_stale', {}],
];

describe('MCP scope:"project" outside a project (#294, #296)', () => {
  let session: McpSession | undefined;
  afterEach(() => { session?.close(); session = undefined; });

  it('every tool that takes a scope refuses; nothing changes and nothing runs', async () => {
    const before = globalState();
    session = await openMcpSession({ cwd, env: env() });
    const tools = new Set<string>();
    for (const [tool, args] of SCOPED_CALLS) {
      tools.add(tool);
      expectMcpExplicitRefusal(await session.call(tool, { ...args, scope: 'project' }), `${tool} ${JSON.stringify(args)}`);
    }
    // All fifteen.
    expect(tools.size).toBe(15);
    expect(globalState()).toEqual(before);
    expect(fs.existsSync(runLog)).toBe(false);
  });

  // Each of these is wrong in a second way too: the refusal comes first,
  // before the handler would have reported the other problem — or, for the
  // log reset, done what it was asked.
  it('the refusal comes before anything the tool would do', async () => {
    const audit = path.join(dataDir, 'audit.jsonl');
    session = await openMcpSession({ cwd, env: env() });
    expectMcpExplicitRefusal(await session.call('reverie_find', { query: 'x', keysOnly: true, valuesOnly: true, scope: 'project' }), 'find');
    expectMcpExplicitRefusal(await session.call('reverie_import', { data: 'not json', scope: 'project' }), 'import');
    expectMcpExplicitRefusal(await session.call('reverie_set', { key: 'ent.a', value: 'x', alias: '.bad', scope: 'project' }), 'set');
    expect(fs.existsSync(audit)).toBe(true);
    const auditBefore = fs.readFileSync(audit, 'utf8');
    expectMcpExplicitRefusal(await session.call('reverie_reset', { type: 'audit', scope: 'project' }), 'reset audit');
    // Not cleared: the refusal appended its own row.
    expect(fs.readFileSync(audit, 'utf8').startsWith(auditBefore)).toBe(true);
  });

  it('the #294 repro: reverie_set with an alias while the global alias map is unreadable changes nothing', async () => {
    fs.writeFileSync(path.join(dataDir, 'store', '_aliases.json'), '[]');
    const before = globalState();
    session = await openMcpSession({ cwd, env: env() });
    expectMcpExplicitRefusal(await session.call('reverie_set', { key: 'ent.b', value: 'NEW', alias: 'zz', scope: 'project' }), 'set');
    expectMcpExplicitRefusal(await session.call('reverie_set', { key: 'ent.new', value: 'NEW', alias: 'zz', scope: 'project' }), 'set new');
    expect(globalState()).toEqual(before);
    expect((await session.call('reverie_get', { key: 'ent.b', scope: 'global' })).content[0].text).toBe('ent.b: keep');
  });

  it('the #294 repro: reverie_remove while the global alias map is truncated changes nothing', async () => {
    fs.writeFileSync(path.join(dataDir, 'store', '_aliases.json'), '{"y": "ent.a"');
    const before = globalState();
    session = await openMcpSession({ cwd, env: env() });
    expectMcpExplicitRefusal(await session.call('reverie_remove', { key: 'ent.a', scope: 'project' }), 'remove');
    expect(globalState()).toEqual(before);
  });

  it('RVR_PROJECT naming a directory with no store refuses too', async () => {
    const before = globalState();
    session = await openMcpSession({ cwd, env: env({ RVR_PROJECT: cwd }) });
    expectMcpExplicitRefusal(await session.call('reverie_reset', { type: 'all', scope: 'project' }), 'reset');
    expectMcpExplicitRefusal(await session.call('reverie_get', { key: 'ent.a', scope: 'project' }), 'get');
    expect(globalState()).toEqual(before);
  });
});

describe('MCP without scope:"project" outside a project: unchanged', () => {
  let session: McpSession | undefined;
  afterEach(() => { session?.close(); session = undefined; });

  it('auto reads see the global store, auto writes refuse as #99 designed, scope:"global" writes it', async () => {
    session = await openMcpSession({ cwd, env: env() });
    expect((await session.call('reverie_get', { key: 'ent.a' })).content[0].text).toBe('ent.a: hello');
    expect((await session.call('reverie_find', { query: 'keep' })).content[0].text).toContain('ent.b: keep');
    expect((await session.call('reverie_context', {})).content[0].text).toContain('[project: NONE');

    const before = globalState();
    const auto = await session.call('reverie_set', { key: 'x.y', value: 'v' });
    expect(auto.isError).toBe(true);
    expect(mcpCode(auto)).toBe('PROJECT_UNRESOLVED');
    expect(auto.content[0].text).toContain('refusing to write under scope:auto');
    const autoReset = await session.call('reverie_reset', { type: 'entries' });
    expect(mcpCode(autoReset)).toBe('PROJECT_UNRESOLVED');
    expect(globalState()).toEqual(before);

    const global = await session.call('reverie_set', { key: 'x.y', value: 'v', scope: 'global' });
    expect(global.isError).toBeFalsy();
    expect(global.content[0].text).toContain('→ global');
    expect(fs.existsSync(path.join(dataDir, 'store', 'x.y.json'))).toBe(true);
    const run = await session.call('reverie_run', { key: 'commands.log', scope: 'global' });
    expect(run.isError).toBeFalsy();
    expect(fs.readFileSync(runLog, 'utf8')).toBe('ran\n');
  });
});

describe('MCP scope:"project" inside a project: unchanged', () => {
  let session: McpSession | undefined;
  afterEach(() => { session?.close(); session = undefined; });

  it('every tool that takes a scope works on the project store; the global store is untouched', async () => {
    const proj = path.join(root, 'proj');
    const store = path.join(proj, '.reverie');
    fs.mkdirSync(store, { recursive: true });
    const projLog = path.join(root, 'proj-ran.log');
    const before = globalState();
    session = await openMcpSession({ cwd: proj, env: env() });
    const ok = async (tool: string, args: Record<string, unknown>): Promise<string> => {
      const r = await session!.call(tool, { ...args, scope: 'project' });
      expect(r.isError, `${tool} ${JSON.stringify(args)}: ${r.content[0]?.text}`).toBeFalsy();
      return r.content.map(c => c.text).join('\n');
    };
    expect(await ok('reverie_set', { key: 'p.a', value: 'pval', alias: 'pa' })).toContain('→ project');
    expect(await ok('reverie_get', { key: 'p.a' })).toBe('p.a: pval');
    expect(await ok('reverie_get', {})).toContain('p.a');
    expect(await ok('reverie_find', { query: 'pval' })).toContain('p.a: pval');
    expect(await ok('reverie_copy', { source: 'p.a', dest: 'p.b' })).toContain('Copied');
    expect(await ok('reverie_alias_set', { alias: 'pb', key: 'p.b' })).toContain('Alias set');
    expect(await ok('reverie_alias_list', {})).toContain('pb -> p.b');
    expect(await ok('reverie_rename', { oldKey: 'pb', newKey: 'pc', is_alias: true })).toContain('renamed');
    expect(await ok('reverie_alias_remove', { alias: 'pc' })).toContain('Alias removed');
    expect(await ok('reverie_remove', { key: 'pa', is_alias: true })).toContain('Alias removed');
    expect(await ok('reverie_rename', { oldKey: 'p.b', newKey: 'p.c' })).toContain('Renamed');
    expect(await ok('reverie_remove', { key: 'p.c' })).toContain('Removed');
    expect(await ok('reverie_set', { key: 'commands.log', value: `echo ran >> ${projLog}` })).toContain('→ project');
    expect(await ok('reverie_run', { key: 'commands.log' })).toContain('echo ran');
    expect(fs.readFileSync(projLog, 'utf8')).toBe('ran\n');
    expect(await ok('reverie_export', { type: 'entries' })).toContain('"scope":"project"');
    expect(await ok('reverie_import', { data: { 'other.x': 'imported' }, type: 'entries', preview: true })).toContain('preview');
    expect(await ok('reverie_import', { data: { 'other.x': 'imported' }, type: 'entries' })).toContain('merged');
    expect(fs.existsSync(path.join(store, 'other.x.json'))).toBe(true);
    expect(await ok('reverie_context', {})).toContain('other.x');
    expect(await ok('reverie_stale', {})).toBeDefined();
    expect(await ok('reverie_reset', { type: 'all' })).toContain('reset to empty state');
    expect(fs.existsSync(path.join(store, 'other.x.json'))).toBe(false);
    expect(globalState()).toEqual(before);
    expect(fs.existsSync(runLog)).toBe(false);
  });
});

// A long-lived server looks for the project once and keeps the answer; the
// write path asks again, uncached. When the two disagree — a project created
// after a server started outside one — an unscoped write used to resolve to
// the project there and land in the global store here: its checks and its
// saves looked at different stores (#294). It refuses now and changes
// nothing; unscoped reads still read the global store, as before.
describe('MCP: a server that started outside a project, after one is created', () => {
  let session: McpSession | undefined;
  afterEach(() => { session?.close(); session = undefined; });

  it('unscoped writes refuse and change nothing; reads as before; scope:"project" refuses; scope:"global" works', async () => {
    session = await openMcpSession({ cwd, env: env() });
    expect((await session.call('reverie_get', { key: 'ent.a' })).content[0].text).toBe('ent.a: hello');
    const store = path.join(cwd, '.reverie');
    fs.mkdirSync(store);
    fs.writeFileSync(path.join(store, '_aliases.json'), '[]');   // unreadable: the #294 trigger
    // A project entry an unscoped copy must not overwrite, and one a remove must not reach.
    fs.writeFileSync(path.join(store, 'ent.c.json'), JSON.stringify({ value: 'keep', meta: { created: 1, updated: 1 } }));
    const before = { global: globalState(), project: snapshot(store) };

    const unscoped: [string, Record<string, unknown>][] = [
      ['reverie_set', { key: 'n.x', value: 'v' }],
      ['reverie_set', { key: 'n.y', value: 'v', alias: 'zz' }],
      ['reverie_copy', { source: 'ent.a', dest: 'ent.c' }],
      ['reverie_remove', { key: 'y' }],
      ['reverie_alias_set', { alias: 'q', key: 'ent.b' }],
      ['reverie_import', { data: { 'ent.b': 'q' }, type: 'aliases' }],
      ['reverie_reset', { type: 'entries' }],
    ];
    for (const [tool, args] of unscoped) {
      const r = await session.call(tool, args);
      const what = `${tool} ${JSON.stringify(args)}`;
      expect(r.isError, what).toBe(true);
      expect(mcpBlock(r), what).toMatchObject({ code: 'PROJECT_UNRESOLVED', requested: 'auto', unusable: store });
      expect(r.content[0].text, what).toContain('restart the server');
    }
    const explicit = await session.call('reverie_set', { key: 'n.p', value: 'v', scope: 'project' });
    expect(explicit.isError).toBe(true);
    expect(mcpBlock(explicit)).toMatchObject({ code: 'PROJECT_UNRESOLVED', requested: 'project', unusable: store });
    expect({ global: globalState(), project: snapshot(store) }).toEqual(before);

    // Unscoped reads: the global store, as the server has seen it all along.
    expect((await session.call('reverie_get', { key: 'ent.a' })).content[0].text).toBe('ent.a: hello');
    expect((await session.call('reverie_get', { key: 'y' })).content[0].text).toBe('ent.a: hello');
    const g = await session.call('reverie_set', { key: 'n.g', value: 'v', scope: 'global' });
    expect(g.isError, g.content[0].text).toBeFalsy();
    expect(fs.existsSync(path.join(dataDir, 'store', 'n.g.json'))).toBe(true);
    expect(snapshot(store)).toEqual(before.project);
  });
});

// #294 review: a legacy `.codexcli.json` that cannot be migrated is found by
// the resolver but gives the store nothing. The default scope reads the
// global store, as before; a write resolves to no store and refuses.
describe('an unmigratable legacy .codexcli.json', () => {
  beforeEach(() => { fs.writeFileSync(path.join(cwd, '.codexcli.json'), '{bad'); });

  it('CLI: reads, -G and an alias go to the global store; unscoped and -P writes refuse', () => {
    expect(JSON.stringify(json(['get', 'ent.a']).envelope.result)).toContain('hello');
    expect(JSON.stringify(json(['get']).envelope.result)).toContain('commands.log');
    expect(json(['run', 'commands.log']).envelope.ok).toBe(true);
    expect(fs.readFileSync(runLog, 'utf8')).toBe('ran\n');
    const g = json(['set', '-G', 'k.v', 'val', '-a', 'al']);
    expect(g.envelope.ok, JSON.stringify(g.envelope.error)).toBe(true);
    expect(json(['find', 'hello']).envelope.ok).toBe(true);

    const before = globalState();
    const auto = json(['set', 'x.y', 'v']);
    expect(auto.envelope.error?.code).toBe('PROJECT_UNRESOLVED');
    expect(auto.envelope.error?.message).toContain('.codexcli.json');
    expect(json(['data', 'reset', 'entries', '-P', '--force']).envelope.error?.code).toBe('PROJECT_UNRESOLVED');
    expect(globalState()).toEqual(before);
    expect(fs.readFileSync(path.join(cwd, '.codexcli.json'), 'utf8')).toBe('{bad');
  });

  it('MCP: unscoped reads and the bootstrap read the global store', async () => {
    const session = await openMcpSession({ cwd, env: env() });
    try {
      expect((await session.call('reverie_get', { key: 'ent.a' })).content[0].text).toBe('ent.a: hello');
      expect((await session.call('reverie_get', {})).content[0].text).toContain('ent.b');
      const ctx = await session.call('reverie_context', {});
      expect(ctx.isError, ctx.content[0].text).toBeFalsy();
      expect(ctx.content[0].text).toContain('ent.b');
      const before = globalState();
      expect(mcpCode(await session.call('reverie_set', { key: 'm.x', value: 'v' }))).toBe('PROJECT_UNRESOLVED');
      expect(mcpCode(await session.call('reverie_get', { key: 'ent.a', scope: 'project' }))).toBe('PROJECT_UNRESOLVED');
      expect(globalState()).toEqual(before);
    } finally {
      session.close();
    }
  });
});

// #294 review: init where the store it would create is not one this process
// would use. Its seeds went to the global store; then, half-way, refused.
describe('rvr init where its store would not be used', () => {
  const cases: [string, Record<string, string>][] = [
    ['RVR_NO_PROJECT', { RVR_NO_PROJECT: '1' }],
    ['an RVR_PROJECT naming no store', { RVR_PROJECT: path.join(os.tmpdir(), 'reverie-no-such-project') }],
  ];
  for (const [label, extra] of cases) {
    it(`${label}: refused before anything is created`, () => {
      const before = globalState();
      const r = spawnSync('bun', [CLI, '--json', 'init'], { cwd, env: env(extra), input: '' });
      const e = JSON.parse(r.stdout.toString()) as Envelope;
      expect(e.error?.code).toBe('PROJECT_UNRESOLVED');
      expect(e.error?.message).toContain('Nothing was created');
      expect(e.error?.message).not.toContain(EXPLICIT);
      expect(r.status).toBe(1);
      expect(fs.readdirSync(cwd)).toEqual([]);
      expect(globalState()).toEqual(before);
    });
  }

  it('a symlinked .reverie: refused, nothing created or seeded', () => {
    const elsewhere = path.join(root, 'elsewhere');
    fs.mkdirSync(elsewhere);
    fs.symlinkSync(elsewhere, path.join(cwd, '.reverie'));
    const before = globalState();
    const { envelope, status } = json(['init']);
    expect(envelope.error?.code).toBe('INVALID_INPUT');
    expect(envelope.error?.message).toContain('symlink');
    expect(status).toBe(1);
    expect(fs.readdirSync(cwd)).toEqual(['.reverie']);
    expect(fs.readdirSync(elsewhere)).toEqual([]);
    expect(globalState()).toEqual(before);
  });

  it('a plain init still works', () => {
    const { envelope } = json(['init', '--no-claude', '--no-agents']);
    expect(envelope.ok, JSON.stringify(envelope.error)).toBe(true);
    expect(fs.existsSync(path.join(cwd, '.reverie', 'context.initialized.json'))).toBe(true);
  });
});

describe('CLI data commands: the order of their refusals', () => {
  it('an invalid type is INVALID_INPUT before -P is looked at', () => {
    expect(json(['data', 'reset', 'bogus', '-P', '--force']).envelope.error?.code).toBe('INVALID_INPUT');
    expect(json(['data', 'export', 'bogus', '-P']).envelope.error?.code).toBe('INVALID_INPUT');
    expect(json(['data', 'import', 'bogus', path.join(root, 'nope.json'), '-P']).envelope.error?.code).toBe('INVALID_INPUT');
  });

  it('the -P refusal reads the same from export, import and reset', () => {
    const f = path.join(root, 'imp.json');
    fs.writeFileSync(f, '{}');
    const messages = [
      json(['data', 'export', 'entries', '-P']),
      json(['data', 'import', 'entries', f, '-P', '--force']),
      json(['data', 'reset', 'entries', '-P', '--force']),
    ].map(r => r.envelope.error?.message);
    for (const m of messages) expect(m?.startsWith('Project scope was requested explicitly')).toBe(true);
  });
});
