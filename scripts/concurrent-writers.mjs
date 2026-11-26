#!/usr/bin/env bun
// Acceptance check for #254: concurrent `rvr` writers must not delete each
// other's entries and flags. Spawns real CLI processes in parallel against
// one store and counts what survives. Not part of `bun run test`: it takes
// a while and needs a built dist.
//
// usage: bun scripts/concurrent-writers.mjs <dist> [trials=10]
//
// Scenarios (each trial starts from a fresh temp data dir, global store):
//   sets+confirm  8 parallel `set n.k$i v` + 3 parallel `confirm set ops.deploy`
//                 -> how many of the 8 entries are kept, and is ops.deploy flagged
//   flags         12 parallel `confirm set` of distinct (existing) keys
//                 -> how many of the 12 flags are kept
//   full-save     8 parallel `set n.k$i v` racing a `remove`, a namespace `copy`
//                 and a namespace `rename` (each a full entry save)
//                 -> how many of the 8 entries are kept, and did the three land
//
// Every child gets closed stdin and an explicit env (bun's child_process does
// not pass runtime process.env mutations otherwise).
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const [distArg, trialsArg] = process.argv.slice(2);
if (!distArg) {
  console.error('usage: bun scripts/concurrent-writers.mjs <dist> [trials=10]');
  process.exit(2);
}
const CLI = path.join(path.resolve(distArg), 'index.js');
const TRIALS = Number(trialsArg ?? 10);

function envFor(dataDir) {
  const env = { ...process.env, RVR_DATA_DIR: dataDir, RVR_NO_PROJECT: '1', RVR_AGENT_NAME: 'concurrent-writers', RVR_TEST: '1' };
  delete env.RVR_SESSION; delete env.RVR_PROJECT; delete env.RVR_OUTPUT;
  return env;
}

function runSync(dataDir, args) {
  const p = spawnSync('bun', [CLI, ...args, '-G'], { env: envFor(dataDir), stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  if (p.status !== 0) throw new Error(`seed failed: rvr ${args.join(' ')}: ${p.stderr}`);
}

/** Start every command at once; resolve with each one's exit code and stderr. */
function runParallel(dataDir, commands) {
  return Promise.all(commands.map(args => new Promise(resolve => {
    const child = spawn('bun', [CLI, ...args, '-G'], { env: envFor(dataDir), stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', d => { stderr += d; });
    child.stdout.on('data', () => {});
    child.on('close', code => resolve({ args, code, stderr: stderr.trim() }));
  })));
}

function storeState(dataDir) {
  const dir = path.join(dataDir, 'store');
  const entries = new Set();
  for (const f of fs.readdirSync(dir)) {
    if (f.endsWith('.json') && !f.startsWith('_')) entries.add(f.slice(0, -5));
  }
  let confirm = {};
  try { confirm = JSON.parse(fs.readFileSync(path.join(dir, '_confirm.json'), 'utf8')); } catch { /* none */ }
  return { entries, confirm };
}

const scenarios = {
  'sets+confirm': {
    seed: dd => runSync(dd, ['set', 'ops.deploy', 'true']),
    commands: () => [
      ...Array.from({ length: 8 }, (_, i) => ['set', `n.k${i}`, 'v']),
      ...Array.from({ length: 3 }, () => ['confirm', 'set', 'ops.deploy']),
    ],
    check: s => {
      const kept = Array.from({ length: 8 }, (_, i) => `n.k${i}`).filter(k => s.entries.has(k)).length;
      return { kept, of: 8, extra: s.confirm['ops.deploy'] === true ? '' : 'ops.deploy UNFLAGGED' };
    },
  },
  flags: {
    seed: dd => { for (let i = 0; i < 12; i++) runSync(dd, ['set', `f.k${i}`, 'true']); },
    commands: () => Array.from({ length: 12 }, (_, i) => ['confirm', 'set', `f.k${i}`]),
    check: s => ({ kept: Array.from({ length: 12 }, (_, i) => `f.k${i}`).filter(k => s.confirm[k] === true).length, of: 12, extra: '' }),
  },
  'full-save': {
    seed: dd => {
      runSync(dd, ['set', 'gone.x', '1']);
      runSync(dd, ['set', 'src.a', '1']); runSync(dd, ['set', 'src.b', '2']);
      runSync(dd, ['set', 'ren.a', '1']); runSync(dd, ['set', 'ren.b', '2']);
    },
    commands: () => [
      ...Array.from({ length: 8 }, (_, i) => ['set', `n.k${i}`, 'v']),
      ['remove', 'gone.x', '-f'],
      ['copy', 'src', 'dst', '-f'],
      ['rename', 'ren', 'moved'],
    ],
    check: s => {
      const kept = Array.from({ length: 8 }, (_, i) => `n.k${i}`).filter(k => s.entries.has(k)).length;
      const wrong = [];
      if (s.entries.has('gone.x')) wrong.push('gone.x not removed');
      if (!s.entries.has('dst.a') || !s.entries.has('dst.b')) wrong.push('copy missing');
      if (!s.entries.has('moved.a') || !s.entries.has('moved.b') || s.entries.has('ren.a')) wrong.push('rename incomplete');
      if (!s.entries.has('src.a') || !s.entries.has('src.b')) wrong.push('copy source lost');
      return { kept, of: 8, extra: wrong.join(', ') };
    },
  },
};

console.log(`dist: ${CLI}`);
console.log(`trials per scenario: ${TRIALS}`);
let anyLoss = false, anyFail = false;
for (const [name, sc] of Object.entries(scenarios)) {
  let keptTotal = 0, ofTotal = 0, lossyTrials = 0, nonZero = 0;
  const notes = new Map();
  for (let t = 0; t < TRIALS; t++) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rvr-cw-'));
    try {
      sc.seed(dataDir);
      const results = await runParallel(dataDir, sc.commands());
      for (const r of results) {
        if (r.code !== 0) {
          nonZero++;
          const line = `exit ${r.code}: rvr ${r.args.join(' ')}: ${r.stderr.split('\n')[0]}`;
          notes.set(line, (notes.get(line) ?? 0) + 1);
        }
      }
      const { kept, of, extra } = sc.check(storeState(dataDir));
      keptTotal += kept; ofTotal += of;
      if (kept < of || extra) lossyTrials++;
      if (extra) notes.set(extra, (notes.get(extra) ?? 0) + 1);
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  }
  if (keptTotal < ofTotal) anyLoss = true;
  if (nonZero > 0) anyFail = true;
  console.log(`\n${name}: kept ${keptTotal}/${ofTotal} (lost ${ofTotal - keptTotal}); trials with a loss: ${lossyTrials}/${TRIALS}; non-zero exits: ${nonZero}`);
  for (const [note, count] of notes) console.log(`  ${count}x ${note}`);
}
console.log(`\nresult: ${anyLoss ? 'LOSS' : 'no loss'}, ${anyFail ? 'some commands failed' : 'every command exited 0'}`);
process.exitCode = anyLoss || anyFail ? 1 : 0;
