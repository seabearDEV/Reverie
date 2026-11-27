#!/usr/bin/env bun
// Run every gatediff.mjs setup on two builds and compare which runs ask.
//
//   bun scripts/project-differential/run.mjs --dist <dir> --against <dir> [--mode <m,…>] [--work <dir>] [--keep]
//
// --dist is the build under test ("head"), --against the reference ("main").
// Exits 1 when any setup differs, 2 when a setup could not be compared.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertSafeRoot } from '../gate-fuzz/lib/world.mjs';
import { compareRuns } from './compare.mjs';
import { MODES } from './modes.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const o = { dist: 'dist', keep: false };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const val = () => { if (i + 1 >= argv.length) throw new Error(`${argv[i]} needs a value`); return argv[++i]; };
  switch (argv[i]) {
    case '--dist': o.dist = val(); break;
    case '--against': o.against = val(); break;
    case '--mode': o.modes = val().split(','); break;
    case '--work': o.work = val(); break;
    case '--keep': o.keep = true; break;
    default: console.error(`unknown argument ${argv[i]}`); process.exit(2);
  }
}
if (!o.against) { console.error('usage: run.mjs --dist <dir> --against <dir> [--mode <m,…>]'); process.exit(2); }
for (const m of o.modes ?? []) if (!MODES.includes(m)) { console.error(`unknown mode ${m}; known: ${MODES.join(' ')}`); process.exit(2); }
const dist = path.resolve(o.dist), against = path.resolve(o.against);
const work = o.work ? path.resolve(o.work) : fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'rvr-project-diff-'));
fs.mkdirSync(work, { recursive: true });
assertSafeRoot(work);

let differing = 0, broken = 0, total = 0;
for (const mode of o.modes ?? MODES) {
  const outs = [];
  for (const [label, build] of [['main', against], ['head', dist]]) {
    const r = spawnSync(process.execPath, [path.join(HERE, 'gatediff.mjs'), build, mode, path.join(work, `${mode}-${label}`)], { encoding: 'utf8', timeout: 600_000 });
    if (r.status !== 0) { console.log(`[${mode}] ${label} failed (${r.status}): ${(r.stderr || '').slice(0, 300)}`); }
    fs.writeFileSync(path.join(work, `${mode}-${label}.jsonl`), r.stdout ?? '');
    outs.push(r.stdout ?? '');
  }
  const c = compareRuns(outs[0], outs[1]);
  total += c.total;
  if (c.misaligned || c.total === 0) broken++;
  else if (c.diff > 0) differing++;
  console.log(`[${mode}] ${c.total} invocations; ${c.lines[c.lines.length - 1]}`);
  for (const l of c.lines.slice(0, -1).slice(0, 20)) console.log(`  ${l}`);
}
if (!o.keep) fs.rmSync(work, { recursive: true, force: true });
console.log(`\n${(o.modes ?? MODES).length} setups, ${total} invocations: ${differing} setups differ, ${broken} could not be compared`);
process.exit(broken > 0 ? 2 : differing > 0 ? 1 : 0);
