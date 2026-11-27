#!/usr/bin/env bun
// Runs after an alias write, on two builds (#260). The gate fuzzer runs its
// writes after its runs, so a change to what an alias write leaves behind is
// never followed by a run there. This applies one alias write (a rename, an
// alias removal) with a build, then runs every name the write touched on the
// stores that build left: CLI in the default scope and with -G, MCP with scope
// omitted, "global" and "project", from the project. A run that asks on the
// first build and runs on the second is a WEAKENING.
//
//   bun scripts/scope-differential/write-then-run.mjs <first dist> <second dist>
//
// Uses the gate fuzzer's world builder and drivers: temp HOME, RVR_DATA_DIR,
// TMPDIR and cwd under a temp root, PATH=/usr/bin:/bin. Every entry is an echo
// that logs a marker; the runs are not approved, so a flagged one must ask.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildWorld, assertSafeRoot } from '../gate-fuzz/lib/world.mjs';
import { runCli, runMcpSession } from '../gate-fuzz/lib/drive.mjs';

const [mainArg, fixArg] = process.argv.slice(2);
if (!mainArg || !fixArg) { console.error('usage: write-then-run.mjs <first dist> <second dist>'); process.exit(2); }
const mainDist = path.resolve(mainArg), fixDist = path.resolve(fixArg);
const work = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'rvr-write-then-run-'));
assertSafeRoot(work);
const m = n => `echo RVM${n}x >> "$RLOG"`;

const SHAPES = [
  {
    name: 'rename a flagged project entry a global alias points at',
    stores: {
      project: { entries: { pfl: m(1), plain: m(2) }, aliases: { pa: 'pfl' }, confirm: { pfl: true } },
      global: { entries: { gplain: m(3) }, aliases: { ga: 'pfl', gq: 'gplain' }, confirm: {} },
    },
    writes: [{ cli: ['rename', 'pfl', 'pfl2'] }, { mcp: ['reverie_rename', { oldKey: 'pfl', newKey: 'pfl2' }] }],
    names: ['ga', 'pa', 'gq', 'pfl', 'pfl2'],
  },
  {
    name: 'the same, with an unflagged global entry of the same key',
    stores: {
      project: { entries: { pfl: m(1) }, aliases: { pa: 'pfl' }, confirm: { pfl: true } },
      global: { entries: { pfl: m(4), gplain: m(3) }, aliases: { ga: 'pfl', gq: 'gplain' }, confirm: {} },
    },
    writes: [{ cli: ['rename', 'pfl', 'pfl2'] }, { mcp: ['reverie_rename', { oldKey: 'pfl', newKey: 'pfl2' }] }],
    names: ['ga', 'pa', 'gq', 'pfl', 'pfl2'],
  },
  {
    name: 'rename a flagged global entry in the default scope (copied into the project)',
    stores: {
      project: { entries: { plain: m(2) }, aliases: { pg: 'gfl' }, confirm: {} },
      global: { entries: { gfl: m(5) }, aliases: { ga: 'gfl' }, confirm: { gfl: true } },
    },
    writes: [{ cli: ['rename', 'gfl', 'gfl2'] }, { mcp: ['reverie_rename', { oldKey: 'gfl', newKey: 'gfl2' }] }],
    names: ['ga', 'pg', 'gfl', 'gfl2'],
  },
  {
    name: 'remove a project alias that shadows a global alias of a flagged entry',
    stores: {
      project: { entries: { plain: m(2) }, aliases: { x: 'plain', y: 'plain2' }, confirm: {} },
      global: { entries: { gfl: m(5), plain2: m(6) }, aliases: { x: 'gfl', gy: 'gfl' }, confirm: { gfl: true } },
    },
    writes: [{ cli: ['alias', 'remove', 'x'] }, { mcp: ['reverie_remove', { key: 'x', is_alias: true }] }, { mcp: ['reverie_alias_remove', { alias: 'x' }] }],
    names: ['x', 'y', 'gy', 'gfl'],
  },
  {
    name: 'remove a global-only alias of a flagged entry without a scope',
    stores: {
      project: { entries: { plain: m(2) }, aliases: { p: 'plain' }, confirm: {} },
      global: { entries: { gfl: m(5) }, aliases: { x: 'gfl', gy: 'gfl' }, confirm: { gfl: true } },
    },
    writes: [{ cli: ['alias', 'remove', 'x'] }, { mcp: ['reverie_remove', { key: 'x', is_alias: true }] }, { mcp: ['reverie_alias_remove', { alias: 'x' }] }],
    names: ['x', 'p', 'gy', 'gfl'],
  },
];

async function outcomes(dist, root, shape, write) {
  buildWorld(root, { stores: shape.stores });
  let wres;
  if (write.cli) wres = runCli(dist, root, 'proj', write.cli, { mode: 'json' });
  else [wres] = await runMcpSession(dist, root, 'proj', [{ tool: write.mcp[0], args: write.mcp[1] }]);
  const out = { write: `${wres.kind} ${wres.code}`, runs: {} };
  for (const n of shape.names) {
    for (const g of [[], ['-G']]) {
      const r = runCli(dist, root, 'proj', ['run', ...g, n], { mode: 'json' });
      out.runs[`cli run ${g.join(' ')} ${n}`.replace('  ', ' ')] = `${r.kind}${r.markers.length ? ' ' + r.markers.join(',') : ''}`;
    }
  }
  const calls = [];
  for (const n of shape.names) for (const scope of [undefined, 'global', 'project']) calls.push({ tool: 'reverie_run', args: { key: n, ...(scope ? { scope } : {}) } });
  const res = await runMcpSession(dist, root, 'proj', calls);
  for (const [i, c] of calls.entries()) out.runs[`mcp run ${JSON.stringify(c.args)}`] = `${res[i].kind}${res[i].markers.length ? ' ' + res[i].markers.join(',') : ''}`;
  out.aliases = ['proj/.reverie', 'data/store'].map(d => { try { return fs.readFileSync(path.join(root, d, '_aliases.json'), 'utf8').replace(/\s+/g, ''); } catch { return '-'; } });
  return out;
}

let weak = 0, diffs = 0, runs = 0;
for (const [si, shape] of SHAPES.entries()) {
  for (const [wi, write] of shape.writes.entries()) {
    const root = path.join(work, `s${si}w${wi}`);
    const a = await outcomes(mainDist, root, shape, write);
    const b = await outcomes(fixDist, root, shape, write);
    fs.rmSync(root, { recursive: true, force: true });
    console.log(`\n# ${shape.name} — ${write.cli ? 'cli ' + write.cli.join(' ') : 'mcp ' + write.mcp[0] + ' ' + JSON.stringify(write.mcp[1])}`);
    console.log(`  write  main: ${a.write}  P${a.aliases[0]} G${a.aliases[1]}`);
    console.log(`  write  fix:  ${b.write}  P${b.aliases[0]} G${b.aliases[1]}`);
    for (const k of Object.keys(a.runs)) {
      runs++;
      if (a.runs[k] === b.runs[k]) continue;
      diffs++;
      const w = (a.runs[k] !== 'ran' && !a.runs[k].startsWith('ran')) && b.runs[k].startsWith('ran') && a.runs[k].startsWith('ask');
      if (w) weak++;
      console.log(`  ${w ? 'WEAKENING' : 'diff'} ${k}: main=${a.runs[k]} fix=${b.runs[k]}`);
    }
  }
}
fs.rmSync(work, { recursive: true, force: true });
console.log(`\n${runs} runs after a write: ${diffs} differ, ${weak} weakenings`);
process.exit(weak > 0 ? 1 : 0);
