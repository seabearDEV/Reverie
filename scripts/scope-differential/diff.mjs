#!/usr/bin/env bun
// Scope differential: which entry does each command act on, on two builds?
// Runs every invocation of lib/worlds.mjs on the build under test and on
// another build, each in a fresh copy of its world at the same path, and
// reports every invocation whose output, store files, or audit/telemetry
// rows differ. See README.md in this directory.
//
//   bun scripts/scope-differential/diff.mjs --against <dist> [options]
//
//   --dist <dir>       build under test (default: dist)
//   --against <dir>    the other build (without it, only --dump is written)
//   --jobs <n>         parallel workers (default: min(cores, 4))
//   --world <names>    only these worlds (comma-separated)
//   --filter <text>    only invocations whose id contains this text
//   --shard <k>/<n>    only the k-th of n equal parts (every n-th invocation),
//                      for parallel CI jobs
//   --report <file>    write every difference as JSON
//   --dump <file>      write every record (both builds) as JSON lines
//   --show <n>         print the first n differences in full (default 30)
//   --work <dir>       work directory (default: a new temp directory)
//   --keep             keep the work directory
//   --expect <module>  a module whose default export names the rule a
//                      difference is expected under (or null): with it,
//                      only unexpected differences fail the run
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { assertSafeRoot } from '../gate-fuzz/lib/world.mjs';
import { compareRecords, runInvocation } from './lib/exec.mjs';
import { WORLDS, allInvocations } from './lib/worlds.mjs';

const SELF = fileURLToPath(import.meta.url);

function parseArgs(argv) {
  const o = { dist: 'dist', show: 30, keep: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => { if (i + 1 >= argv.length) throw new Error(`${a} needs a value`); return argv[++i]; };
    const num = () => { const v = val(); if (!/^\d+$/.test(v)) throw new Error(`${a} takes a whole number, not ${JSON.stringify(v)}`); return Number(v); };
    switch (a) {
      case '--dist': o.dist = val(); break;
      case '--against': o.against = val(); break;
      case '--jobs': o.jobs = num(); break;
      case '--world': o.worlds = val().split(','); break;
      case '--filter': o.filter = val(); break;
      case '--shard': {
        const v = val();
        const m = /^(\d+)\/(\d+)$/.exec(v);
        if (!m || Number(m[1]) < 1 || Number(m[1]) > Number(m[2])) throw new Error(`--shard takes k/n with 1 <= k <= n, not ${JSON.stringify(v)}`);
        o.shard = { k: Number(m[1]), n: Number(m[2]) };
        break;
      }
      case '--report': o.report = val(); break;
      case '--dump': o.dump = val(); break;
      case '--show': o.show = num(); break;
      case '--work': o.work = val(); break;
      case '--keep': o.keep = true; break;
      case '--expect': o.expect = path.resolve(val()); break;
      case '--worker': o.worker = true; break;
      case '--slot': o.slot = num(); break;
      case '--of': o.of = num(); break;
      case '-h': case '--help':
        console.log(fs.readFileSync(SELF, 'utf8').split('\n').filter(l => l.startsWith('//')).slice(0, 24).map(l => l.slice(3)).join('\n'));
        process.exit(0);
        break;
      default: throw new Error(`unknown argument ${a}`);
    }
  }
  o.dist = path.resolve(o.dist);
  if (o.against) o.against = path.resolve(o.against);
  for (const d of [o.dist, o.against].filter(Boolean)) {
    if (!fs.existsSync(path.join(d, 'index.js')) || !fs.existsSync(path.join(d, 'mcp-server.js'))) throw new Error(`${d} is not a build: it needs index.js and mcp-server.js`);
  }
  for (const w of o.worlds ?? []) if (!WORLDS.includes(w)) throw new Error(`unknown world ${w}; known: ${WORLDS.join(' ')}`);
  return o;
}

// --filter is plain text, not a regex: an id is full of regex syntax ('|',
// '{', '('), and the text of an id selects exactly that invocation.
// --shard takes every n-th of what is left, so the parts cover every world.
function selected(o) {
  return allInvocations({ worlds: o.worlds ?? WORLDS })
    .filter(inv => !o.filter || inv.id.includes(o.filter))
    .filter((_, i) => !o.shard || i % o.shard.n === o.shard.k - 1);
}

/**
 * Whether a record shows a value write that landed: `set <name> v.new` on
 * the CLI, `reverie_set` without an alias over MCP. Undefined for any other
 * invocation. A build whose every write is refused (the harness run from a
 * copy, see context.confirmGate) shows no difference from another such build.
 */
function landed(inv, rec) {
  if (inv.surface === 'cli' && inv.argv[0] === 'set' && inv.argv[2] === 'v.new' && !inv.argv.includes('-a')) return rec.result.stdout?.ok === true;
  if (inv.surface === 'mcp' && inv.tool === 'reverie_set' && !inv.args.alias) return !rec.result.isError;
  return undefined;
}

async function worker(o) {
  const root = path.join(o.work, `slot${o.slot}`);
  const cache = path.join(o.work, 'bun-cache');
  const invs = selected(o);
  const expectation = o.expect ? (await import(o.expect)).default : null;
  for (let i = o.slot; i < invs.length; i += o.of) {
    const inv = invs[i];
    // Both builds at the same path, one after the other, each in a fresh world.
    const a = await runInvocation(o.dist, root, inv, cache);
    const b = o.against ? await runInvocation(o.against, root, inv, cache) : undefined;
    const diffs = b ? compareRecords(a, b) : [];
    const expected = expectation && diffs.length ? expectation(inv, a, b, diffs) : null;
    const wrote = landed(inv, a) === undefined ? undefined : [landed(inv, a), b ? landed(inv, b) : null];
    process.stdout.write(JSON.stringify({ i, id: inv.id, diffs, ...(expected ? { expected } : {}), ...(wrote ? { wrote } : {}), ...(o.dump ? { a, b } : {}) }) + '\n');
  }
  fs.rmSync(root, { recursive: true, force: true });
}

function commandOf(id) {
  const [, , rest] = id.split('|');
  const words = rest.split(' ');
  if (words[0] === 'mcp') return `mcp ${words[1]}`;
  const argv = words.slice(1);
  const cmd = ['alias', 'confirm', 'data'].includes(argv[0]) ? `${argv[0]} ${argv[1]}` : argv[0];
  return `cli ${cmd}`;
}

function brief(x) {
  const s = typeof x === 'string' ? x : JSON.stringify(x);
  return s.length > 600 ? `${s.slice(0, 600)}…` : s;
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.worker) return worker(o);

  const invs = selected(o);
  // A filter that matches nothing must not pass as "0 differing".
  if (invs.length === 0) { console.error(`scope differential: no invocation matches${o.filter ? ` --filter ${JSON.stringify(o.filter)}` : ''}${o.worlds ? ` in --world ${o.worlds.join(',')}` : ''}`); process.exit(2); }
  const jobs = Math.max(1, Math.min(o.jobs ?? Math.min(os.cpus().length, 4), invs.length));
  const work = o.work ? path.resolve(o.work) : fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'rvr-scope-diff-'));
  fs.mkdirSync(work, { recursive: true });
  assertSafeRoot(work);
  const started = Date.now();
  console.log(`scope differential: ${invs.length} invocations, ${o.against ? `${o.dist} against ${o.against}` : `recording ${o.dist}`}, ${jobs} jobs, work ${work}`);

  const results = [];
  const dump = o.dump ? fs.createWriteStream(path.resolve(o.dump)) : null;
  const children = new Set();
  const stop = () => { for (const c of children) c.kill('SIGTERM'); };
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { stop(); if (!o.keep) fs.rmSync(work, { recursive: true, force: true }); process.exit(130); });
  await Promise.all(Array.from({ length: jobs }, (_, slot) => new Promise((resolve, reject) => {
    const args = [SELF, '--worker', '--slot', String(slot), '--of', String(jobs), '--work', work, '--dist', o.dist];
    if (o.against) args.push('--against', o.against);
    if (o.worlds) args.push('--world', o.worlds.join(','));
    if (o.filter) args.push('--filter', o.filter);
    if (o.shard) args.push('--shard', `${o.shard.k}/${o.shard.n}`);
    if (o.dump) args.push('--dump', '-');
    if (o.expect) args.push('--expect', o.expect);
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'inherit'] });
    children.add(child);
    readline.createInterface({ input: child.stdout }).on('line', line => {
      const rec = JSON.parse(line);
      if (dump) dump.write(line + '\n');
      results.push({ i: rec.i, id: rec.id, diffs: rec.diffs, expected: rec.expected, wrote: rec.wrote });
      if (results.length % 500 === 0) process.stderr.write(`  ${results.length}/${invs.length}\n`);
    });
    child.on('exit', code => { children.delete(child); code === 0 ? resolve() : reject(new Error(`worker ${slot} exited with ${code}`)); });
  })));
  if (dump) await new Promise(r => dump.end(r));
  if (!o.keep) fs.rmSync(work, { recursive: true, force: true });

  results.sort((x, y) => x.i - y.i);
  const differing = results.filter(r => r.diffs.length > 0);
  const unexpected = differing.filter(r => !r.expected);
  const byRule = {};
  for (const r of differing) if (r.expected) byRule[r.expected] = (byRule[r.expected] ?? 0) + 1;
  const perCommand = {};
  for (const r of results) {
    const c = commandOf(r.id);
    perCommand[c] ??= { invocations: 0, differing: 0 };
    perCommand[c].invocations++;
    if (r.diffs.length) perCommand[c].differing++;
  }
  if (o.report) fs.writeFileSync(path.resolve(o.report), JSON.stringify({ invocations: results.length, differing }, null, 2));

  for (const r of (o.expect ? unexpected : differing).slice(0, o.show)) {
    console.log(`\nDIFF ${r.id}`);
    for (const d of r.diffs) {
      if (d.part === 'files') {
        for (const f of d.files) console.log(`  file ${f.path}: ${f.a} | ${f.b}`);
        console.log(`  sidecars a: ${brief(d.sidecarsA)}\n  sidecars b: ${brief(d.sidecarsB)}`);
      } else {
        console.log(`  ${d.part} a: ${brief(d.a)}\n  ${d.part} b: ${brief(d.b)}`);
      }
    }
  }
  if (o.against) {
    console.log('\nper command (invocations / differing):');
    for (const [c, s] of Object.entries(perCommand).sort()) console.log(`  ${c.padEnd(28)} ${String(s.invocations).padStart(6)} ${String(s.differing).padStart(6)}`);
  }
  if (o.expect) {
    console.log('\nexpected differences, by rule:');
    for (const [rule, n] of Object.entries(byRule).sort()) console.log(`  ${rule.padEnd(60)} ${String(n).padStart(6)}`);
  }
  // The write canary: in a whole run (or a shard of one), some value writes
  // must land on each build, or "0 differing" may mean both refused them all.
  const writes = results.filter(r => r.wrote);
  const landedOn = side => writes.filter(r => r.wrote[side]).length;
  const canary = o.against && !o.filter && !o.worlds && writes.length > 0;
  if (writes.length) console.log(`\nvalue writes that landed: ${landedOn(0)}/${writes.length} on ${o.dist}${o.against ? `, ${landedOn(1)}/${writes.length} on ${o.against}` : ''}`);
  const refusedAll = canary ? [[0, o.dist], [1, o.against]].filter(([side]) => landedOn(side) === 0).map(([, d]) => d) : [];
  for (const d of refusedAll) console.log(`WRITE CANARY: no value write landed on ${d}, so its records prove nothing. Run the harness from the repo, not a copy (context.confirmGate).`);
  const secs = Math.round((Date.now() - started) / 1000);
  console.log(`\n${results.length} invocations, ${differing.length} differing${o.expect ? `, ${unexpected.length} unexpected` : ''} (${secs}s)`);
  if (results.length !== invs.length) { console.log(`MISSING ${invs.length - results.length} invocations`); process.exitCode = 2; }
  else if (refusedAll.length) process.exitCode = 2;
  else if ((o.expect ? unexpected : differing).length > 0) process.exitCode = 1;
}

main().catch(err => { console.error(err.message); process.exit(2); });
