// What a typed name means is decided in one place: utils/nameResolver.ts,
// over the view alias.ts builds. Every recent bug in this area (#279, #280,
// #284, #260) came from two places reading the alias maps and deciding
// differently. This scan keeps it that way: the raw alias-map loaders are
// read by alias.ts alone, and every other reader of an alias map is one that
// lists it (a display, an export) or writes it (the store, an import), named
// below with the reason. A new reader fails here until it is one of those,
// or asks the resolver instead.
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

const files = sources(SRC).map(p => ({ rel: path.relative(SRC, p), text: fs.readFileSync(p, 'utf8') }));

function importersOf(name: string): string[] {
  const re = new RegExp(`import\\s*(?:type\\s*)?\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from`);
  return files.filter(f => re.test(f.text)).map(f => f.rel).sort();
}

describe('one name resolver', () => {
  it('only alias.ts reads the raw alias maps', () => {
    for (const loader of ['loadAliasMap', 'loadAliasMapMerged', 'updateAliasMap', 'saveAliasMap']) {
      expect([loader, importersOf(loader)]).toEqual([loader, ['alias.ts']]);
    }
  });

  it('the gate names come from the resolver alone', () => {
    expect(files.filter(f => /\bgateNamesFor\b/.test(f.text)).map(f => f.rel)).toEqual([]);
  });

  it('loadAliases is read only to list a map: a display, a search, an export, an import diff or merge base', () => {
    expect(importersOf('loadAliases')).toEqual([
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

  it('a store\'s alias map is read directly only where it is stored, written, or handed to the resolver', () => {
    const reads = files.filter(f => /\b(?:data|current|state)\.aliases\b/.test(f.text)).map(f => f.rel).sort();
    expect(reads).toEqual([
      'alias.ts',                     // the alias commands' writes, under the store lock
      'commands/data-management.ts',  // import: the merge base under the lock
      'mcp-server.ts',                // import: the merge base under the lock
      'rename.ts',                    // the re-point, through aliasWriteBase / repointAliases
      'storage.ts',                   // set -a: the alias written with the value (#268)
      'store.ts',                     // the store
      'utils/directoryStore.ts',      // the store's files
      'utils/importSections.ts',      // import: the merge, and whether an imported alias is new to the written store
    ]);
  });
});
