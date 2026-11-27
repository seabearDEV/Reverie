// #304: a running MCP server sees a flag added to `_confirm.json` in place.
//
// The store skipped its whole scan, the confirmation list included, while the
// store directory's mtime was unchanged — and a write in place (an editor
// save, `echo … >`, `fs.writeFileSync` on the existing file) keeps the inode
// and leaves the directory alone. `reverie_run` then ran a newly flagged
// command unasked until the server restarted. The CLI was not affected: each
// call is a new process. The gate and the list's other readers now read each
// list from disk on every call (ScopedStore.loadConfirm).
//
// Spawns the built dist (assumes `bun run build` has run) with a private
// HOME, RVR_DATA_DIR and project directory. Each list starts with an
// unrelated flag, so `_confirm.json` already exists and the edit really is in
// place: creating the file would add a directory entry and hide the bug. Each
// test primes the server with one run, rewrites the list in place, and checks
// the precondition (same inode, directory mtime unchanged) before the second
// run. Every command appends its name to a log, so "it asked" is checked by
// what ran as well as by the reply.

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { assertDistHonorsDataDir } from './helpers/spawnGuard';
import { openMcpSession, type McpSession, type McpToolResult } from './helpers/mcpSession';

const CLI = path.resolve('dist/index.js');
const SLOW_TEST_MS = 60_000;
const ASKS = 'requires confirmation';

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

/** The commands that ran, in order. */
function ran(): string[] {
  return fs.existsSync(runLog) ? fs.readFileSync(runLog, 'utf8').split('\n').filter(Boolean) : [];
}

function text(r: McpToolResult): string {
  return r.content.map(c => c.text).join('\n');
}

const projectList = () => path.join(proj, '.reverie', '_confirm.json');
const globalList = () => path.join(dataDir, 'store', '_confirm.json');

/**
 * Rewrite a confirmation list in place: the same inode, and no directory
 * entry added or removed, so the store directory's mtime does not move.
 */
function writeInPlace(file: string, contents: string): void {
  const dir = path.dirname(file);
  const before = { ino: fs.lstatSync(file).ino, dirMtimeMs: fs.statSync(dir).mtimeMs };
  fs.writeFileSync(file, contents);
  expect(fs.lstatSync(file).ino).toBe(before.ino);
  expect(fs.statSync(dir).mtimeMs).toBe(before.dirMtimeMs);
}

function addFlagInPlace(file: string, key: string): void {
  const list = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, true>;
  writeInPlace(file, JSON.stringify({ ...list, [key]: true }, null, 2));
}

async function server(): Promise<McpSession> {
  session = await openMcpSession({ cwd: proj, env: env() });
  return session;
}

beforeAll(() => { assertDistHonorsDataDir(); });

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'reverie-confirm-in-place-')));
  home = path.join(root, 'home');
  dataDir = path.join(root, 'data');
  proj = path.join(root, 'proj');
  runLog = path.join(root, 'ran.log');
  for (const d of [home, dataDir, proj]) fs.mkdirSync(d);
  ok(['init']);
  const logs = (name: string) => `echo ${name} >> ${runLog}`;
  // Project: a plain command, a chain of two, and an unrelated flag.
  ok(['set', 'k', logs('k')]);
  ok(['set', 'm1', logs('m1')]);
  ok(['set', 'm2', logs('m2')]);
  ok(['set', 'ch', 'm1 m2']);
  ok(['set', 'other', logs('other')]);
  ok(['confirm', 'set', 'other']);
  // Global: a plain command and an unrelated flag.
  ok(['set', '-G', 'g', logs('g')]);
  ok(['set', '-G', 'gother', logs('gother')]);
  ok(['confirm', 'set', '-G', 'gother']);
  expect(JSON.parse(fs.readFileSync(projectList(), 'utf8'))).toEqual({ other: true });
  expect(JSON.parse(fs.readFileSync(globalList(), 'utf8'))).toEqual({ gother: true });
});

afterEach(() => {
  session?.close();
  session = undefined;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('#304: a flag added to _confirm.json in place gates the next MCP run', () => {
  it('the project list', async () => {
    const s = await server();
    expect(text(await s.call('reverie_run', { key: 'k' }))).toContain('$ echo k');
    expect(ran()).toEqual(['k']);

    addFlagInPlace(projectList(), 'k');

    const r = await s.call('reverie_run', { key: 'k' });
    expect(r.isError).toBeFalsy();
    expect(text(r)).toContain(ASKS);
    expect(ran()).toEqual(['k']);
    // The CLI control: a new process, so it always read the list afresh.
    const cli = JSON.parse(rvr(['run', 'k', '--json']).stdout) as { ok: boolean; error?: { code: string } };
    expect(cli.error?.code).toBe('REQUIRES_CONFIRMATION');
    expect(ran()).toEqual(['k']);
  }, SLOW_TEST_MS);

  it('the global list, in the default scope and in scope "global"', async () => {
    const s = await server();
    expect(text(await s.call('reverie_run', { key: 'g' }))).toContain('$ echo g');
    expect(text(await s.call('reverie_run', { key: 'g', scope: 'global' }))).toContain('$ echo g');
    expect(ran()).toEqual(['g', 'g']);

    addFlagInPlace(globalList(), 'g');

    expect(text(await s.call('reverie_run', { key: 'g' }))).toContain(ASKS);
    expect(text(await s.call('reverie_run', { key: 'g', scope: 'global' }))).toContain(ASKS);
    expect(ran()).toEqual(['g', 'g']);
  }, SLOW_TEST_MS);

  it('a chain member', async () => {
    const s = await server();
    expect(text(await s.call('reverie_run', { key: 'ch', chain: true }))).toContain('$ echo m1');
    expect(ran()).toEqual(['m1', 'm2']);

    addFlagInPlace(projectList(), 'm2');

    expect(text(await s.call('reverie_run', { key: 'ch', chain: true }))).toContain(ASKS);
    expect(ran()).toEqual(['m1', 'm2']);
  }, SLOW_TEST_MS);

  it('a list made unreadable in place gates every run, and a repair in place lifts it', async () => {
    const s = await server();
    expect(text(await s.call('reverie_run', { key: 'k' }))).toContain('$ echo k');
    expect(ran()).toEqual(['k']);

    writeInPlace(projectList(), '<<<<<<< HEAD\n{"other": true}\n=======\n{}\n>>>>>>> theirs\n');
    const r = await s.call('reverie_run', { key: 'k' });
    expect(text(r)).toContain(ASKS);
    expect(text(r)).toContain(`warning: ${projectList()} has unresolved git conflict markers — every entry is treated as requiring confirmation`);
    expect(ran()).toEqual(['k']);

    writeInPlace(projectList(), JSON.stringify({ other: true }, null, 2));
    expect(text(await s.call('reverie_run', { key: 'k' }))).toContain('$ echo k');
    expect(ran()).toEqual(['k', 'k']);
  }, SLOW_TEST_MS);

  it('a flag reached through a ${…} reference, a $(…) reference or an alias', async () => {
    ok(['set', 'viaref', '${k}']);
    ok(['set', 'viaexec', 'true $(k)']);
    ok(['alias', 'set', 'ak', 'k']);
    const s = await server();
    for (const key of ['viaref', 'viaexec', 'ak']) expect(text(await s.call('reverie_run', { key })).includes(ASKS)).toBe(false);
    expect(ran()).toEqual(['k', 'k', 'k']);

    addFlagInPlace(projectList(), 'k');

    for (const key of ['viaref', 'viaexec', 'ak']) expect(text(await s.call('reverie_run', { key }))).toContain(ASKS);
    expect(ran()).toEqual(['k', 'k', 'k']);
  }, SLOW_TEST_MS);

  it('a confirm_token issued for the in-place flag approves that run', async () => {
    const s = await server();
    expect(text(await s.call('reverie_run', { key: 'k' }))).toContain('$ echo k');

    addFlagInPlace(projectList(), 'k');

    const ask = await s.call('reverie_run', { key: 'k' });
    expect(text(ask)).toContain(ASKS);
    const token = /confirm_token: "([0-9a-f]+)"/.exec(text(ask))?.[1];
    expect(token).toBeDefined();
    expect(ran()).toEqual(['k']);
    expect(text(await s.call('reverie_run', { key: 'k', confirm_token: token }))).toContain('$ echo k');
    expect(ran()).toEqual(['k', 'k']);
  }, SLOW_TEST_MS);

  it('the global list made unreadable in place gates project and global runs, and a repair lifts it', async () => {
    const s = await server();
    expect(text(await s.call('reverie_run', { key: 'k' }))).toContain('$ echo k');
    expect(text(await s.call('reverie_run', { key: 'g', scope: 'global' }))).toContain('$ echo g');
    expect(ran()).toEqual(['k', 'g']);

    writeInPlace(globalList(), '{"gother": tru');
    expect(text(await s.call('reverie_run', { key: 'k' }))).toContain(ASKS);
    expect(text(await s.call('reverie_run', { key: 'g', scope: 'global' }))).toContain(ASKS);
    expect(ran()).toEqual(['k', 'g']);

    writeInPlace(globalList(), JSON.stringify({ gother: true }, null, 2));
    expect(text(await s.call('reverie_run', { key: 'k' }))).toContain('$ echo k');
    expect(text(await s.call('reverie_run', { key: 'g', scope: 'global' }))).toContain('$ echo g');
    expect(ran()).toEqual(['k', 'g', 'k', 'g']);
  }, SLOW_TEST_MS);

  it('readers outside the gate see the flag too (reverie_export)', async () => {
    const s = await server();
    const exported = async (scope: string) =>
      (JSON.parse(text(await s.call('reverie_export', { type: 'confirm', scope }))) as { payload?: { confirm?: unknown }; confirm?: unknown });
    const confirmOf = (e: { payload?: { confirm?: unknown }; confirm?: unknown }) => e.payload?.confirm ?? e.confirm;
    expect(confirmOf(await exported('project'))).toEqual({ other: true });
    expect(confirmOf(await exported('global'))).toEqual({ gother: true });

    addFlagInPlace(projectList(), 'k');
    addFlagInPlace(globalList(), 'g');

    expect(confirmOf(await exported('project'))).toEqual({ other: true, k: true });
    expect(confirmOf(await exported('global'))).toEqual({ gother: true, g: true });
  }, SLOW_TEST_MS);
});
