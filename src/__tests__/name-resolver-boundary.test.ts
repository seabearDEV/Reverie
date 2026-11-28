// What a typed name means is decided in one place: utils/nameResolver.ts,
// over the view alias.ts builds. Every recent bug in this area (#279, #280,
// #284, #260) came from two places reading the alias maps and deciding
// differently. This scan keeps it that way: the raw alias-map loaders are
// used by alias.ts alone, under any kind of import; no other file looks a
// name up in a map it loaded; and every read of an `.aliases` property is
// one listed below, counted per file, with the reason — it lists a map (a
// display, an export) or writes one (the store, an import, the alias
// commands under their lock). A new one fails here until it is one of
// those, or asks the resolver instead.
//
// It matches text, not types: a tripwire, not a proof. Comments and string
// literals are blanked first, so prose cannot trip it and cannot hide code.
import fs from 'fs';
import path from 'path';

const SRC = path.resolve(import.meta.dir, '..');

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== '__tests__') out.push(...sources(p)); }
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

/** `text` with comments and the contents of string literals blanked; a module specifier is kept. */
function codeOf(text: string): string {
  let out = '';
  for (let i = 0; i < text.length;) {
    const c = text[i], n = text[i + 1];
    if (c === '/' && n === '/') { while (i < text.length && text[i] !== '\n') i++; continue; }
    if (c === '/' && n === '*') { const end = text.indexOf('*/', i + 2); i = end === -1 ? text.length : end + 2; continue; }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < text.length && text[j] !== c) j += text[j] === '\\' ? 2 : 1;
      out += /(?:from|import)\s*$/.test(out) ? `${c}${text.slice(i + 1, j)}${c}` : `${c}${c}`;
      i = j + 1;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

interface Source { rel: string; code: string }
const files: Source[] = sources(SRC).map(p => ({ rel: path.relative(SRC, p), code: codeOf(fs.readFileSync(p, 'utf8')) }));

const RAW_LOADERS = ['loadAliasMap', 'loadAliasMapMerged', 'updateAliasMap', 'saveAliasMap'];
const MAP_SOURCES = ['loadAliases', 'loadAliasMap', 'loadAliasMapMerged', 'aliasesSeen'];

/** Files that name a raw loader anywhere: a named import, a namespace import's member, a re-export. */
function rawLoaderUsers(src: Source[]): string[] {
  const re = new RegExp(`\\b(?:${RAW_LOADERS.join('|')})\\b`);
  return src.filter(f => re.test(f.code)).map(f => f.rel).sort();
}

/** Files with a namespace import of the store module, whose members the name check above cannot list. */
function storeNamespaceImporters(src: Source[]): string[] {
  return src.filter(f => /import\s+\*\s+as\s+\w+\s+from\s+['"](?:\.\.?\/)+store['"]/.test(f.code)).map(f => f.rel).sort();
}

/**
 * Lookups in an alias map a file loaded itself — `Object.hasOwn(m, …)`,
 * `hasOwnProperty.call(m, …)`, `… in m`, `m[…]`, `m?.[…]`, a destructuring
 * of `m`, `Object.entries(m).find(…)`, where `m` holds what a loader
 * returned — or the same on the loader's result directly.
 */
function inlineLookups(src: Source[]): string[] {
  const loaders = MAP_SOURCES.join('|');
  const callStart = `(?:\\w+\\.)?(?:${loaders})\\s*\\(`;                                // a loader's call, up to its "("
  const call = `${callStart}(?:[^()]|\\([^()]*\\))*\\)`;                          // the whole call, one level of nested parens
  const hasOwn = `\\bhasOwn(?:Property)?(?:\\s*\\.\\s*(?:call|apply))?\\s*\\(\\s*`; // Object.hasOwn( or ….hasOwnProperty.call(
  const index = `\\s*(?:\\?\\.\\s*)?\\[`;                                            // [ or ?.[
  const search = `\\s*\\.\\s*(?:find|findIndex|findLast|findLastIndex|some|every|includes|indexOf)\\s*\\(`;
  const out: string[] = [];
  for (const f of src) {
    if (f.rel === 'utils/nameResolver.ts') continue;   // the resolver itself
    // The variable a loader's result is assigned to: in its declaration, in
    // the same statement and block, or by a later plain assignment.
    const declared = new RegExp(`(?:const|let|var)\\s+(\\w+)\\s*(?::[^=;{}]+)?=\\s*[^;\\n{}]*?\\b(?:${loaders})\\s*\\(`, 'g');
    const reassigned = new RegExp(`(?<![\\w$.])(\\w+)\\s*=(?![=>])\\s*[^;\\n{}]*?\\b(?:${loaders})\\s*\\(`, 'g');
    const vars = [...new Set([...f.code.matchAll(declared), ...f.code.matchAll(reassigned)].map(m => m[1]))];
    const patterns: [string, RegExp][] = [
      // What comes before the call needs only its start, so any arguments match.
      ['direct hasOwn', new RegExp(`${hasOwn}${callStart}`)],
      ['direct in', new RegExp(`\\bin\\s+${callStart}`)],
      ['direct destructuring', new RegExp(`(?:const|let|var)\\s*\\{[^}]*\\}\\s*(?::[^=;]+)?=\\s*${callStart}`)],
      // What comes after it needs the whole call.
      ['direct index', new RegExp(`\\b${call}${index}`)],
      ['direct search', new RegExp(`Object\\.(?:entries|keys|values)\\(\\s*${call}\\s*\\)${search}`)],
      ...vars.flatMap((v): [string, RegExp][] => [
        [`hasOwn(${v}, …)`, new RegExp(`${hasOwn}${v}\\b`)],
        [`${v}.hasOwnProperty(…)`, new RegExp(`(?<![\\w$.])${v}\\s*(?:\\?\\.|\\.)\\s*hasOwnProperty\\s*\\(`)],
        [`… in ${v}`, new RegExp(`\\bin\\s+${v}\\b`)],
        [`${v}[…]`, new RegExp(`(?<![\\w$.])${v}${index}`)],
        [`{ … } = ${v}`, new RegExp(`(?:const|let|var)\\s*\\{[^}]*\\}\\s*(?::[^=;]+)?=\\s*${v}\\b(?!\\s*[.([])`)],
        [`Object.entries(${v}).find(…)`, new RegExp(`Object\\.(?:entries|keys|values)\\(\\s*${v}\\s*\\)${search}`)],
      ]),
    ];
    for (const [what, re] of patterns) if (re.test(f.code)) out.push(`${f.rel}: ${what}`);
  }
  return out.sort();
}

/**
 * Every `x.aliases` (`x.y.aliases`, …) read, as `file: expression`, with
 * `×n` when the file reads it more than once: a further read of a listed
 * expression is a new read.
 */
function aliasesReads(src: Source[]): string[] {
  const count = new Map<string, number>();
  for (const f of src) {
    for (const m of f.code.matchAll(/\b([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\.aliases\b/g)) {
      const k = `${f.rel}: ${m[1]}.aliases`;
      count.set(k, (count.get(k) ?? 0) + 1);
    }
  }
  return [...count].map(([k, n]) => (n > 1 ? `${k} ×${n}` : k)).sort();
}

describe('one name resolver', () => {
  it('only alias.ts uses the raw alias-map loaders (store.ts defines them), under any kind of import', () => {
    expect(rawLoaderUsers(files)).toEqual(['alias.ts', 'store.ts']);
    expect(storeNamespaceImporters(files)).toEqual([]);
  });

  it('the gate names come from the resolver alone', () => {
    expect(files.filter(f => /\bgateNamesFor\b/.test(f.code)).map(f => f.rel)).toEqual([]);
  });

  it('no file looks a name up in an alias map it loaded', () => {
    expect(inlineLookups(files)).toEqual([
      // aliasTargetListed: the audit row's before-value of an alias
      // command, indexed as it always was (an inherited name included).
      'alias.ts: direct index',
    ]);
  });

  it('loadAliases is read only to list a map: a display, a search, an export, an import diff or merge base', () => {
    expect(files.filter(f => /\bloadAliases\b/.test(f.code) && f.rel !== 'alias.ts').map(f => f.rel).sort()).toEqual([
      'commands/context.ts',          // the bootstrap's alias block
      'commands/data-management.ts',  // export payload; import preview diff; import's merge base (the written store's own map)
      'commands/entries.ts',          // `get -a` and the --json alias listing
      'commands/info.ts',             // the alias count
      'commands/search.ts',           // `find` over aliases
      'completions.ts',               // tab completion
      'index.ts',                     // `alias list`
      'mcp-server.ts',                // listings, find, export, import preview and merge base, context
    ]);
  });

  it('every `.aliases` read is one of these', () => {
    expect(aliasesReads(files)).toEqual([
      'alias.ts: current.aliases ×2',                         // the alias commands' writes, under the store lock
      'commands/context.ts: opts.aliases ×2',                 // the bootstrap's alias block, handed in
      'commands/context.ts: payload.aliases ×2',              // the same, rendered
      'commands/context.ts: result.aliases',                  // the --json result
      'commands/data-management.ts: current.aliases',         // import: the merge base under the lock
      'commands/data-management.ts: envelopePayload.aliases', // import: the file's section
      'commands/data-management.ts: validData.aliases',       // import: the file's section
      'commands/entries.ts: options.aliases ×2',              // the -a flag
      'commands/manifest.ts: cmd.aliases ×2',                 // a command's other names
      'commands/search.ts: options.aliases ×4',               // the -a flag
      'commands/search.ts: result.aliases',                   // the --json result
      'index.ts: options.aliases',                            // the -a flag
      'mcp-server.ts: current.aliases',                       // import: the merge base under the lock
      'mcp-server.ts: envelopePayload.aliases ×4',            // import: the file's section
      'mcp-server.ts: obj.aliases ×4',                        // import: the file's section
      'mcp-server.ts: payload.aliases',                       // export: the section written
      'rename.ts: other.data.aliases ×2',                     // #260: the global aliases a default-scope rename leaves, to name them
      'rename.ts: target.data.aliases ×2',                    // the re-point, through repointAliases
      'storage.ts: current.aliases ×2',                       // set -a: the alias written with the value; remove: the aliases dropped with the entry (#268)
      'storage.ts: next.aliases',                             // the same
      'store.ts: current.aliases ×2',                         // the store
      'store.ts: parsed.aliases',                             // the store, loading a legacy file
      'store.ts: sections.aliases ×2',                        // the store, writing an import
      'utils/directoryStore.ts: data.aliases ×4',             // the store's files
      'utils/directoryStore.ts: parsed.aliases',              // the store's files, migrating
      'utils/importSections.ts: current.aliases ×2',          // import: the merge, and whether an imported alias is new
      'utils/importSections.ts: next.aliases',                // import: the merged section
      'utils/importSections.ts: sections.aliases ×4',         // import: the file's section
    ]);
  });
});

// #305 L5: lookups the scan used to miss. Each one looks a name up in a map
// the file loaded, written in a way the patterns above did not match.
describe('the scan sees a lookup however it is written', () => {
  const scan = (code: string) => inlineLookups([{ rel: 'x.ts', code: codeOf(code) }]);
  const cases: [string, string][] = [
    ['an optional-chained index', 'const seen = aliasesSeen(view, ctx);\nconst t = seen?.[key];'],
    ["an optional-chained index on a loader's result", 'const t = loadAliases(scope)?.[key];'],
    ['a destructured computed key', 'const { [key]: t } = loadAliases(scope);'],
    ['hasOwnProperty.call', 'const seen = aliasesSeen(view, ctx);\nif (Object.prototype.hasOwnProperty.call(seen, key)) use();'],
    ['Object.entries(…).find', 'const hit = Object.entries(loadAliases(scope)).find(([a]) => a === key);'],
    ['an assignment split over two statements', 'let seen;\nseen = loadAliases(scope);\nconst t = seen[key];'],
    // The same forms on the other side: a map variable, the method call, another search.
    ['a destructured key of a map variable', 'const seen = aliasesSeen(view, ctx);\nconst { [key]: t } = seen;'],
    ['seen.hasOwnProperty(…)', 'const seen = aliasesSeen(view, ctx);\nif (seen.hasOwnProperty(key)) use();'],
    ['Object.keys(…).includes', 'const seen = aliasesSeen(view, ctx);\nif (Object.keys(seen).includes(key)) use();'],
    // Review of #310: forms the old scan caught whatever the loader's arguments.
    ['hasOwn on a loader called with nested calls', 'if (Object.hasOwn(loadAliases(scopeFor(getOpts())), key)) use();'],
    ['in on a loader called with nested calls', 'if (key in loadAliases(scopeFor(getOpts()))) use();'],
  ];
  for (const [what, code] of cases) it(`catches ${what}`, () => { expect(scan(code)).not.toEqual([]); });

  it('counts the reads of an `.aliases` expression, so a second read of a listed one is new', () => {
    expect(aliasesReads([{ rel: 'x.ts', code: codeOf('list(current.aliases);\nconst t = current.aliases[key];') }])).toEqual(['x.ts: current.aliases ×2']);
  });
});
