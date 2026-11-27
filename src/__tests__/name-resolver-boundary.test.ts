// What a typed name means is decided in one place: utils/nameResolver.ts,
// over the view alias.ts builds. Every recent bug in this area (#279, #280,
// #284, #260) came from two places reading the alias maps and deciding
// differently. This scan keeps it that way: the raw alias-map loaders are
// used by alias.ts alone, under any kind of import; no other file looks a
// name up in a map it loaded; and every read of an `.aliases` property is
// one listed below with the reason — it lists a map (a display, an export)
// or writes one (the store, an import, the alias commands under their
// lock). A new one fails here until it is one of those, or asks the
// resolver instead.
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
 * `… in m`, `m[…]`, where `m` holds what a loader returned — or the same on
 * the loader's result directly.
 */
function inlineLookups(src: Source[]): string[] {
  const loaders = MAP_SOURCES.join('|');
  const out: string[] = [];
  for (const f of src) {
    if (f.rel === 'utils/nameResolver.ts') continue;   // the resolver itself
    // The variable a loader's result is assigned to, in the same statement and block.
    const assigned = new RegExp(`(?:const|let|var)\\s+(\\w+)\\s*(?::[^=;{}]+)?=\\s*[^;\\n{}]*?\\b(?:${loaders})\\s*\\(`, 'g');
    const vars = [...new Set([...f.code.matchAll(assigned)].map(m => m[1]))];
    const patterns: [string, RegExp][] = [
      ['direct hasOwn', new RegExp(`hasOwn\\(\\s*(?:\\w+\\.)?(?:${loaders})\\s*\\(`)],
      ['direct in', new RegExp(`\\bin\\s+(?:\\w+\\.)?(?:${loaders})\\s*\\(`)],
      ['direct index', new RegExp(`\\b(?:${loaders})\\s*\\((?:[^()]|\\([^()]*\\))*\\)\\s*\\[`)],
      ...vars.flatMap((v): [string, RegExp][] => [
        [`hasOwn(${v}, …)`, new RegExp(`hasOwn\\(\\s*${v}\\b`)],
        [`… in ${v}`, new RegExp(`\\bin\\s+${v}\\b`)],
        [`${v}[…]`, new RegExp(`(?<![\\w$.])${v}\\s*\\[`)],
      ]),
    ];
    for (const [what, re] of patterns) if (re.test(f.code)) out.push(`${f.rel}: ${what}`);
  }
  return out.sort();
}

/** Every `x.aliases` (`x.y.aliases`, …) read, as `file: expression`. */
function aliasesReads(src: Source[]): string[] {
  const out = new Set<string>();
  for (const f of src) for (const m of f.code.matchAll(/\b([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\.aliases\b/g)) out.add(`${f.rel}: ${m[1]}.aliases`);
  return [...out].sort();
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
      'alias.ts: current.aliases',                            // the alias commands' writes, under the store lock
      'commands/context.ts: opts.aliases',                    // the bootstrap's alias block, handed in
      'commands/context.ts: payload.aliases',                 // the same, rendered
      'commands/context.ts: result.aliases',                  // the --json result
      'commands/data-management.ts: current.aliases',         // import: the merge base under the lock
      'commands/data-management.ts: envelopePayload.aliases', // import: the file's section
      'commands/data-management.ts: validData.aliases',       // import: the file's section
      'commands/entries.ts: options.aliases',                 // the -a flag
      'commands/manifest.ts: cmd.aliases',                    // a command's other names
      'commands/search.ts: options.aliases',                  // the -a flag
      'commands/search.ts: result.aliases',                   // the --json result
      'index.ts: options.aliases',                            // the -a flag
      'mcp-server.ts: current.aliases',                       // import: the merge base under the lock
      'mcp-server.ts: envelopePayload.aliases',               // import: the file's section
      'mcp-server.ts: obj.aliases',                           // import: the file's section
      'mcp-server.ts: payload.aliases',                       // export: the section written
      'rename.ts: data.aliases',                              // the re-point, through aliasWriteBase / repointAliases
      'rename.ts: target.data.aliases',                       // the same
      'storage.ts: current.aliases',                          // set -a: the alias written with the value (#268)
      'storage.ts: next.aliases',                             // the same
      'store.ts: current.aliases',                            // the store
      'store.ts: parsed.aliases',                             // the store, loading a legacy file
      'store.ts: sections.aliases',                           // the store, writing an import
      'utils/directoryStore.ts: data.aliases',                // the store's files
      'utils/directoryStore.ts: parsed.aliases',              // the store's files, migrating
      'utils/importSections.ts: current.aliases',             // import: the merge, and whether an imported alias is new
      'utils/importSections.ts: next.aliases',                // import: the merged section
      'utils/importSections.ts: sections.aliases',            // import: the file's section
    ]);
  });
});
