// The differences #260's fix makes, against a build before it:
//   bun scripts/scope-differential/diff.mjs --against <main dist> --expect scripts/scope-differential/expect-260.mjs
//
// The rule (owner, 2026-11-27): each store's alias list changes only for the
// aliases that live in it; a command in one scope never writes the other
// store's list. Every difference must be one of these, from inside the
// project, without -G or an MCP scope:
//   rule 1  a rename re-points the project's aliases only, and names each
//           global alias that still points at what it moved
//   rule 3  an alias removal by name removes the project's alias only; it
//           names a global alias of the name that still resolves, and
//           refuses (NOT_FOUND, nothing changed) when only the global store
//           has it
// Rule 2 (copies already in a project list stay) is an absence of change: a
// difference there is unexpected. Each predicate is exact: the global store
// the same on both builds, byte for byte; the project's list what the rule
// leaves; and the lines the fix adds exactly the ones the world calls for —
// none missing, none extra.
import { layoutNamed } from './lib/worlds.mjs';

const PROJECT_ALIASES = 'proj/.reverie/_aliases.json';
/** What a write the fix no longer makes leaves behind on the build before it: the list, the commit counter, the scaffolding of a store's first write. */
const WRITE_TRACES = new Set([PROJECT_ALIASES, 'proj/.reverie/_epoch.json', 'proj/.reverie/_README.md', 'proj/.reverie/.gitignore']);

const parse = s => { try { return JSON.parse(s); } catch { return undefined; } };
const same = (x, y) => JSON.stringify(x) === JSON.stringify(y);
const sorted = xs => [...xs].sort();
const own = (m, n) => !!m && !m.$irregular && Object.hasOwn(m, n);

function filesDifferOnlyIn(a, b, allowed) {
  const paths = new Set([...Object.keys(a.files), ...Object.keys(b.files)]);
  return [...paths].every(p => a.files[p] === b.files[p] || allowed.has(p));
}

/** The lines (CLI warnings, MCP note lines) the fix added, or null when anything else in the output differs. */
function addedLines(inv, a, b) {
  if (inv.surface === 'cli') {
    const ea = a.result.stdout, eb = b.result.stdout;
    if (typeof ea !== 'object' || typeof eb !== 'object' || a.result.exit !== b.result.exit) return null;
    if (!same({ ...ea, warnings: undefined }, { ...eb, warnings: undefined })) return null;
    const wa = (ea.warnings ?? []).map(w => w.message), wb = (eb.warnings ?? []).map(w => w.message);
    if (!same(wa.slice(0, wb.length), wb) && !wb.every(w => wa.includes(w))) return null;
    return wa.filter(w => !wb.includes(w));
  }
  if (a.result.isError !== b.result.isError) return null;
  const ta = a.result.text.split('\n'), tb = b.result.text.split('\n');
  if (!same(ta.slice(0, tb.length), tb)) return null;
  return ta.slice(tb.length);
}

const LEFT = /^(?:note: )?The global alias '([^']+)' still points at '([^']+)'/;
const STILL = /^(?:note: )?A global alias '([^']+)' \(-> ([^)]+)\) still resolves here\. To remove it too, pass /;
const GLOBAL_ONLY = /^Alias '([^']+)' is a global alias \(-> ([^)]+)\), not one of this project's, so nothing was removed\. To remove it, pass /;

/** The key a rename moved, as the build before the fix reported it. */
function renamedSource(inv, b) {
  if (inv.surface === 'cli') return b.result.stdout?.ok ? b.result.stdout.result?.from : undefined;
  const m = /^Renamed: (\S+) -> /.exec(b.result.text);
  return m ? m[1] : undefined;
}

export default function expectation(inv, a, b) {
  if (inv.cwd !== 'proj') return null;
  if (a.audit.length !== b.audit.length || a.telemetry.length !== b.telemetry.length) return null;
  const scoped = inv.surface === 'cli' ? inv.argv.includes('-G') || inv.argv.includes('-P') : inv.args.scope !== undefined;
  if (scoped) return null;
  const [P0, G0] = layoutNamed(inv.world).aliases;
  const Pa = parse(a.sidecars['project/_aliases.json']);
  const Pb = parse(b.sidecars['project/_aliases.json']);
  const lines = addedLines(inv, a, b);
  if (!filesDifferOnlyIn(a, b, WRITE_TRACES) || !Pa || !Pb || P0.$irregular) return null;

  const rename = inv.surface === 'cli' ? inv.argv[0] === 'rename' && inv.argv[1] !== '-a' : inv.tool === 'reverie_rename' && !inv.args.is_alias;
  if (rename) {
    const source = renamedSource(inv, b);
    if (source === undefined || lines === null) return null;
    // The notes: exactly the global aliases pointing at the source or under it.
    const pointing = G0.$irregular ? [] : Object.entries(G0).filter(([, t]) => t === source || t.startsWith(`${source}.`));
    const noted = lines.map(l => LEFT.exec(l)).map(m => (m ? `${m[1]}=${m[2]}` : '?'));
    if (!same(sorted(noted), sorted(pointing.map(([n, t]) => `${n}=${t}`)))) return null;
    // The project's list: what the build before wrote, less the global aliases it copied.
    const copied = Object.keys(Pb).filter(n => !Object.hasOwn(P0, n) && own(G0, n));
    const expected = Object.fromEntries(Object.entries(Pb).filter(([n]) => !copied.includes(n)));
    if (same(sorted(Object.entries(Pa).map(e => e.join('='))), sorted(Object.entries(expected).map(e => e.join('='))))) {
      return 'rule 1: a rename re-points the project\'s aliases only, and names the global ones it left';
    }
    // Anything else is read by hand: the build before chose a different alias to drop for --set-alias, say.
    return 'rule 1 (residue: read by hand)';
  }

  const cliRemoval = inv.surface === 'cli' && ((inv.argv[0] === 'alias' && inv.argv[1] === 'remove') || (inv.argv[0] === 'remove' && inv.argv[1] === '-a'));
  const mcpRemoval = inv.surface === 'mcp' && (inv.tool === 'reverie_alias_remove' || (inv.tool === 'reverie_remove' && inv.args.is_alias === true));
  if (cliRemoval || mcpRemoval) {
    const name = inv.surface === 'cli' ? inv.argv[inv.argv.length - 1] : (inv.args.alias ?? inv.args.key);
    const inProject = name in P0;            // the `in` test the removal has always used
    const global = own(G0, name) ? G0[name] : undefined;
    const { [name]: _gone, ...rest } = P0;
    if (inProject) {
      if (lines === null) return null;
      // Removed from the project; a note exactly when a global alias of the name still resolves.
      if (!same(sorted(Object.entries(Pa)), sorted(Object.entries(Object.hasOwn(P0, name) ? rest : P0)))) return null;
      const want = global === undefined ? [] : [`${name}=${global}`];
      const got = lines.map(l => STILL.exec(l)).map(m => (m ? `${m[1]}=${m[2]}` : '?'));
      if (G0.$irregular) {
        // Asking for a global alias of the name reads the global list; where it cannot be read, the command says so (#215).
        if (lines.length > 0 && lines.every(l => /data\/store\/_aliases\.json/.test(l))) return 'rule 3: a removal reads the global list, and reports it unreadable';
        if (lines.length === 0) return 'rule 3: a removal changes the project\'s list only (no global alias copied)';
        return null;
      }
      if (!same(got, want)) return null;
      return want.length ? 'rule 3: a removal names a global alias of the name that still resolves' : 'rule 3: a removal changes the project\'s list only (no global alias copied)';
    }
    if (global !== undefined) {
      // Only the global store has it: refused, nothing changed, named as global.
      if (!same(Pa, P0)) return null;
      if (inv.surface === 'cli' && !same(a.result.stdout?.warnings ?? [], b.result.stdout?.warnings ?? [])) return null;
      const message = inv.surface === 'cli' ? a.result.stdout?.error?.code === 'NOT_FOUND' && a.result.stdout.error.message : a.result.isError && a.result.text;
      const m = GLOBAL_ONLY.exec(message || '');
      if (m && m[1] === name && m[2] === global) return 'rule 3: a removal of a global-only alias refuses, naming it global';
      return null;
    }
    return null;
  }
  return null;
}
