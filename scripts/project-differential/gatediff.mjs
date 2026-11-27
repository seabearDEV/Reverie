#!/usr/bin/env bun
// Which runs ask, in one project-resolution setup, on one build. Prints one
// JSON line per invocation: { phase, who, inv, outcome, markers, msg? }.
// outcome: RAN (a marker was logged), ASK (refused for confirmation), ERR, OK.
//
//   bun scripts/project-differential/gatediff.mjs <dist> <mode> <root>
//
// <root> is created (and replaced if it holds an earlier run of this tool).
// The modes are the setups the gate fuzzer never builds: a project that
// appears while an MCP server runs, a legacy .codexcli.json that cannot be
// migrated, a nearer project appearing below the one in use. See README.md.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { assertSafeRoot } from '../gate-fuzz/lib/world.mjs';
import { childEnv } from '../gate-fuzz/lib/drive.mjs';
import { MODES } from './modes.mjs';

const MARK = '.project-differential';

const [distArg, mode, rootArg] = process.argv.slice(2);
if (!distArg || !MODES.includes(mode) || !rootArg) {
  console.error(`usage: gatediff.mjs <dist> <mode> <root>\nmodes: ${MODES.join(' ')}`);
  process.exit(2);
}
const dist = path.resolve(distArg);
const root = path.resolve(rootArg);
// Never remove a directory this tool did not make.
if (fs.existsSync(root)) {
  if (!fs.existsSync(path.join(root, MARK))) { console.error(`refusing ${root}: it exists and is not a ${MARK} root`); process.exit(2); }
  fs.rmSync(root, { recursive: true, force: true });
}
fs.mkdirSync(root, { recursive: true });
fs.writeFileSync(path.join(root, MARK), '');
assertSafeRoot(root);

const DATA = path.join(root, 'data'), LOG = path.join(root, 'ran.log');
for (const d of [path.join(root, 'home'), path.join(root, 'tmp'), path.join(DATA, 'store'), path.join(root, 'out')]) fs.mkdirSync(d, { recursive: true });
const env = { ...childEnv(root), RVR_AGENT_NAME: 'project-differential' };

const mark = (n) => `echo M_${n} >> ${LOG}`;
function writeStore(dir, entries, aliases, confirm) {
  fs.mkdirSync(dir, { recursive: true });
  for (const [k, v] of Object.entries(entries)) fs.writeFileSync(path.join(dir, `${k}.json`), JSON.stringify({ value: v }));
  fs.writeFileSync(path.join(dir, '_aliases.json'), JSON.stringify(aliases));
  fs.writeFileSync(path.join(dir, '_confirm.json'), JSON.stringify(confirm));
}
const G = {
  entries: {
    deploy: mark('G_deploy'), build: mark('G_build'), free: mark('G_free'),
    wrap: `${mark('G_wrap')} && \${deploy}`, wrap2: `${mark('G_wrap2')} && \${build}`,
    xwrap: `${mark('G_xwrap')} && $(gx)`, gx: mark('G_gx'),
    chainG: 'free build', chainG2: 'free deploy', pwrapG: `${mark('G_pwrapG')} && \${pfree}`,
  },
  aliases: { ga: 'deploy', gb: 'build', gx2: 'gx' },
  confirm: { deploy: true, gx: true },
};
const P = (tag) => ({
  entries: {
    pdeploy: mark(`${tag}_pdeploy`), build: mark(`${tag}_build`), free: mark(`${tag}_free`), pfree: mark(`${tag}_pfree`),
    pwrap: `${mark(`${tag}_pwrap`)} && \${deploy}`, pwrap2: `${mark(`${tag}_pwrap2`)} && \${pdeploy}`,
    pwrap3: `${mark(`${tag}_pwrap3`)} && \${gb}`, chainP: 'free pdeploy', chainP2: 'pfree build',
  },
  aliases: { pa: 'pdeploy', ga: 'free', gx2: 'pfree' },
  confirm: { pdeploy: true, build: true },
});
const RUNKEYS = ['deploy', 'build', 'free', 'wrap', 'wrap2', 'xwrap', 'gx2', 'ga', 'gb', 'pa', 'pdeploy', 'pfree', 'pwrap', 'pwrap2', 'pwrap3', 'pwrapG'];
const CHAINKEYS = ['chainG', 'chainG2', 'chainP', 'chainP2'];

writeStore(path.join(DATA, 'store'), G.entries, G.aliases, G.confirm);

function takeLog() {
  let s = '';
  try { s = fs.readFileSync(LOG, 'utf8'); fs.unlinkSync(LOG); } catch { /* nothing ran */ }
  return s.split('\n').filter(Boolean).map(l => l.replace('M_', '')).join(',');
}
function out(o) { console.log(JSON.stringify(o)); }

function cli(phase, cwd, args) {
  takeLog();
  const r = spawnSync(process.execPath, [path.join(dist, 'index.js'), ...args], { cwd, env, input: '', encoding: 'utf8', timeout: 30000 });
  const text = (r.stdout || '') + (r.stderr || '');
  const markers = takeLog();
  let outcome = markers ? 'RAN' : /confirm|Confirm|--yes|requires confirmation/i.test(text) ? 'ASK' : 'ERR';
  if (markers && /confirm/i.test(text) && r.status !== 0) outcome = 'RAN?';
  out({ phase, who: `cli@${path.relative(root, cwd)}`, inv: args.join(' '), outcome, markers, msg: outcome === 'ERR' ? text.split('\n')[0].slice(0, 90) : undefined });
}
function cliAll(phase, cwd) {
  for (const k of RUNKEYS) { cli(phase, cwd, ['run', k]); cli(phase, cwd, ['run', '-G', k]); }
  for (const k of CHAINKEYS) { cli(phase, cwd, ['run', '--chain', k]); cli(phase, cwd, ['run', '-G', '--chain', k]); }
  cli(phase, cwd, ['run', 'free:deploy']); cli(phase, cwd, ['run', 'free', 'pdeploy']);
}

async function mcpSession(cwd, script) {
  const proc = spawn(process.execPath, [path.join(dist, 'mcp-server.js')], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = ''; const waiting = new Map();
  proc.stdout.on('data', c => { buf += c; let nl; while ((nl = buf.indexOf('\n')) !== -1) { const line = buf.slice(0, nl); buf = buf.slice(nl + 1); let m; try { m = JSON.parse(line); } catch { continue; } if (waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } } });
  proc.stderr.on('data', () => {});
  let id = 1;
  const req = (method, params) => new Promise(res => { const i = id++; const t = setTimeout(() => { waiting.delete(i); res(null); }, 20000); waiting.set(i, m => { clearTimeout(t); res(m); }); proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n'); });
  await req('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'project-differential', version: '1' } });
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const call = async (phase, name, args, quiet = false) => {
    takeLog();
    const m = await req('tools/call', { name, arguments: args });
    const text = !m ? 'NO_RESPONSE' : m.error ? `RPCERR ${JSON.stringify(m.error)}` : (m.result?.content ?? []).map(c => c.text).join('\n');
    const markers = takeLog();
    const isErr = !m || m.error || m.result?.isError;
    const outcome = markers ? 'RAN' : /requires confirmation/.test(text) ? 'ASK' : isErr ? 'ERR' : 'OK';
    if (!quiet) out({ phase, who: `mcp@${path.relative(root, cwd)}`, inv: `${name} ${JSON.stringify(args)}`, outcome, markers, msg: (outcome === 'ERR' || outcome === 'OK') ? text.split('\n')[0].slice(0, 90) : undefined });
    return text;
  };
  const runAll = async (phase) => {
    for (const scope of [undefined, 'global', 'project']) {
      for (const k of RUNKEYS) await call(phase, 'reverie_run', { key: k, ...(scope && { scope }) });
      for (const k of CHAINKEYS) await call(phase, 'reverie_run', { key: k, chain: true, ...(scope && { scope }) });
    }
  };
  try { await script({ call, runAll }); } finally { proc.stdin.end(); proc.kill(); }
}

const p = (...s) => path.join(root, ...s);
if (mode === 'proj') {
  writeStore(p('proj', '.reverie'), P('P').entries, P('P').aliases, P('P').confirm);
  cliAll('d', p('proj')); cliAll('d', p('out'));
  await mcpSession(p('proj'), async ({ runAll }) => runAll('d'));
  await mcpSession(p('out'), async ({ runAll }) => runAll('d'));
} else if (mode === 'legacy' || mode === 'legacyro' || mode === 'legacydir') {
  // An unparseable legacy file, a read-only directory holding a valid one
  // (it cannot be migrated next to itself), and a directory in its place.
  fs.mkdirSync(p('lp'));
  if (mode === 'legacy') fs.writeFileSync(p('lp', '.codexcli.json'), '{not json');
  if (mode === 'legacydir') fs.mkdirSync(p('lp', '.codexcli.json'));
  if (mode === 'legacyro') { fs.writeFileSync(p('lp', '.codexcli.json'), JSON.stringify({ entries: P('L').entries, aliases: P('L').aliases, confirm: P('L').confirm })); fs.chmodSync(p('lp'), 0o555); }
  try {
    cliAll('a', p('lp'));
    await mcpSession(p('lp'), async ({ runAll, call }) => { await runAll('a'); await call('a-w', 'reverie_set', { key: 'zz.w', value: 'v' }); await runAll('a2'); });
  } finally {
    if (mode === 'legacyro') fs.chmodSync(p('lp'), 0o755);
  }
} else if (mode === 'legacyparent') {
  // A project, and an unmigratable legacy file in a directory below it.
  writeStore(p('pp', '.reverie'), P('P').entries, P('P').aliases, P('P').confirm);
  fs.mkdirSync(p('pp', 'sub')); fs.writeFileSync(p('pp', 'sub', '.codexcli.json'), '{not json');
  cliAll('a', p('pp', 'sub'));
  await mcpSession(p('pp', 'sub'), async ({ runAll }) => runAll('a'));
} else if (mode.startsWith('stale')) {
  // An MCP server started outside any project; a project appears in its cwd
  // after one first call (stale4: before any call).
  fs.mkdirSync(p('ws'));
  writeStore(p('tmpl', '.reverie'), P('P').entries, P('P').aliases, P('P').confirm);
  await mcpSession(p('ws'), async ({ runAll, call }) => {
    if (mode === 'stale') await call('b0', 'reverie_get', { key: 'free' }, true);
    else if (mode === 'stale2') await call('b0', 'reverie_stats', {}, true);
    else if (mode === 'stale3') await call('b0', 'reverie_config_get', {}, true);
    else if (mode === 'stale5') await call('b0', 'reverie_audit', {}, true);
    else if (mode === 'stale6') await call('b0', 'reverie_get', { key: 'free', scope: 'global' }, true);
    fs.renameSync(p('tmpl', '.reverie'), p('ws', '.reverie'));
    await runAll('b1');
    await call('b-w', 'reverie_set', { key: 'zz.w', value: 'v' });
    await call('b-w', 'reverie_remove', { key: 'no.such' });
    await runAll('b2');
  });
} else if (mode === 'nearer' || mode === 'nearer2') {
  // An MCP server running in a project's subdirectory; a nearer project
  // (empty, or with entries) appears in that subdirectory.
  writeStore(p('repo', '.reverie'), P('P1').entries, P('P1').aliases, P('P1').confirm);
  fs.mkdirSync(p('repo', 'sub'));
  await mcpSession(p('repo', 'sub'), async ({ runAll, call }) => {
    await runAll('c0');
    if (mode === 'nearer') fs.mkdirSync(p('repo', 'sub', '.reverie'));
    else writeStore(p('repo', 'sub', '.reverie'), P('P2').entries, {}, {});
    await runAll('c1');
    await call('c-w', 'reverie_set', { key: 'zz.w', value: 'v' });
    await call('c-w', 'reverie_remove', { key: 'no.such' });
    await runAll('c2');
  });
}
