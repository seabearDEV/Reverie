// Run one invocation of the scope differential on one build, in a fresh
// copy of its world, and record what it did: its output, every file of both
// stores, and the audit and telemetry rows it wrote — normalized so that two
// runs of the same build at the same root give the same record.
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { childEnv } from '../../gate-fuzz/lib/drive.mjs';
import { buildWorld } from '../../gate-fuzz/lib/world.mjs';
import { STORE_DIRS } from '../../gate-fuzz/lib/model.mjs';
import { importAliases, layoutNamed, worldSpec } from './worlds.mjs';

const TIMEOUT_MS = 30_000;

/** Build the invocation's world under `root` (removing whatever is there). */
export function makeWorld(root, inv) {
  const layout = layoutNamed(inv.world);
  buildWorld(root, worldSpec(layout));
  fs.writeFileSync(path.join(root, 'imp.json'), JSON.stringify(importAliases(layout), null, 2));
  // `edit` runs "$EDITOR <file>": this one appends a fixed text, so the
  // edit is a change and the write shows where it landed.
  const editor = path.join(root, 'editor.sh');
  fs.writeFileSync(editor, "#!/bin/sh\nprintf '%s' ' +edited' >> \"$1\"\n");
  fs.chmodSync(editor, 0o755);
}

function env(root, cacheDir) {
  return { ...childEnv(root, cacheDir), EDITOR: path.join(root, 'editor.sh'), RVR_AGENT_NAME: 'scope-differential' };
}

/** The root, as the children may print it (realpath or not), replaced by <ROOT>; ISO times by <TIME>. */
function normalizer(root) {
  const forms = [...new Set([fs.realpathSync(root), root, root.replace(/^\/private\//, '/')])].sort((a, b) => b.length - a.length);
  return text => {
    let s = String(text);
    for (const f of forms) s = s.split(f).join('<ROOT>');
    // An export's exportedAt, and the time in an export file's name.
    return s.replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z/g, '<TIME>').replace(/\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d/g, '<TIME>');
  };
}

function runCli(dist, root, inv, cacheDir) {
  const p = spawnSync(process.execPath, [path.join(dist, 'index.js'), '--json', ...inv.argv], {
    cwd: path.join(root, inv.cwd), env: env(root, cacheDir), input: '', encoding: 'utf8', timeout: TIMEOUT_MS,
  });
  let out;
  try { out = JSON.parse(p.stdout); } catch { out = p.stdout; }
  return { exit: p.status, signal: p.signal, stdout: out, stderr: p.stderr, ...(p.error ? { spawnError: String(p.error) } : {}) };
}

async function runMcp(dist, root, inv, cacheDir) {
  const proc = spawn(process.execPath, [path.join(dist, 'mcp-server.js')], { cwd: path.join(root, inv.cwd), env: env(root, cacheDir), stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '';
  let exited = false;
  const waiting = new Map();
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
  try {
    const init = await request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'scope-differential', version: '1' } });
    if (!init) return { text: 'NO_INIT', isError: true };
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const m = await request('tools/call', { name: inv.tool, arguments: inv.args });
    if (!m) return { text: 'NO_RESPONSE', isError: true };
    if (m.error) return { text: `RPCERR ${JSON.stringify(m.error)}`, isError: true };
    return { text: (m.result?.content ?? []).map(c => c.text).join('\n'), isError: Boolean(m.result?.isError) };
  } finally {
    // The server exits on end of input, after it has written the call's
    // audit and telemetry rows (written after the response). Killing it
    // instead lost them now and then.
    proc.stdin.end();
    const timer = setTimeout(() => proc.kill('SIGKILL'), 10_000);
    await new Promise(r => (exited ? r() : proc.on('exit', r)));
    clearTimeout(timer);
  }
}

/**
 * Every file of both stores and their lock siblings, `_epoch.json` and the
 * scaffolding included: type, content (sha1) or link target. An entry
 * file's timestamps are the world's (1) or a write's; a write's become T.
 */
function storeFiles(root) {
  const files = {};
  const walk = (abs, rel) => {
    let st;
    try { st = fs.lstatSync(abs); } catch { return; }
    if (st.isSymbolicLink()) { files[rel] = `L ${fs.readlinkSync(abs)}`; return; }
    if (st.isDirectory()) {
      files[rel] = 'D';
      for (const f of fs.readdirSync(abs).sort()) walk(path.join(abs, f), `${rel}/${f}`);
      return;
    }
    let bytes = fs.readFileSync(abs);
    if (rel.endsWith('.json') && !path.basename(rel).startsWith('_')) {
      try {
        const doc = JSON.parse(bytes.toString('utf8'));
        if (doc && typeof doc === 'object' && doc.meta && typeof doc.meta === 'object') {
          for (const k of Object.keys(doc.meta)) if (typeof doc.meta[k] === 'number' && doc.meta[k] !== 1) doc.meta[k] = 'T';
          bytes = Buffer.from(JSON.stringify(doc));
        }
      } catch { /* not JSON: hashed as it is */ }
    }
    files[rel] = `F ${crypto.createHash('sha1').update(bytes).digest('hex').slice(0, 16)}`;
  };
  for (const rel of Object.values(STORE_DIRS)) {
    walk(path.join(root, rel), rel);
    walk(path.join(root, rel + '.lock'), rel + '.lock');
  }
  return files;
}

/** Files a command wrote in either cwd outside the store (an export), by normalized name, with normalized content. */
function cwdFiles(root, norm) {
  const out = {};
  for (const dir of ['proj', 'out']) {
    let names = [];
    try { names = fs.readdirSync(path.join(root, dir)); } catch { continue; }
    for (const f of names.sort()) {
      if (f === '.reverie') continue;
      const abs = path.join(root, dir, f);
      if (!fs.lstatSync(abs).isFile()) { out[norm(`${dir}/${f}`)] = 'not a file'; continue; }
      out[norm(`${dir}/${f}`)] = crypto.createHash('sha1').update(norm(fs.readFileSync(abs, 'utf8'))).digest('hex').slice(0, 16);
    }
  }
  return out;
}

/** A map file's content, for the record: what a store's alias or flag list holds after the invocation. */
function sidecars(root) {
  const out = {};
  for (const [name, rel] of Object.entries(STORE_DIRS)) {
    for (const f of ['_aliases.json', '_confirm.json']) {
      try { out[`${name}/${f}`] = fs.readFileSync(path.join(root, rel, f), 'utf8').replace(/\s+/g, ''); } catch { out[`${name}/${f}`] = null; }
    }
  }
  return out;
}

const VOLATILE = new Set(['ts', 'duration', 'session', 'sessionDetected', 'pid']);

/** The JSONL rows of a data-dir log, minus the fields that differ between two runs of one build. */
function logRows(root, file, norm) {
  let text;
  try { text = fs.readFileSync(path.join(root, 'data', file), 'utf8'); } catch { return []; }
  return text.split('\n').filter(Boolean).map(line => {
    let row;
    try { row = JSON.parse(line); } catch { return norm(line); }
    for (const k of VOLATILE) delete row[k];
    return norm(JSON.stringify(row));
  });
}

/** Run `inv` on the build in `dist`, in a fresh world at `root`. */
export async function runInvocation(dist, root, inv, cacheDir) {
  makeWorld(root, inv);
  const norm = normalizer(root);
  const res = inv.surface === 'cli' ? runCli(dist, root, inv, cacheDir) : await runMcp(dist, root, inv, cacheDir);
  return {
    result: JSON.parse(norm(JSON.stringify(res))),
    files: { ...storeFiles(root), ...cwdFiles(root, norm) },
    sidecars: sidecars(root),
    audit: logRows(root, 'audit.jsonl', norm),
    telemetry: logRows(root, 'telemetry.jsonl', norm),
  };
}

/** What differs between two records of one invocation: a list of parts, each with both sides. */
export function compareRecords(a, b) {
  const diffs = [];
  const same = (x, y) => JSON.stringify(x) === JSON.stringify(y);
  if (!same(a.result, b.result)) diffs.push({ part: 'result', a: a.result, b: b.result });
  const paths = [...new Set([...Object.keys(a.files), ...Object.keys(b.files)])].sort();
  const fileDiffs = paths.filter(p => a.files[p] !== b.files[p]).map(p => ({ path: p, a: a.files[p] ?? null, b: b.files[p] ?? null }));
  if (fileDiffs.length) diffs.push({ part: 'files', files: fileDiffs, sidecarsA: a.sidecars, sidecarsB: b.sidecars });
  if (!same(a.audit, b.audit)) diffs.push({ part: 'audit', a: a.audit, b: b.audit });
  if (!same(a.telemetry, b.telemetry)) diffs.push({ part: 'telemetry', a: a.telemetry, b: b.telemetry });
  return diffs;
}
