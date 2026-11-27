// The worlds and the invocations of the scope differential. Every world has
// the same entries and flags; what changes from one to the next is the alias
// layout, which is what decides what a typed name means. Each invocation
// runs alone in a fresh copy of its world, so a difference never cascades.
//
// Entry values are `echo` commands, and nothing here runs one: `run` is only
// ever `--dry`, `reverie_run` only `dry: true`. They hold references so that
// a read and a dry run show how the names inside an entry resolve (#280).

export const GLOBAL_ENTRIES = {
  'k.g': 'echo kg',
  'k.both': 'echo kboth-g',
  'k.gx': 'echo kgx',
  'ns.a': 'echo nsa-g',
  'ref.g': 'echo refg ${pa} ${ga} ${dup} ${k.p:-none}',
};
export const PROJECT_ENTRIES = {
  'k.p': 'echo kp',
  'k.both': 'echo kboth-p',
  'ns.a': 'echo nsa-p',
  'ns.b': 'echo nsb-p',
  'ref.p': 'echo refp ${pa} ${ga} ${dup} ${k.g}',
};
const GLOBAL_FLAGS = { 'k.g': true };
const PROJECT_FLAGS = { 'k.p': true };

/**
 * One alias layout per world. `aliases` is [project map, global map]; a map
 * may be `{ $irregular: 'garbage' }` (an unparseable file). `extra` are typed
 * names beyond every alias name and the base names.
 */
const LAYOUTS = [
  {
    name: 'split',
    why: 'an alias in one store only, each pointing at its own store and at the other',
    aliases: [{ pa: 'k.p', pg: 'k.g', pns: 'ns.a' }, { ga: 'k.g', gp: 'k.p', gboth: 'k.both' }],
    extra: ['pa:'],
  },
  {
    name: 'same-name',
    why: 'one alias name in both maps, with different and with the same targets',
    aliases: [{ dup: 'k.p', same: 'k.both' }, { dup: 'k.g', same: 'k.both' }],
    extra: ['dup:'],
  },
  {
    name: 'legacy-pair',
    why: 'aliases named after an entry of the other store and of their own (1.3.0 data)',
    aliases: [{ 'k.g': 'k.p', 'k.both': 'k.p' }, { 'k.p': 'k.g', 'k.gx': 'k.g' }],
    extra: [],
  },
  {
    name: 'case',
    why: 'alias names and typed names that differ only by case',
    aliases: [{ Pa: 'k.p', 'K.G': 'k.p' }, { pa: 'k.g', GA: 'k.gx' }],
    extra: ['PA', 'ga', 'K.P', 'k.G'],
  },
  {
    name: 'copied-260',
    why: 'a project map that already holds a copied global alias (#260), and aliases to namespace members',
    aliases: [{ ga: 'k.g', pa: 'k.p', pnsb: 'ns.b' }, { ga: 'k.g', gp: 'k.p', gnsa: 'ns.a' }],
    extra: [],
  },
  {
    name: 'unreadable-project',
    why: "the project's _aliases.json does not parse",
    aliases: [{ $irregular: 'garbage' }, { ga: 'k.g', gp: 'k.p' }],
    extra: ['pa'],
  },
  {
    name: 'unreadable-global',
    why: "the global _aliases.json does not parse",
    aliases: [{ pa: 'k.p', pg: 'k.g' }, { $irregular: 'garbage' }],
    extra: ['ga'],
  },
  {
    name: 'proto',
    why: 'names an object inherits (an `in` lookup finds them, Object.hasOwn does not)',
    aliases: [{ valueOf: 'k.p' }, { ga: 'k.g' }],
    extra: ['toString', 'hasOwnProperty'],
  },
];

const BASE_NAMES = ['k.p', 'k.g', 'k.both', 'ns', 'nope'];

/** The world spec the fuzzer's buildWorld takes, plus the import file it reads. */
export function worldSpec(layout) {
  return {
    stores: {
      project: { entries: PROJECT_ENTRIES, aliases: layout.aliases[0], confirm: PROJECT_FLAGS },
      global: { entries: GLOBAL_ENTRIES, aliases: layout.aliases[1], confirm: GLOBAL_FLAGS },
    },
  };
}

/** An alias map to import: a new alias, one of each store's names, one named after an entry. */
export function importAliases(layout) {
  const names = aliasNames(layout);
  const out = { 'imp.new': 'k.p' };
  for (const n of names.slice(0, 2)) out[n] = 'k.gx';
  out['k.gx'] = 'k.g';
  return out;
}

function aliasNames(layout) {
  const names = [];
  for (const m of layout.aliases) {
    if (m.$irregular) continue;
    for (const n of Object.keys(m)) if (!names.includes(n)) names.push(n);
  }
  return names;
}

export function typedNames(layout) {
  const names = [...aliasNames(layout)];
  for (const n of [...layout.extra, ...BASE_NAMES]) if (!names.includes(n)) names.push(n);
  return names;
}

export const WORLDS = LAYOUTS.map(l => l.name);
export const layoutNamed = name => LAYOUTS.find(l => l.name === name);
export const LAYOUT_LIST = LAYOUTS;

const CWDS = ['proj', 'out'];
const CLI_SCOPES = [[], ['-G']];
const MCP_SCOPES = [undefined, 'global', 'project'];

/** CLI argv (after --json) for one typed name, without the scope flag. */
function cliPerName(n) {
  return [
    ['get', n],
    ['set', n, 'v.new'],
    ['set', n, 'v.new', '-a', 'al.new'],
    ['set', n, '-a', 'al.new'],
    ['set', n, '--confirm'],
    ['edit', n],
    ['copy', n, 'cp.new'],
    ['rename', n, 'rn.new'],
    ['rename', n, 'rn.new', '--set-alias', 'al.new'],
    ['rename', '-a', n, 'al.new'],
    ['remove', n, '--force'],
    ['remove', '-a', n],
    ['confirm', 'set', n],
    ['confirm', 'remove', n],
    ['alias', 'set', 'al.new', n],
    ['alias', 'set', n, 'k.gx'],
    ['alias', 'remove', n],
    ['alias', 'rename', n, 'al.new'],
    ['run', '--dry', n],
  ];
}

/** MCP [tool, args] for one typed name, without the scope. */
function mcpPerName(n) {
  return [
    ['reverie_get', { key: n }],
    ['reverie_set', { key: n, value: 'v.new' }],
    ['reverie_set', { key: n, value: 'v.new', alias: 'al.new' }],
    ['reverie_remove', { key: n }],
    ['reverie_remove', { key: n, is_alias: true }],
    ['reverie_copy', { source: n, dest: 'cp.new' }],
    ['reverie_rename', { oldKey: n, newKey: 'rn.new' }],
    ['reverie_rename', { oldKey: n, newKey: 'rn.new', alias: 'al.new' }],
    ['reverie_rename', { oldKey: n, newKey: 'al.new', is_alias: true }],
    ['reverie_alias_set', { alias: 'al.new', key: n }],
    ['reverie_alias_set', { alias: n, key: 'k.gx' }],
    ['reverie_alias_remove', { alias: n }],
    ['reverie_run', { key: n, dry: true }],
  ];
}

/** Invocations that name no key, once per world. The import file is `../imp.json` from either cwd. */
function cliPerWorld(names) {
  const two = names.slice(0, 2);
  return [
    { argv: ['get'], scoped: true },
    { argv: ['get', '-A'], scoped: false },
    { argv: ['find', 'k'], scoped: true },
    { argv: ['find', two[0] ?? 'k'], scoped: true },
    { argv: ['context'], scoped: true },
    { argv: ['alias', 'list'], scoped: true },
    { argv: ['set', ...two.map((n, i) => `${n}=batch${i}`)], scoped: true },
    { argv: ['data', 'export', 'aliases'], scoped: true, project: true },
    { argv: ['data', 'export', 'all'], scoped: true, project: true },
    { argv: ['data', 'import', 'aliases', '../imp.json', '--merge', '--force'], scoped: true, project: true },
    { argv: ['data', 'import', 'aliases', '../imp.json', '--force'], scoped: true, project: true },
    { argv: ['data', 'import', 'aliases', '../imp.json', '--preview'], scoped: true, project: true },
  ];
}

function mcpPerWorld(layout) {
  const data = importAliases(layout);
  return [
    ['reverie_get', {}],
    ['reverie_get', { aliases_only: true }],
    ['reverie_find', { query: 'k' }],
    ['reverie_alias_list', {}],
    ['reverie_context', {}],
    ['reverie_export', { type: 'aliases' }],
    ['reverie_export', { type: 'all' }],
    ['reverie_import', { type: 'aliases', data, merge: true }],
    ['reverie_import', { type: 'aliases', data, merge: false }],
    ['reverie_import', { type: 'aliases', data, preview: true }],
  ];
}

/** Every invocation, in a fixed order. Each has a stable id. */
export function allInvocations({ worlds = WORLDS } = {}) {
  const out = [];
  for (const world of worlds) {
    const layout = layoutNamed(world);
    const names = typedNames(layout);
    for (const cwd of CWDS) {
      const cli = argv => out.push({ id: `${world}|${cwd}|cli ${argv.join(' ')}`, world, cwd, surface: 'cli', argv });
      const mcp = (tool, args) => out.push({ id: `${world}|${cwd}|mcp ${tool} ${JSON.stringify(args)}`, world, cwd, surface: 'mcp', tool, args });
      for (const n of names) {
        for (const argv of cliPerName(n)) for (const s of CLI_SCOPES) cli([...argv, ...s]);
        for (const [tool, args] of mcpPerName(n)) for (const s of MCP_SCOPES) mcp(tool, s ? { ...args, scope: s } : args);
      }
      for (const { argv, scoped, project } of cliPerWorld(names)) {
        cli(argv);
        if (scoped) cli([...argv, '-G']);
        if (project) cli([...argv, '-P']);
      }
      for (const [tool, args] of mcpPerWorld(layout)) for (const s of MCP_SCOPES) mcp(tool, s ? { ...args, scope: s } : args);
    }
  }
  return out;
}
