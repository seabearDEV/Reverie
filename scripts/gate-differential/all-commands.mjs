// Differential check of the acceptance rule: after the same random command sequence on main and on head,
// every (cwd, scope, key) that main gates must be gated on head.
// usage: bun scripts/gate-differential/all-commands.mjs <oldDist> <newDist> <workDir> <trials> <seed> [maxOps]
//   (the code calls the old build "main" and the new one "head"; <workDir> is created and emptied)
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
const cp = (...points) => String.fromCodePoint(...points);   // non-ASCII letters are built from code points: two forms of one letter look alike in an editor

const [mainDist, headDist, workDir, trialsArg, seedArg, maxOpsArg] = process.argv.slice(2);
const TRIALS = Number(trialsArg), SEED = Number(seedArg), MAXOPS = Number(maxOpsArg ?? 12);
const PROBE = path.join(path.dirname(new URL(import.meta.url).pathname), 'probe.mjs');

function rng(seed) { let a = seed >>> 0; return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

const LEAVES = ['ops.deploy', 'ops.build', 'ops.Deploy', `op${cp(0x17f)}.deploy`, 'OPS.deploy', 'jobs.deploy', 'jobs.x', 'x.run', `caf${cp(0xe9)}.go`, `cafe${cp(0x301)}.go`];
const SPACES = ['ops', 'OPS', 'jobs', 'x', 'tmp'];
const VALUES = ['true', '${ops.deploy:-true}', '${jobs.deploy:-true}', 'echo $(ops.build)', 'true # two'];
// Every key a sequence can produce: a rename or copy of a namespace carries its leaf names into any
// other namespace, so a key such as jobs.run exists only after `rename x jobs`. Probing fewer misses
// the gate of every entry that moved.
const NAMESPACES = [...new Set([...SPACES, ...LEAVES.map(k => k.split('.')[0]), 'tmp'])];
const LEAF_NAMES = [...new Set([...LEAVES, 'tmp.deploy', 'tmp.build', 'tmp.x'].map(k => k.split('.').slice(1).join('.')))];
const PROBE_KEYS = [...NAMESPACES.flatMap(ns => LEAF_NAMES.map(leaf => `${ns}.${leaf}`)), 'dp'];

function genOp(r) {
  const pick = a => a[Math.floor(r() * a.length)];
  const where = r() < 0.6 ? 'p1' : r() < 0.7 ? 'p2' : 'outside';
  const G = where === 'outside' || r() < 0.3 ? ['-G'] : [];
  const x = r();
  let args;
  if (x < 0.22) { const f = r(); args = ['set', pick(LEAVES), pick(VALUES), ...(f < 0.4 ? ['--confirm'] : f < 0.5 ? ['--no-confirm'] : []), ...G]; }
  else if (x < 0.30) args = ['set', pick(LEAVES), r() < 0.7 ? '--confirm' : '--no-confirm', ...G];
  else if (x < 0.44) args = ['confirm', 'set', pick([...LEAVES, 'dp']), ...G];
  else if (x < 0.52) args = ['confirm', 'remove', pick(LEAVES), ...G];
  else if (x < 0.72) { const ns = r() < 0.5; args = ['rename', pick(ns ? SPACES : LEAVES), pick(ns ? SPACES : [...LEAVES, 'tmp.deploy', 'tmp.x']), ...G]; }
  else if (x < 0.82) args = ['remove', pick(r() < 0.3 ? SPACES : LEAVES), '-f', ...G];
  else if (x < 0.92) { const ns = r() < 0.3; args = ['copy', pick(ns ? SPACES : LEAVES), pick(ns ? SPACES : [...LEAVES, 'tmp.build']), '-f', ...G]; }
  else args = ['alias', 'set', 'dp', pick(LEAVES), ...G];
  return { where, args };
}

function world(root) {
  fs.rmSync(root, { recursive: true, force: true });
  for (const d of ['p1', 'p2', 'outside', 'data']) fs.mkdirSync(path.join(root, d), { recursive: true });
}
function cli(dist, root, where, args) {
  const env = { ...process.env, RVR_DATA_DIR: path.join(root, 'data'), RVR_AGENT_NAME: 'fuzz' };
  delete env.RVR_SESSION; delete env.RVR_NO_PROJECT; delete env.RVR_PROJECT; delete env.RVR_OUTPUT;
  const p = spawnSync('bun', [path.join(dist, 'index.js'), ...args], { cwd: path.join(root, where), env, input: '', encoding: 'utf8' });
  return p.status;
}
function probe(dist, root, where) {
  const env = { ...process.env, RVR_DATA_DIR: path.join(root, 'data') };
  delete env.RVR_SESSION; delete env.RVR_NO_PROJECT; delete env.RVR_PROJECT; delete env.RVR_OUTPUT;
  const p = spawnSync('bun', [PROBE, dist, JSON.stringify(PROBE_KEYS)], { cwd: path.join(root, where), env, input: '', encoding: 'utf8' });
  try { return JSON.parse(p.stdout.trim().split('\n').pop()); } catch { return { ERROR: p.stderr.slice(0, 300) }; }
}
function entries(root) {
  const out = [];
  for (const d of ['p1/.reverie', 'p2/.reverie', 'data/store']) {
    const dir = path.join(root, d);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).sort()) {
      if (!f.endsWith('.json') || f.startsWith('_')) continue;
      if (/^(context|conventions)\./.test(f)) continue;   // init scaffolding
      let v; try { v = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).value; } catch { v = '<unparseable>'; }
      out.push(`${d}/${f}=${JSON.stringify(v)}`);
    }
  }
  return out.join('\n');
}
const flags = root => ['p1/.reverie', 'p2/.reverie', 'data/store'].map(d => { try { return `${d.split('/')[0]}:${fs.readFileSync(path.join(root, d, '_confirm.json'), 'utf8').replace(/\s+/g, '')}`; } catch { return `${d.split('/')[0]}:-`; } }).join(' ');

let found = 0, entryDiffs = 0;
const classes = {};
for (let t = 0; t < TRIALS; t++) {
  const r = rng(SEED * 100003 + t);
  const mRoot = path.join(workDir, 'main'), hRoot = path.join(workDir, 'head');
  world(mRoot); world(hRoot);
  for (const p of ['p1', 'p2']) { cli(mainDist, mRoot, p, ['init', '--no-scan', '--no-claude', '--no-agents']); cli(headDist, hRoot, p, ['init', '--no-scan', '--no-claude', '--no-agents']); }
  const n = 4 + Math.floor(r() * (MAXOPS - 3));
  const log = [];
  let refusal = false, nsRename = false;
  for (let i = 0; i < n; i++) {
    const op = genOp(r);
    const m = cli(mainDist, mRoot, op.where, op.args), h = cli(headDist, hRoot, op.where, op.args);
    const settingFlag = (op.args[0] === 'confirm' && op.args[1] === 'set') || (op.args[0] === 'set' && op.args.includes('--confirm') && op.args.length <= 4 && !VALUES.includes(op.args[2]));
    if (settingFlag && m === 0 && h !== 0) refusal = true;
    if (op.args[0] === 'rename' && SPACES.includes(op.args[1]) && m === 0) nsRename = true;
    log.push(`[${op.where}] rvr ${op.args.map(a => /[^\w.\-]/.test(a) ? JSON.stringify(a) : a).join(' ')}   (exit main=${m} head=${h})`);
  }
  const em = entries(mRoot), eh = entries(hRoot);
  if (em !== eh) { entryDiffs++; console.log(`### trial ${t}: ENTRY FILES DIFFER between builds\n${log.join('\n')}\n--main--\n${em}\n--head--\n${eh}\n`); }
  const hits = [];
  for (const where of ['p1', 'p2', 'outside']) {
    const pm = probe(mainDist, mRoot, where), ph = probe(headDist, hRoot, where);
    for (const id of Object.keys(pm)) if (pm[id] === 'GATED' && ph[id] !== 'GATED') hits.push(`${where}|${id}: main=${pm[id]} head=${ph[id]}`);
  }
  if (hits.length) {
    found++;
    const cls = refusal && nsRename ? 'refusal+nsRename' : refusal ? 'refusal' : nsRename ? 'nsRename' : 'NEITHER';
    classes[cls] = (classes[cls] ?? 0) + 1;
    console.log(`### trial ${t} [${cls}]: main gates, head does not:\n  ${hits.join('\n  ')}\n${log.join('\n')}\n  main flags: ${flags(mRoot)}\n  head flags: ${flags(hRoot)}\n`);
  }
}
console.log(`done: ${TRIALS} trials, seed ${SEED}; trials with a main-gated/head-ungated key: ${found} ${JSON.stringify(classes)}; entry-file differences: ${entryDiffs}`);
