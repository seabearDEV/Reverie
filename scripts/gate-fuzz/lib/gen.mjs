// World and invocation generator. Each world is drawn from a PRNG seeded by
// (seed, world index) only, so a world replays the same whatever the mode,
// the worker count or the worlds around it.
//
// A world spec is plain JSON:
//   { stores: { project: Store, global: Store }, markers: { n: [store, key] }, invocations: [Inv] }
//   Store = { entries: { key: value }, aliases: map | { $irregular, content }, confirm: map | { $irregular, content } }
//
// Every entry's value starts with `echo RVM<n>x`, n unique in the world, and
// sends it to $RLOG, so the log says which entries' text actually ran.
// Entry keys never differ only by case or Unicode form within one store (a
// case-insensitive volume would fold them into one file, a case-sensitive one
// would not); those spellings go into typed names, references, aliases and
// flags instead, where the filesystem decides what they open.

const cp = (...points) => String.fromCodePoint(...points);   // non-ASCII letters from code points: look-alikes stay distinguishable in an editor
const LONG_S = cp(0x17f);   // ſ, which APFS folds onto s

function mix(a, b) {
  let h = Math.imul((a >>> 0) ^ 0x9e3779b9, 0x85ebca6b) ^ (b >>> 0);
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  return (h ^ (h >>> 16)) >>> 0;
}

export function makeRng(seed, index) {
  let a = mix(seed, index);
  const next = () => {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
  for (let k = 0; k < 8; k++) next();
  const r = {
    next,
    chance: p => next() < p,
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: arr => arr[Math.floor(next() * arr.length)],
    weighted: pairs => {
      const total = pairs.reduce((s, [w]) => s + w, 0);
      let x = next() * total;
      for (const [w, v] of pairs) { if ((x -= w) < 0) return v; }
      return pairs[pairs.length - 1][1];
    },
    sample: (arr, n) => {
      const copy = [...arr];
      const out = [];
      while (out.length < n && copy.length) out.push(copy.splice(Math.floor(next() * copy.length), 1)[0]);
      return out;
    },
  };
  return r;
}

// No key is the name of a real program: a chain entry's value runs as a command when it is run plainly.
const BASE_KEYS = ['a', 'b', 'c', 'tp', 'fl', 'fl2', 'sx', 'x', 'n.x', 'n.y', 'ch', 'ch2'];
const VARIANTS = ['A', 'B', 'Fl', 'FL', 'Sx', `${LONG_S}x`, 'N.x', 'n', 'missing', 'q'];
const DEEP = Array.from({ length: 13 }, (_, i) => `d${i + 1}`);
const NAME_POOL = [...BASE_KEYS, ...VARIANTS, 'd1', 'd5', 'y1', 's'];
const IRREGULAR = ['dir', 'symlink', 'dangling', 'garbage', 'array', 'null', 'empty'];

/** Other spellings of a key: case, and ſ for s (APFS folds both onto the stored file; a case-sensitive volume folds neither). */
function variantsOf(key) {
  const out = [key[0].toUpperCase() + key.slice(1), key.toUpperCase()];
  if (key.includes('s')) out.push(key.replace('s', LONG_S));
  const other = out.filter(v => v !== key);
  return other.length ? other : [key];
}

export function generateWorld(seed, index) {
  const r = makeRng(seed, index);
  const markers = {};
  let nextMarker = 1;
  const stores = { project: { entries: {}, aliases: {}, confirm: {} }, global: { entries: {}, aliases: {}, confirm: {} } };
  const otherStore = s => (s === 'project' ? 'global' : 'project');

  // 1. Which keys each store holds. The same key in both stores is common.
  const plan = { project: new Set(), global: new Set() };
  const density = 0.3 + r.next() * 0.45;
  for (const store of ['project', 'global']) for (const key of BASE_KEYS) if (!key.startsWith('ch') && r.chance(density)) plan[store].add(key);
  // A global order: a reference mostly points later in it, so most worlds are acyclic and some are not.
  const order = r.sample([...BASE_KEYS, ...DEEP, 'y1', 's'], 100);
  const rank = new Map(order.map((k, i) => [k, i]));
  const present = () => [...new Set([...plan.project, ...plan.global])];
  const aliasNames = () => [...new Set([...Object.keys(stores.project.aliases), ...Object.keys(stores.global.aliases)])];

  /** A name for a reference written in `fromKey`: mostly an existing key later in the order, sometimes anything. */
  const refName = fromKey => {
    const later = present().filter(k => (rank.get(k) ?? 0) > (rank.get(fromKey) ?? -1));
    return r.weighted([
      [later.length ? 8 : 0, () => r.pick(later)],
      [later.length ? 1 : 0, () => r.pick(variantsOf(r.pick(later)))],
      [aliasNames().length ? 0.5 : 0, () => r.pick(aliasNames())],
      [0.2, () => r.pick(present().length ? present() : NAME_POOL)],
      [0.35, () => r.pick(NAME_POOL)],
    ])();
  };
  const ref = fromKey => {
    const N = refName(fromKey), M = refName(fromKey);
    return r.weighted([
      [5, `\${${N}}`], [5, `$(${N})`], [2, `\${${N}:-dflt}`], [2, `\${${N}:-$(${M})}`], [2, `\${${N}:-\${${M}}}`],
      [0.4, `\${${N}:?RVQREQ}`], [0.3, `$(\${${N}})`], [0.3, `\${ ${N} }`], [0.3, `$( ${N} )`],
    ]);
  };
  const value = (store, key, parts) => {
    const n = nextMarker++;
    markers[n] = [store, key];
    const body = parts.join(' ');
    let v = r.chance(0.8) ? `echo RVM${n}x ${body} >> "$RLOG"` : `echo RVM${n}x >> "$RLOG"; echo ${body}`;
    if (r.chance(0.04)) v += ' && false';
    return v.replace(/ {2,}/g, ' ');
  };
  const put = (store, key, parts) => { plan[store].add(key); stores[store].entries[key] = value(store, key, parts); };

  // 2. Aliases (some named after entries — legacy, still gated — some pointing at other aliases) and flags.
  for (const store of ['project', 'global']) {
    const n = r.int(0, 4);
    for (let i = 0; i < n; i++) {
      const name = r.weighted([[3, () => r.pick(present().length ? present() : BASE_KEYS)], [2, () => r.pick(VARIANTS)], [2, () => r.pick(['al1', 'al2', 'al3'])], [1, () => variantsOf(r.pick(BASE_KEYS))[0]]])();
      const target = r.weighted([[6, () => r.pick(present().length ? present() : BASE_KEYS)], [1, () => r.pick(['al1', 'al2', 'al3'])], [0.7, () => r.pick([...NAME_POOL, ...DEEP.slice(0, 3)])]])();
      if (name !== target) stores[store].aliases[name] = target;
    }
  }
  for (const store of ['project', 'global']) {
    const n = r.weighted([[2, 0], [4, 1], [3, 2], [1, 3]]);
    for (let i = 0; i < n; i++) {
      const name = r.weighted([[4, () => r.pick(present().length ? present() : BASE_KEYS)], [2, () => 'fl'], [2, () => variantsOf(r.pick(present().length ? present() : BASE_KEYS))[0]], [1, () => r.pick([...aliasNames(), 'al1'])], [1, () => r.pick([...NAME_POOL, 'd5', 'd9', 'y3'])]])();
      stores[store].confirm[name] = true;
    }
    if (r.chance(0.08)) stores[store].confirm[r.pick(NAME_POOL)] = r.pick([false, 'yes', 1, null]);
  }

  // 3. Plain entries with references.
  for (const store of ['project', 'global']) for (const key of [...plan[store]]) put(store, key, Array.from({ length: r.int(0, 3) }, () => ref(key)));

  // A deep linear chain d1 → … → dL: enough to reach the depth limit (10).
  if (r.chance(0.5)) {
    const L = r.int(3, 13);
    const home = r.pick(['project', 'global', 'mixed']);
    for (let i = 1; i <= L; i++) {
      const store = home === 'mixed' ? r.pick(['project', 'global']) : home;
      const nextName = i < L ? `d${i + 1}` : r.pick(['fl', 'fl2', ...present(), ...NAME_POOL]);
      const link = r.weighted([[4, `\${${nextName}}`], [3, `$(${nextName})`], [1, `\${${nextName}:-$(fl)}`], [1, `\${${nextName}:-dflt}`]]);
      put(store, `d${i}`, r.chance(0.2) ? [link, ref(`d${i}`)] : [link]);
    }
    if (r.chance(0.5)) put(r.pick(['project', 'global']), 'tp', [r.pick(['${d1}', '$(d1)']), ...(r.chance(0.5) ? [r.pick(['$(fl)', '${fl}', ref('tp')])] : [])]);
  }

  // The #289 shape: an exec ref walked shallow first and deep later, then a flagged command.
  if (r.chance(0.3)) {
    const home = r.pick(['project', 'project', 'global']);
    const flStore = r.pick(['project', 'global']);
    const K = r.int(3, 6), M = r.int(5, 9);
    put(home, 'tp', [r.pick(['${s}', '$(s)']), r.pick(['${d1}', '$(d1)']), r.pick(['$(fl)', '${fl}', '$(fl2)'])]);
    put(home, 's', ['$(x)']);
    put(home, 'x', ['${y1}']);
    for (let i = 1; i < K; i++) stores[home].entries[`y${i}`] = `\${y${i + 1}}`;
    stores[home].entries[`y${K}`] = 'yw';
    for (let i = 1; i < M; i++) stores[home].entries[`d${i}`] = r.chance(0.85) ? `\${d${i + 1}}` : `$(d${i + 1})`;
    stores[home].entries[`d${M}`] = '$(x)';
    put(flStore, r.chance(0.8) ? 'fl' : 'fl2', []);
    if (r.chance(0.3)) put(otherStore(home), 'd1', [ref('d1')]);   // the #280 variant: a same-named entry in the other store
    stores[r.pick(['project', 'global'])].confirm.fl = true;
  }

  // A walk that stops after a command already ran (#289's fail-closed rule), on
  // keys no flag names: a gate that runs it unasked shows up only as R5.
  if (r.chance(0.3)) {
    const home = r.pick(['project', 'global']);
    const err = r.pick(['missing', 'required', 'cycle', 'refused', 'depth']);
    put(home, 'wb', []);
    if (err === 'depth') {
      const L = r.int(10, 12);
      for (let i = 1; i < L; i++) stores[home].entries[`wd${i}`] = `\${wd${i + 1}}`;
      put(home, `wd${L}`, r.chance(0.5) ? ['$(wz)'] : []);
      put(home, 'wz', []);
    }
    const tail = { missing: '${wnope}', required: '${wnope:?RVQREQ}', cycle: '${wc}', refused: '$(${wb})', depth: '${wd1}' }[err];
    put(home, 'wc', [tail]);
    put(home, 'wa', r.chance(0.7) ? ['$(wb)', '$(wc)'] : ['$(wb)', '${wc}']);
    if (r.chance(0.3)) stores[r.pick(['project', 'global'])].confirm.wz = true;
  }

  // Chain entries: space-separated members, some of them a:b pairs.
  // A global chain runs global members only, so members come mostly from the chain's own store.
  const member = store => r.weighted([
    [plan[store].size ? 6 : 0, () => r.pick([...plan[store]])],
    [1, () => r.pick(present().length ? present() : NAME_POOL)],
    [0.5, () => r.pick(NAME_POOL)],
    [0.5, () => r.pick([...aliasNames(), 'al1'])],
  ])();
  for (const key of ['ch', 'ch2']) {
    for (const store of ['project', 'global']) {
      if (!r.chance(0.55)) continue;
      stores[store].entries[key] = Array.from({ length: r.int(1, 4) }, () => (r.chance(0.2) ? `${member(store)}:${member(store)}` : member(store))).join(' ');
    }
  }

  // Irregular sidecars: a directory, a symlink (to a valid map), dangling, unparseable, an array, null, empty.
  for (const store of ['project', 'global']) {
    for (const side of ['aliases', 'confirm']) {
      if (!r.chance(0.05)) continue;
      const kind = r.pick(IRREGULAR);
      const content = side === 'aliases' ? { fl: r.pick(BASE_KEYS), FL: 'a' } : {};
      stores[store][side] = { $irregular: kind, content };
    }
  }

  const spec = { seed, index, stores, markers, invocations: [] };
  spec.invocations = generateInvocations(r, spec);
  return spec;
}

function generateInvocations(r, spec) {
  const inv = [];
  const P = spec.stores.project, G = spec.stores.global;
  const entries = st => Object.keys(st.entries);
  const aliasesOf = st => (st.aliases.$irregular ? [] : Object.keys(st.aliases));
  /** A name to type: mostly one the view can find (global keys for -G and outside the project), sometimes an alias, another spelling or anything. */
  const typedName = view => {
    const stores = view === 'global' ? [G] : view === 'project' ? [P] : [P, G];
    const keys = stores.flatMap(entries), als = stores.flatMap(aliasesOf);
    return r.weighted([
      [keys.length ? 6 : 0, () => r.pick(keys)],
      [als.length ? 1.5 : 0, () => r.pick(als)],
      [keys.length ? 1.5 : 0, () => r.pick(variantsOf(r.pick(keys)))],
      [1, () => r.pick([...entries(P), ...entries(G), ...NAME_POOL])],
    ])();
  };
  const mode = () => r.weighted([[45, 'json'], [25, 'plain'], [15, 'capture'], [15, 'source']]);
  const cli = (cwd, ks, o = {}) => inv.push({ surface: 'cli', cwd, kind: o.kind ?? 'run', keys: ks, global: Boolean(o.global), chain: Boolean(o.chain), yes: Boolean(o.yes), mode: o.mode ?? mode() });
  const mcp = (cwd, args, token) => { inv.push({ surface: 'mcp', cwd, tool: 'reverie_run', args, ...(token ? { token } : {}) }); return inv.length - 1; };

  for (const cwd of ['proj', 'out']) {
    const auto = cwd === 'proj' ? 'auto' : 'global';
    const asks = [];
    const names = [];
    for (let i = 0; i < 10; i++) {
      const N = typedName(auto), NG = typedName('global');
      names.push(N);
      cli(cwd, [N]);
      cli(cwd, [NG], { global: true });
      asks.push(mcp(cwd, { key: N }));
      mcp(cwd, { key: r.chance(0.7) ? NG : N, scope: 'global' });
      if (cwd === 'proj' || r.chance(0.2)) mcp(cwd, { key: typedName(cwd === 'proj' ? 'project' : 'global'), scope: 'project' });
    }
    for (const N of ['tp', 'd1', 'wa'].filter(k => k in P.entries || k in G.entries)) { cli(cwd, [N]); asks.push(mcp(cwd, { key: N })); }
    for (const C of ['ch', 'ch2', typedName(auto)]) {
      cli(cwd, [C], { chain: true });
      cli(cwd, [C], { chain: true, global: true });
      asks.push(mcp(cwd, { key: C, chain: true }));
      mcp(cwd, { key: C, chain: true, scope: r.pick(['global', 'project']) });
    }
    for (let i = 0; i < 3; i++) {
      const g = r.chance(0.3);
      const x = typedName(g ? 'global' : auto), y = typedName(g ? 'global' : auto);
      cli(cwd, [`${x}:${y}`], { global: g });
      cli(cwd, [x, y], { global: g });
    }
    // Tokens: a valid redeem (approved), the same token again, a bogus one, another key's.
    const issuer = r.pick(asks);
    const issuerArgs = inv[issuer].args;
    mcp(cwd, { ...issuerArgs }, { from: issuer });
    mcp(cwd, { ...issuerArgs }, { from: issuer });
    mcp(cwd, { key: r.pick(names) }, 'bogus');
    const other = r.pick(asks);
    const otherKey = r.pick(names.filter(n => n !== inv[other].args.key)) ?? 'a';
    mcp(cwd, { key: otherKey }, { from: other });
    // Approved runs: confinement still applies.
    for (let i = 0; i < 2; i++) { const g = r.chance(0.4); cli(cwd, [typedName(g ? 'global' : auto)], { yes: true, global: g }); }
    if (r.chance(0.3)) mcp(cwd, { key: r.pick(names), force: true });
    // Reads never execute.
    cli(cwd, [r.pick(names)], { kind: 'dry', mode: 'json', global: r.chance(0.3) });
    cli(cwd, [r.pick(names)], { kind: 'get', mode: 'json' });
    inv.push({ surface: 'mcp', cwd, tool: 'reverie_run', args: { key: r.pick(names), dry: true } });
    inv.push({ surface: 'mcp', cwd, tool: 'reverie_get', args: { key: r.pick(names) } });
  }
  generateWrites(r, spec, inv);
  return inv;
}

/**
 * Writes, after every run (they change the world): several are refused by
 * rule (an alias named after an entry, a flag on no entry, a rename onto an
 * existing key, a write next to an unreadable sidecar), so the store
 * invariants have refusals to check. Each write is judged against the stores
 * just before it; they compound.
 */
function generateWrites(r, spec, inv) {
  const P = spec.stores.project, G = spec.stores.global;
  const keys = [...new Set([...Object.keys(P.entries), ...Object.keys(G.entries)])];
  const flags = ['project', 'global'].flatMap(s => (spec.stores[s].confirm.$irregular ? [] : Object.keys(spec.stores[s].confirm)));
  const key = () => (keys.length && r.chance(0.8) ? r.pick(keys) : r.pick(NAME_POOL));
  const fresh = () => r.pick(['nw1', 'nw2', 'nw.z', 'Nw1']);
  const keyOrFresh = () => (r.chance(0.5) ? key() : fresh());
  const where = () => (r.chance(0.8) ? 'proj' : 'out');
  const G_ = () => (r.chance(0.3) ? ['-G'] : []);
  const cli = argv => inv.push({ surface: 'cli', kind: 'write', cwd: where(), argv, mode: 'json' });
  const n = r.int(5, 9);
  for (let i = 0; i < n; i++) {
    r.weighted([
      [2, () => cli(['alias', 'set', r.chance(0.6) ? key() : fresh(), key(), ...G_()])],
      [2, () => cli(['set', keyOrFresh(), 'echo v', '-a', r.chance(0.6) ? key() : fresh(), ...G_()])],
      [2, () => cli(['confirm', 'set', r.chance(0.5) ? key() : r.pick(['missing', 'q', 'n']), ...G_()])],
      [1, () => cli(['confirm', 'remove', flags.length ? r.pick(flags) : key(), ...G_()])],
      [2, () => cli(['rename', key(), keyOrFresh(), ...G_()])],
      [1.5, () => cli(['remove', key(), '-f', ...G_()])],
      [1, () => cli(['copy', key(), keyOrFresh(), '-f', ...G_()])],
      [1, () => cli(['set', key(), 'echo v2', ...(r.chance(0.5) ? ['-f'] : []), ...(r.chance(0.2) ? ['--no-confirm'] : []), ...G_()])],
    ])();
  }
  for (let i = 0; i < r.int(2, 4); i++) {
    const scope = r.pick([undefined, undefined, 'project', 'global']);
    const sc = scope ? { scope } : {};
    const call = r.weighted([
      [2, () => ({ tool: 'reverie_alias_set', args: { alias: r.chance(0.6) ? key() : fresh(), key: key(), ...sc } })],
      [2, () => ({ tool: 'reverie_set', args: { key: keyOrFresh(), value: 'echo v', ...(r.chance(0.6) ? { alias: r.chance(0.6) ? key() : fresh() } : {}), ...sc } })],
      [1.5, () => ({ tool: 'reverie_rename', args: { oldKey: key(), newKey: keyOrFresh(), ...sc } })],
      [1, () => ({ tool: 'reverie_remove', args: { key: key(), ...sc } })],
      [1, () => ({ tool: 'reverie_copy', args: { source: key(), dest: keyOrFresh(), ...sc } })],
    ])();
    inv.push({ surface: 'mcp', kind: 'write', cwd: where(), ...call });
  }
}

/** The argv of a CLI invocation (mode flags are added by the driver). */
export function cliArgs(i) {
  if (i.kind === 'get') return ['get', ...i.keys];
  return ['run', ...(i.global ? ['-G'] : []), ...(i.chain ? ['--chain'] : []), ...i.keys, ...(i.yes ? ['--yes'] : []), ...(i.kind === 'dry' ? ['--dry'] : [])];
}
