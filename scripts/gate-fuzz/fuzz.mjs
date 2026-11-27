#!/usr/bin/env bun
// End-to-end fuzzer for the run-confirmation gate (#290). Drives the built
// CLI and MCP server in random two-store worlds and scores each invocation on
// what actually ran. See README.md in this directory.
//
//   bun scripts/gate-fuzz/fuzz.mjs [--quick | --long] [options]
//
//   --dist <dir>       build under test (default: dist)
//   --seed <n>         seed (default 1); world i of seed n is always the same world
//   --worlds <n>       number of worlds (quick: 300, long: 3000)
//   --start <i>        first world index (default 0)
//   --jobs <n>         parallel workers (default: min(cores, 8))
//   --world <i>        run one world (replay), printing every invocation
//   --inv <k>          with --world/--replay: only invocation k
//   --replay <file>    run a world spec saved by an earlier run
//   --against <dir>    differential: also run each world on this build and
//                      report invocations it asks about and the build under test runs
//   --fixtures         run only the hand-written worlds in fixtures/ (they always
//                      run first otherwise)
//   --report <file>    write the violations and counters as JSON
//   --no-shrink        don't shrink failing worlds
//   --out <dir>        where failing world specs go (default: a temp dir, printed)
//   --keep             keep the worlds' temp directories
//   --print-spec       with --world/--replay: also print the world spec (JSON)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { killChildren } from './lib/drive.mjs';
import { generateWorld } from './lib/gen.mjs';
import { prerequisites, runWorld, subsetSpec, tally } from './lib/run.mjs';
import { assertSafeRoot, validateSpec } from './lib/world.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const QUICK_WORLDS = 300;
const LONG_WORLDS = 3000;

const usage = msg => Object.assign(new Error(msg), { usage: true });

function parseArgs(argv) {
  const o = { dist: 'dist', seed: 1, start: 0, shrink: true, keep: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => { if (i + 1 >= argv.length) throw usage(`${a} needs a value`); return argv[++i]; };
    // A number argument must be a whole number: `--worlds abc` running 0 worlds green is worse than an error.
    const num = (min = 0) => {
      const v = val();
      const n = Number(v);
      if (!/^\d+$/.test(v) || !Number.isSafeInteger(n) || n < min) throw usage(`${a} takes a whole number${min ? ` of at least ${min}` : ''}, not ${JSON.stringify(v)}`);
      return n;
    };
    switch (a) {
      case '--quick': o.worlds ??= QUICK_WORLDS; break;
      case '--long': o.worlds ??= LONG_WORLDS; break;
      case '--dist': o.dist = val(); break;
      case '--seed': o.seed = num(0); break;
      case '--worlds': o.worlds = num(1); break;
      case '--start': o.start = num(0); break;
      case '--jobs': o.jobs = num(1); break;
      case '--world': o.world = num(0); break;
      case '--inv': o.inv = num(0); break;
      case '--replay': o.replay = val(); break;
      case '--against': o.against = val(); break;
      case '--no-shrink': o.shrink = false; break;
      case '--fixtures': o.fixturesOnly = true; break;
      case '--report': o.report = val(); break;
      case '--out': o.out = val(); break;
      case '--keep': o.keep = true; break;
      case '--print-spec': o.printSpec = true; break;
      case '--worker': o.worker = true; break;
      case '--stride': o.stride = num(1); break;
      case '--work': o.work = val(); break;
      case '--cache': o.cache = val(); break;
      case '-h': case '--help':
        console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter(l => l.startsWith('//')).slice(0, 23).map(l => l.slice(3)).join('\n'));
        process.exit(0);
        break;
      default: throw usage(`unknown argument ${a}`);
    }
  }
  o.worlds ??= QUICK_WORLDS;
  o.dist = path.resolve(o.dist);
  if (o.against) o.against = path.resolve(o.against);
  for (const d of [o.dist, o.against].filter(Boolean)) {
    if (!fs.existsSync(path.join(d, 'index.js')) || !fs.existsSync(path.join(d, 'mcp-server.js'))) throw new Error(`${d} is not a build: run \`bun run build\` (it needs index.js and mcp-server.js)`);
  }
  return o;
}

const shown = d => { const rel = path.relative(REPO, d); return rel && !rel.startsWith('..') ? rel : d; };
const replayCmd = (o, extra) => `bun scripts/gate-fuzz/fuzz.mjs --dist ${shown(o.dist)} ${extra}`;

/** One world on the build under test (and on --against, if given). Returns a JSON-able record. */
async function doWorld(o, spec, work) {
  const root = path.join(work, `w${spec.index}`);
  // --inv k replays k, and what it depends on (its token's issuer, the writes before it); only k is judged and shown.
  const only = o.inv === undefined ? undefined : new Set([...prerequisites(spec, o.inv), o.inv]);
  const records = (await runWorld(spec, o.dist, root, { cacheDir: o.cache, only })).filter(r => o.inv === undefined || r.i === o.inv);
  const stats = {};
  tally(stats, records, spec);
  const violations = records.filter(r => r.violations.length).map(r => ({
    world: spec.index, inv: r.i, invocation: r.inv,
    result: { kind: r.res.kind, code: r.res.code, markers: r.res.markers, message: (r.res.message ?? '').slice(0, 300) },
    rules: [...new Set(r.violations.map(x => x.rule))], details: r.violations,
  }));
  const diffs = [];
  if (o.against) {
    const other = (await runWorld(spec, o.against, `${root}-against`, { cacheDir: o.cache, only })).filter(r => o.inv === undefined || r.i === o.inv);
    const byI = new Map(other.map(r => [r.i, r]));
    for (const r of records) {
      const b = byI.get(r.i);
      const approved = r.inv.surface === 'cli' ? r.inv.yes : r.res.approved;
      if (b && !approved && b.res.kind === 'ask' && r.res.kind !== 'ask' && r.res.markers.length) {
        diffs.push({ world: spec.index, inv: r.i, invocation: r.inv, this: { kind: r.res.kind, markers: r.res.markers }, other: { kind: b.res.kind, message: b.res.message.slice(0, 200) } });
      }
    }
    if (!o.keep) fs.rmSync(`${root}-against`, { recursive: true, force: true });
  }
  if (!o.keep) fs.rmSync(root, { recursive: true, force: true });
  return { stats, violations, diffs, records: o.world !== undefined || o.replay ? records : undefined };
}

// The rules that need no model, or one lookup: a shrunk world must still fire every one the violation fired.
const PRIMARY = new Set(['R1-flagged-entry', 'R2-typed-name', 'R4-confinement', 'R6-unreadable-list', 'R7-exec-on-read', 'R8-store', 'R9-flag-kept']);

/** Greedy shrink: drop entries, aliases, flags, irregular sidecars and references while the same rules still fire. */
async function shrink(o, spec, invIndex, rules, work) {
  // The invocation runs last, after what it depends on; only it is judged.
  const base = subsetSpec(spec, [...prerequisites(spec, invIndex), invIndex]);
  const target = base.invocations.length - 1;
  const keep = rules.filter(r => PRIMARY.has(r));
  if (keep.length === 0) keep.push(rules[0]);
  const still = async s => {
    const recs = await runWorld(s, o.dist, path.join(work, `shrink${spec.index}`), { cacheDir: o.cache });
    const fired = new Set(recs.find(r => r.i === target)?.violations.map(v => v.rule) ?? []);
    return keep.every(r => fired.has(r));
  };
  if (!(await still(base))) return null;   // does not replay on its own: no shrunk world
  let cur = JSON.parse(JSON.stringify(base));
  let attempts = 0;
  const steps = s => {
    const out = [];
    for (const st of ['project', 'global']) {
      for (const k of Object.keys(s.stores[st].entries)) out.push(x => { delete x.stores[st].entries[k]; });
      for (const side of ['aliases', 'confirm']) {
        const m = s.stores[st][side];
        if (m?.$irregular) out.push(x => { x.stores[st][side] = {}; });
        else for (const k of Object.keys(m ?? {})) out.push(x => { delete x.stores[st][side][k]; });
      }
      for (const [k, v] of Object.entries(s.stores[st].entries)) {
        const refs = v.match(/\$\{[^}]*\}|\$\([^)]*\)/g) ?? [];
        for (const ref of new Set(refs)) out.push(x => { x.stores[st].entries[k] = v.replace(ref, '').replace(/ {2,}/g, ' '); });
      }
    }
    return out;
  };
  let progress = true;
  while (progress && attempts < 250) {
    progress = false;
    for (const step of steps(cur)) {
      if (attempts++ >= 250) break;
      const next = JSON.parse(JSON.stringify(cur));
      step(next);
      if (await still(next)) { cur = next; progress = true; break; }
    }
  }
  fs.rmSync(path.join(work, `shrink${spec.index}`), { recursive: true, force: true });
  return { spec: cur, inv: target };
}

function printViolation(o, v, shrunkFile) {
  const inv = v.invocation;
  const what = inv.kind === 'write'
    ? (inv.surface === 'cli' ? `cli ${inv.cwd} rvr ${inv.argv.join(' ')} (write)` : `mcp ${inv.cwd} ${inv.tool} ${JSON.stringify(inv.args)} (write)`)
    : inv.surface === 'cli'
    ? `cli ${inv.cwd} [${inv.mode}] rvr ${[...(inv.global ? ['-G'] : []), ...(inv.chain ? ['--chain'] : []), ...inv.keys].join(' ')}${inv.yes ? ' --yes' : ''}${inv.kind !== 'run' ? ` (${inv.kind})` : ''}`
    : `mcp ${inv.cwd} ${inv.tool} ${JSON.stringify(inv.args)}${inv.token ? ` token=${JSON.stringify(inv.token)}` : ''}`;
  console.log(`\nVIOLATION world ${v.world} inv ${v.inv} [${v.rules.join(', ')}] ${what}`);
  console.log(`  result: ${v.result.kind} ${v.result.code}; ran markers ${JSON.stringify(v.result.markers)}`);
  for (const d of v.details) console.log(`  ${d.rule}: ${d.detail}`);
  console.log(`  replay: ${replayCmd(o, o.replay ? `--replay ${o.replay} --inv ${v.inv}` : `--seed ${o.seed} --world ${v.world} --inv ${v.inv}`)}`);
  if (shrunkFile) console.log(`  shrunk: ${replayCmd(o, `--replay ${shrunkFile} --inv ${v.shrunkInv ?? 0}`)}`);
}

function mergeStats(into, s) {
  for (const [k, v] of Object.entries(s)) {
    if (typeof v === 'number') into[k] = (into[k] ?? 0) + v;
    else { into[k] ??= {}; for (const [k2, v2] of Object.entries(v)) into[k][k2] = (into[k][k2] ?? 0) + v2; }
  }
}

// Shrinking costs one world build and one invocation per attempt: one
// violation per rule set per world, and a few per worker, is plenty.
const SHRINKS_PER_WORKER = 6;

async function worker(o) {
  // A signal (Ctrl-C reaches the whole group; the parent sends SIGTERM) ends
  // the worker and its MCP servers at once, so it recreates no world while
  // the parent removes the work directory.
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { killChildren(); process.exit(130); });
  const work = o.work;
  let shrinks = 0;
  for (let i = o.start; i < o.start + o.worlds; i += o.stride) {
    const spec = generateWorld(o.seed, i);
    const rec = await doWorld(o, spec, work);
    const seen = new Set();
    for (const v of rec.violations) {
      const ruleSet = v.rules.join(',');
      if (!o.shrink || !o.out || seen.has(ruleSet) || shrinks >= SHRINKS_PER_WORKER) continue;
      seen.add(ruleSet);
      shrinks++;
      const small = await shrink(o, spec, v.inv, v.rules, work);
      if (small) {
        fs.mkdirSync(o.out, { recursive: true });   // created at the first failure, not before
        const file = path.join(o.out, `seed${o.seed}-world${spec.index}-inv${v.inv}.json`);
        fs.writeFileSync(file, JSON.stringify(small.spec, null, 2));
        v.shrunk = file;
        v.shrunkInv = small.inv;
      }
    }
    process.stdout.write(JSON.stringify({ world: i, stats: rec.stats, violations: rec.violations, diffs: rec.diffs }) + '\n');
  }
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.worker) return worker(o);

  const work = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'rvr-gate-fuzz-'));
  assertSafeRoot(work);
  o.cache = path.join(work, 'bun-cache');
  const started = Date.now();
  const children = new Set();
  const stopAll = () => { for (const c of children) c.kill('SIGTERM'); };
  // The failures directory is made only when a failure is written; its name
  // shares the work directory's random suffix.
  const out = o.out ? path.resolve(o.out) : path.join(path.dirname(work), `rvr-gate-fuzz-failures-${path.basename(work).slice('rvr-gate-fuzz-'.length)}`);
  const cleanup = () => {
    if (!o.keep) fs.rmSync(work, { recursive: true, force: true });
    if (!o.out) { try { fs.rmdirSync(out); } catch { /* absent, or holds failures */ } }
  };
  let stopping = false;
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, async () => {
      if (stopping) return;
      stopping = true;
      stopAll();
      killChildren();
      // Wait for the workers to exit before removing what they write into.
      const deadline = Date.now() + 10_000;
      while (children.size && Date.now() < deadline) await new Promise(r => setTimeout(r, 50));
      cleanup();
      process.exit(130);
    });
  }
  try {
    // One world, every invocation printed: for replaying a reported violation.
    if (o.world !== undefined || o.replay) {
      const spec = validateSpec(o.replay ? JSON.parse(fs.readFileSync(o.replay, 'utf8')) : generateWorld(o.seed, o.world));
      if (o.inv !== undefined && !(Number.isInteger(o.inv) && o.inv >= 0 && o.inv < spec.invocations.length)) throw new Error(`--inv ${o.inv}: this world has invocations 0..${spec.invocations.length - 1}`);
      const rec = await doWorld(o, spec, work);
      for (const r of rec.records) {
        const tag = r.violations.length ? `  <-- ${r.violations.map(v => v.rule).join(', ')}` : '';
        console.log(`#${r.i} ${JSON.stringify(r.inv)}\n    ${r.res.kind} ${r.res.code} ran=${JSON.stringify(r.res.markers)} ${(r.res.message ?? '').replace(/\s+/g, ' ').slice(0, 160)}${tag}`);
        for (const v of r.violations) console.log(`    ${v.rule}: ${v.detail}`);
      }
      for (const d of rec.diffs) console.log(`DIFF inv ${d.inv}: the other build asks, this one ran ${JSON.stringify(d.this.markers)}`);
      if (o.printSpec) console.log(JSON.stringify(spec, null, 2));
      process.exitCode = rec.violations.length ? 1 : 0;
      return;
    }

    // The hand-written worlds first: each known hole, as a fixed world.
    const fixtureDir = path.join(HERE, 'fixtures');
    const fixtureViolations = [];
    for (const f of fs.readdirSync(fixtureDir).filter(f => f.endsWith('.json')).sort()) {
      const spec = validateSpec({ ...JSON.parse(fs.readFileSync(path.join(fixtureDir, f), 'utf8')), index: `fixture-${path.basename(f, '.json')}` });
      const rec = await doWorld({ ...o, inv: undefined }, spec, work);
      for (const v of rec.violations) fixtureViolations.push({ ...v, fixture: path.relative(REPO, path.join(fixtureDir, f)) });
    }
    console.log(`gate-fuzz: fixtures: ${fs.readdirSync(fixtureDir).filter(f => f.endsWith('.json')).length} worlds, ${fixtureViolations.length} violations`);
    for (const v of fixtureViolations) printViolation({ ...o, replay: v.fixture }, v);
    if (o.fixturesOnly) {
      process.exitCode = fixtureViolations.length ? 1 : 0;
      if (o.report) fs.writeFileSync(o.report, JSON.stringify({ fixtures: fixtureViolations }, null, 2));
      return;
    }

    const jobs = Math.max(1, Math.min(o.jobs ?? Math.min(os.availableParallelism?.() ?? os.cpus().length, 8), o.worlds));
    console.log(`gate-fuzz: ${o.worlds} worlds from index ${o.start}, seed ${o.seed}, ${jobs} jobs, build ${o.dist}${o.against ? `, against ${o.against}` : ''}`);
    const stats = {};
    const violations = [];
    const diffs = [];
    let done = 0;
    await Promise.all(Array.from({ length: jobs }, (_, k) => new Promise((resolve, reject) => {
      const args = [path.join(HERE, 'fuzz.mjs'), '--worker', '--dist', o.dist, '--seed', String(o.seed), '--start', String(o.start + k), '--worlds', String(Math.max(0, o.worlds - k)), '--stride', String(jobs), '--work', work, '--cache', o.cache, '--out', out];
      if (o.against) args.push('--against', o.against);
      if (!o.shrink) args.push('--no-shrink');
      if (o.keep) args.push('--keep');
      const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'inherit'] });
      children.add(child);
      readline.createInterface({ input: child.stdout }).on('line', line => {
        let rec;
        try { rec = JSON.parse(line); } catch { console.error(line); return; }
        mergeStats(stats, rec.stats);
        violations.push(...rec.violations);
        diffs.push(...rec.diffs);
        done++;
        if (process.stdout.isTTY) process.stdout.write(`\r  ${done}/${o.worlds} worlds, ${violations.length} violations`);
        else if (done % 50 === 0) console.log(`  ${done}/${o.worlds} worlds, ${violations.length} violations, ${Math.round((Date.now() - started) / 1000)}s`);
      });
      child.on('exit', code => { children.delete(child); if (code === 0) resolve(); else if (!stopping) { stopAll(); reject(new Error(`worker ${k} exited with ${code}`)); } });
    })));
    if (process.stdout.isTTY) process.stdout.write('\n');

    violations.sort((a, b) => a.world - b.world || a.inv - b.inv);
    for (const v of violations) printViolation(o, v, v.shrunk);
    for (const d of diffs) console.log(`\nDIFF world ${d.world} inv ${d.inv}: ${o.against} asks, ${o.dist} ran ${JSON.stringify(d.this.markers)} — ${JSON.stringify(d.invocation)}\n  replay: ${replayCmd(o, `--seed ${o.seed} --world ${d.world} --inv ${d.inv} --against ${shown(o.against)}`)}`);
    // R0 exercised: a run in which no unapproved invocation ran anything
    // checked no gate decision at all, whatever the build does.
    if ((stats.worlds ?? 0) >= 20 && !(stats.coverage?.['unapproved runs that ran'] > 0)) {
      const detail = `no unapproved invocation ran anything in ${stats.worlds} worlds: no gate decision was exercised`;
      violations.push({ world: '-', inv: '-', invocation: null, result: {}, rules: ['R0-exercised'], details: [{ rule: 'R0-exercised', detail }] });
      console.log(`\nVIOLATION [R0-exercised] ${detail}`);
    }
    const byRule = {};
    for (const v of violations) for (const r of v.rules) byRule[r] = (byRule[r] ?? 0) + 1;
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    console.log(`\nkinds: ${JSON.stringify(stats.kinds ?? {})}`);
    console.log(`coverage: ${JSON.stringify(stats.coverage ?? {})}`);
    console.log(`worlds with an irregular sidecar: ${stats.irregularWorlds ?? 0}`);
    if (fs.existsSync(out)) console.log(`failing world specs: ${out}`);
    console.log(`done: ${stats.worlds ?? 0} worlds + ${fixtureViolations.length ? `fixtures (${fixtureViolations.length} violations)` : 'fixtures'}, ${stats.invocations ?? 0} invocations, seed ${o.seed}, ${secs}s; violations: ${violations.length} ${JSON.stringify(byRule)}${o.against ? `; other build asks, this one ran: ${diffs.length}` : ''}`);
    if (o.report) fs.writeFileSync(o.report, JSON.stringify({ seed: o.seed, start: o.start, worlds: o.worlds, dist: o.dist, against: o.against, seconds: Number(secs), stats, byRule, fixtures: fixtureViolations, violations, diffs }, null, 2));
    process.exitCode = violations.length || fixtureViolations.length ? 1 : 0;
  } finally {
    if (o.keep) console.log(`worlds kept in ${work}`);
    cleanup();
  }
}

main().catch(err => { console.error(err?.usage || /^invalid world spec/.test(err?.message) ? `gate-fuzz: ${err.message}` : err?.stack ?? String(err)); process.exitCode = 2; });
