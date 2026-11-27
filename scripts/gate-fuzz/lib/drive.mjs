// Drive a built CLI (dist/index.js) and MCP server (dist/mcp-server.js)
// inside one world. Every child gets an environment built from scratch: a
// temp HOME, RVR_DATA_DIR and TMPDIR under the world root, so no real store
// is ever read or written. RVR_TEST=1 tags the audit and telemetry rows a
// child writes (into the temp data dir) as test traffic, and
// RVR_TEST_CHECKOUT makes the store refuse any write inside this checkout;
// neither changes the run path (src/utils/testTraffic.ts,
// src/utils/directoryStore.ts testCheckoutRefusal).
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', '..');
const TIMEOUT_MS = 30_000;

export function childEnv(root, cacheDir) {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: path.join(root, 'home'),
    RVR_DATA_DIR: path.join(root, 'data'),
    TMPDIR: path.join(root, 'tmp'),
    SHELL: '/bin/sh',
    RLOG: path.join(root, 'log'),
    RVR_TEST: '1',
    RVR_TEST_CHECKOUT: REPO_ROOT,
    RVR_AGENT_NAME: 'gate-fuzz',
    NO_COLOR: '1',
    ...(cacheDir ? { BUN_RUNTIME_TRANSPILER_CACHE_PATH: cacheDir } : {}),
  };
}

const MARKER = /RVM(\d+)x/g;

function takeLog(root) {
  const file = path.join(root, 'log');
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { /* nothing ran */ }
  fs.rmSync(file, { force: true });
  return text;
}

export function markersIn(text) {
  return [...new Set([...text.matchAll(MARKER)].map(m => Number(m[1])))].sort((a, b) => a - b);
}

/**
 * One CLI invocation. `mode`: 'json' (--json), 'plain' (stdin closed),
 * 'capture' (--capture) or 'source' (--source; stdout is then evaluated by
 * /bin/sh, as the shell wrapper would). Returns what ran (markers in the
 * log) and how it ended.
 */
export function runCli(dist, root, cwd, args, { mode = 'json', cacheDir } = {}) {
  takeLog(root);
  const env = childEnv(root, cacheDir);
  const argv = mode === 'json' ? ['--json', ...args] : mode === 'capture' ? [...args, '--capture'] : mode === 'source' ? [...args, '--source'] : args;
  const p = spawnSync(process.execPath, [path.join(dist, 'index.js'), ...argv], { cwd: path.join(root, cwd), env, input: '', encoding: 'utf8', timeout: TIMEOUT_MS });
  let evaluated = false;
  if (mode === 'source' && p.status === 0 && p.stdout.trim()) {
    spawnSync('/bin/sh', ['-c', p.stdout], { cwd: path.join(root, cwd), env, input: '', encoding: 'utf8', timeout: TIMEOUT_MS });
    evaluated = true;
  }
  const log = takeLog(root);
  const res = { markers: markersIn(log), exit: p.status, signal: p.signal, evaluated };
  if (p.error) return { ...res, kind: 'error', code: 'SPAWN', message: String(p.error) };
  if (mode === 'json') {
    let env1;
    try { env1 = JSON.parse(p.stdout); } catch { return { ...res, kind: 'error', code: 'NO_ENVELOPE', message: (p.stdout + p.stderr).slice(0, 400) }; }
    if (env1.ok) return { ...res, kind: 'ran', code: 'OK', message: '' };
    const code = env1.error?.code ?? 'UNKNOWN';
    const message = env1.error?.message ?? '';
    if (code === 'REQUIRES_CONFIRMATION') return { ...res, kind: 'ask', code, message, unchecked: /not every reference/i.test(message) };
    if (code === 'COMMAND_FAILED') return { ...res, kind: 'ran', code, message };
    return { ...res, kind: 'error', code, message };
  }
  const message = p.stderr ?? '';
  if (/requires confirmation/i.test(message)) return { ...res, kind: 'ask', code: 'REQUIRES_CONFIRMATION', message, unchecked: /not every reference/i.test(message) };
  if (p.status === 0) return { ...res, kind: 'ran', code: 'OK', message };
  return { ...res, kind: 'error', code: `EXIT_${p.status}`, message };
}

/**
 * One MCP session: the server is started in `cwd`, every call is made in
 * order, and the log is read after each. A call is
 *   { tool, args, token?: 'bogus' | { from: <index of an earlier call> } }
 * `{ from }` passes the confirm_token that call returned (or none, if it
 * returned none). The result says whether the token was a valid approval:
 * issued for this key by a call with the same arguments, and unused.
 * `after()`, if given, runs after each call; what it returns is the call's
 * `store` (the store-invariant problems seen then).
 */
export async function runMcpSession(dist, root, cwd, calls, { cacheDir, after } = {}) {
  takeLog(root);
  const env = childEnv(root, cacheDir);
  const proc = spawn(process.execPath, [path.join(dist, 'mcp-server.js')], { cwd: path.join(root, cwd), env, stdio: ['pipe', 'pipe', 'pipe'] });
  const waiting = new Map();
  let buf = '';
  let exited = false;
  proc.on('exit', () => { exited = true; for (const w of waiting.values()) w(null); waiting.clear(); });
  proc.stdout.on('data', chunk => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      let m;
      try { m = JSON.parse(line); } catch { continue; }
      if (typeof m.id === 'number' && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
    }
  });
  proc.stderr.on('data', () => {});
  let nextId = 1;
  const request = (method, params) => new Promise(resolve => {
    if (exited) { resolve(null); return; }
    const id = nextId++;
    const timer = setTimeout(() => { waiting.delete(id); resolve(null); }, TIMEOUT_MS);
    waiting.set(id, m => { clearTimeout(timer); resolve(m); });
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const results = [];
  try {
    const init = await request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'gate-fuzz', version: '1' } });
    if (!init) throw new Error('MCP server did not initialize');
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const tokens = [];      // per call: the token it returned
    const used = new Set();
    for (const [i, call] of calls.entries()) {
      const args = { ...call.args };
      let approved = false;
      if (call.token === 'bogus') args.confirm_token = 'deadbeefdeadbeef';
      else if (call.token && typeof call.token.from === 'number') {
        const t = tokens[call.token.from];
        if (t) {
          args.confirm_token = t;
          const issuer = calls[call.token.from].args;
          approved = !used.has(t) && issuer.key === call.args.key && issuer.scope === call.args.scope && Boolean(issuer.chain) === Boolean(call.args.chain);
          used.add(t);
        }
      }
      if (call.args.force) approved = true;
      takeLog(root);
      const m = await request('tools/call', { name: call.tool, arguments: args });
      const log = takeLog(root);
      const text = !m ? 'NO_RESPONSE' : m.error ? `RPCERR ${JSON.stringify(m.error)}` : (m.result?.content ?? []).map(c => c.text).join('\n');
      const isError = !m || Boolean(m.error) || Boolean(m.result?.isError);
      const tk = /confirm_token: "([0-9a-f]+)"/.exec(text);
      tokens[i] = tk ? tk[1] : undefined;
      let kind, code;
      if (/requires confirmation before execution/.test(text) && !/changed after that confirm_token/.test(text)) { kind = 'ask'; code = 'REQUIRES_CONFIRMATION'; }
      else if (/changed after that confirm_token/.test(text)) { kind = 'ask'; code = 'TOKEN_STALE'; }
      else if (/Invalid or expired confirm_token/.test(text)) { kind = 'error'; code = 'TOKEN_INVALID'; }
      else if (!isError && call.tool === 'reverie_run' && text.startsWith('$ ')) { kind = 'ran'; code = 'OK'; }
      else if (isError && /Command failed/.test(text)) { kind = 'ran'; code = 'COMMAND_FAILED'; }
      else if (!isError) { kind = 'ok'; code = 'OK'; }
      else { kind = 'error'; code = m ? 'ERROR' : 'NO_RESPONSE'; }
      results.push({ kind, code, message: text.slice(0, 600), markers: markersIn(log), approved, unchecked: /Not every reference/i.test(text), store: after ? after() : [] });
    }
  } finally {
    proc.stdin.end();
    proc.kill();
    await new Promise(r => (exited ? r() : proc.on('exit', r)));
  }
  return results;
}
