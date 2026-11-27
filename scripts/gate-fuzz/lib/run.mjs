// Run one world's invocations on a build and judge each one.
import { cliArgs } from './gen.mjs';
import { runCli, runMcpSession } from './drive.mjs';
import { diffLines, judge, judgeWrite, isRead } from './oracle.mjs';
import { buildWorld, flagLists, leftovers, snapshot } from './world.mjs';

/**
 * Store invariants after an invocation: the stores byte-identical to the
 * world as built (no run writes the store, refused and failed ones least of
 * all), an even `_epoch.json`, no lock left.
 */
function storeCheck(root, baseline) {
  const problems = leftovers(root);
  const now = snapshot(root);
  if (now !== baseline) problems.push(`stores changed:\n${diffLines(baseline, now)}`);
  return problems;
}


/**
 * Run the invocations of `spec` (all of them, or those in `only`) on the
 * build in `dist`, in a world built under `root`. Returns one record per
 * invocation run: { i, inv, res, violations }.
 */
export async function runWorld(spec, dist, root, { cacheDir, only } = {}) {
  buildWorld(root, spec);
  const baseline = snapshot(root);
  const out = [];
  const wanted = i => !only || only.has(i);
  for (const [i, inv] of spec.invocations.entries()) {
    if (inv.surface !== 'cli' || inv.kind === 'write' || !wanted(i)) continue;
    const res = runCli(dist, root, inv.cwd, cliArgs(inv), { mode: inv.mode, cacheDir });
    const store = storeCheck(root, baseline);
    out.push({ i, inv, res, violations: judge(root, spec, inv, res, store) });
    if (store.length) buildWorld(root, spec);   // later invocations start from the world as specified
  }
  for (const cwd of ['proj', 'out']) {
    const idx = spec.invocations.map((inv, i) => [inv, i]).filter(([inv, i]) => inv.surface === 'mcp' && inv.kind !== 'write' && inv.cwd === cwd && wanted(i)).map(([, i]) => i);
    if (idx.length === 0) continue;
    const local = new Map(idx.map((g, l) => [g, l]));
    const calls = idx.map(g => {
      const inv = spec.invocations[g];
      const token = inv.token && typeof inv.token === 'object' ? (local.has(inv.token.from) ? { from: local.get(inv.token.from) } : undefined) : inv.token;
      return { tool: inv.tool, args: inv.args, ...(token ? { token } : {}) };
    });
    let dirty = false;
    const results = await runMcpSession(dist, root, cwd, calls, {
      cacheDir,
      after: () => (dirty ? [] : storeCheck(root, baseline)),
    });
    for (const [l, res] of results.entries()) {
      const g = idx[l];
      const inv = spec.invocations[g];
      if (dirty) { out.push({ i: g, inv, res, violations: [], skipped: 'an earlier call in this session changed the stores' }); continue; }
      out.push({ i: g, inv, res, violations: judge(root, spec, inv, res, res.store) });
      if (res.store.length) { dirty = true; buildWorld(root, spec); }
    }
  }
  await runWrites(spec, dist, root, out, wanted, cacheDir);
  out.sort((a, b) => a.i - b.i);
  return out;
}

/** The writes, in order, after every run; each judged against the stores just before it. */
async function runWrites(spec, dist, root, out, wanted, cacheDir) {
  const writes = spec.invocations.map((inv, i) => [inv, i]).filter(([inv, i]) => inv.kind === 'write' && wanted(i));
  if (writes.length === 0) return;
  buildWorld(root, spec);
  for (const [inv, i] of writes) {
    const before = snapshot(root), flagsBefore = flagLists(root);
    let res;
    if (inv.surface === 'cli') {
      res = runCli(dist, root, inv.cwd, inv.argv, { mode: 'json', cacheDir });
    } else {
      [res] = await runMcpSession(dist, root, inv.cwd, [{ tool: inv.tool, args: inv.args }], { cacheDir });
    }
    out.push({ i, inv, res, violations: judgeWrite(inv, res, before, snapshot(root), flagsBefore, flagLists(root), leftovers(root)) });
  }
}

/**
 * What invocation `k` needs to have run before it to replay the same way: a
 * token redeem needs the call that issued the token (and any earlier redeem
 * of it); a write needs the writes before it, which it compounds on. A CLI
 * run and an MCP call without a token stand alone.
 */
export function prerequisites(spec, k) {
  const inv = spec.invocations[k];
  if (inv.kind === 'write') return spec.invocations.map((x, i) => i).filter(i => i < k && spec.invocations[i].kind === 'write');
  if (inv.surface === 'mcp' && inv.token && typeof inv.token === 'object') {
    const from = inv.token.from;
    return [from, ...spec.invocations.map((x, i) => i).filter(i => i < k && i !== from && spec.invocations[i].token?.from === from)].sort((a, b) => a - b);
  }
  return [];
}

/** A copy of `spec` holding only the invocations at `indexes`, token references renumbered. */
export function subsetSpec(spec, indexes) {
  const map = new Map(indexes.map((g, l) => [g, l]));
  const invocations = indexes.map(g => {
    const inv = JSON.parse(JSON.stringify(spec.invocations[g]));
    if (inv.token && typeof inv.token === 'object') inv.token = map.has(inv.token.from) ? { from: map.get(inv.token.from) } : 'bogus';
    return inv;
  });
  return { ...spec, invocations };
}

/** Counters that show what the generator reached on this build. */
export function tally(stats, records, spec) {
  stats.worlds = (stats.worlds ?? 0) + 1;
  const irregular = ['project', 'global'].some(s => ['aliases', 'confirm'].some(k => spec.stores[s][k]?.$irregular));
  if (irregular) stats.irregularWorlds = (stats.irregularWorlds ?? 0) + 1;
  for (const { inv, res } of records) {
    stats.invocations = (stats.invocations ?? 0) + 1;
    const surface = `${inv.surface}${inv.kind === 'write' ? '-write' : isRead(inv) ? '-read' : ''}`;
    const k = `${surface}:${res.kind}`;
    stats.kinds ??= {};
    stats.kinds[k] = (stats.kinds[k] ?? 0) + 1;
    const msg = res.message ?? '';
    const bump = name => { stats.coverage ??= {}; stats.coverage[name] = (stats.coverage[name] ?? 0) + 1; };
    if (/depth limit exceeded/.test(msg)) bump('depth-limit');
    if (/Circular interpolation/.test(msg)) bump('cycle');
    if (res.unchecked) bump('ask: not every reference checked');
    if (/printed shell syntax/.test(msg)) bump('exec output refused');
    if (/takes its key from/.test(msg)) bump('$(${…}) refused');
    if (res.kind === 'ran' && res.markers.length) bump('ran something');
    if (res.kind === 'ask' && inv.surface === 'mcp' && res.code === 'REQUIRES_CONFIRMATION') bump('mcp asks');
    if (inv.surface === 'mcp' && res.approved) bump('mcp approved by token/force');
    if (inv.surface === 'cli' && inv.chain) bump(`cli chain:${res.kind}`);
    if (inv.surface === 'mcp' && inv.args.chain) bump(`mcp chain:${res.kind}`);
  }
}

