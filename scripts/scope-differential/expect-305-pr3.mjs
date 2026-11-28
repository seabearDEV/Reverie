// The differences ledger PR 3 (#305: L6–L13) makes, against a build before it:
//   bun scripts/scope-differential/diff.mjs --against <main dist> --expect scripts/scope-differential/expect-305-pr3.mjs
//
// Two items change what a command in these worlds does; every difference must
// be one of them, exactly:
//   L6 (#268)  `remove` / `reverie_remove` takes the entry and the aliases
//              pointing at it in one store write. The build before wrote the
//              alias list in a second write, so the only trace is that
//              store's commit counter: the result, the logs and every other
//              file the same, both alias lists the same as the build before
//              left them — and that store's list really changed, or there
//              was no second write to save.
//   L13        `get` / `reverie_get` of a name that is no entry, while an
//              alias map the lookup reads does not parse, fails with
//              STORE_UNREADABLE naming that map instead of NOT_FOUND. The
//              maps a lookup reads: both in the default scope inside the
//              project, the global one with -G / scope "global" or outside
//              the project, the project's for MCP scope "project".
// Each predicate checks what changed as well as where, word for word.
import { layoutNamed } from './lib/worlds.mjs';

const STORE_OF_EPOCH = { 'proj/.reverie/_epoch.json': 'project', 'data/store/_epoch.json': 'global' };

const parse = s => { try { return JSON.parse(s); } catch { return undefined; } };
const same = (x, y) => JSON.stringify(x) === JSON.stringify(y);
/** An alias map as the record's sidecars hold it, keys sorted, or the irregular marker. */
const mapOf = s => {
  const m = s === null ? {} : parse(s);
  return m && typeof m === 'object' ? Object.fromEntries(Object.entries(m).sort(([a], [b]) => a.localeCompare(b))) : { $unparsed: s };
};

/** The world's own alias map for `store`, as the record would hold it. */
function initialMap(world, store) {
  const m = layoutNamed(world).aliases[store === 'project' ? 0 : 1];
  return m.$irregular ? undefined : Object.fromEntries(Object.entries(m).sort(([a], [b]) => a.localeCompare(b)));
}

function isRemove(inv) {
  if (inv.surface === 'cli') return inv.argv[0] === 'remove' && !inv.argv.includes('-a');
  return inv.tool === 'reverie_remove' && !inv.args.is_alias;
}

/** L6: only the written store's _epoch.json differs, and the build before did write that store's alias list. */
function oneWrite(inv, a, b, diffs) {
  if (!isRemove(inv)) return null;
  if (diffs.length !== 1 || diffs[0].part !== 'files') return null;
  const files = diffs[0].files;
  if (files.length !== 1) return null;
  const store = STORE_OF_EPOCH[files[0].path];
  if (store === undefined || files[0].a === null || files[0].b === null) return null;
  if (!same(a.sidecars, b.sidecars)) return null;
  const before = initialMap(inv.world, store);
  if (before === undefined) return null;
  const after = mapOf(b.sidecars[`${store}/_aliases.json`]);
  if (same(after, before)) return null;   // no alias dropped: the build before made one write too
  return 'L6: remove drops the aliases in the same write (one commit, not two)';
}

/** The alias maps a lookup in this invocation reads that the world made unparseable. */
function unreadableMapsRead(inv) {
  const layout = layoutNamed(inv.world);
  let stores;
  if (inv.surface === 'cli') {
    stores = inv.argv.includes('-G') || inv.cwd === 'out' ? ['global'] : ['project', 'global'];
  } else {
    const scope = inv.args.scope;
    stores = scope === 'global' ? ['global'] : scope === 'project' ? ['project'] : inv.cwd === 'out' ? ['global'] : ['project', 'global'];
  }
  return stores.filter(s => layout.aliases[s === 'project' ? 0 : 1].$irregular);
}

const unreadableMessage = p => `Cannot read the alias map: ${p} is not a valid store file. It exists; this is not "not found". Restore ${p} from version control or a backup, or delete that file by hand (the store will not remove a file it cannot read).`;
const warningLine = p => `${p} is not a valid store file — no aliases are being read. Restore ${p} from version control or a backup, or delete that file by hand (the store will not remove a file it cannot read).`;

/**
 * The audit and telemetry rows: the same but for errorCode NOT_FOUND →
 * STORE_UNREADABLE, the response size, and (audit, when the build reports
 * one) the error text carrying the new message.
 */
function rowsMoveToUnreadable(rowsA, rowsB, message, errorPrefix) {
  if (rowsA.length !== rowsB.length) return false;
  return rowsA.every((ra, i) => {
    const ja = parse(ra), jb = parse(rowsB[i]);
    if (!ja || !jb) return false;
    if (ja.errorCode !== 'STORE_UNREADABLE' || jb.errorCode !== 'NOT_FOUND') return false;
    if ('error' in ja && ja.error !== `${errorPrefix}${message}`) return false;
    const strip = r => { const c = { ...r }; delete c.errorCode; delete c.responseSize; delete c.error; return c; };
    if ('error' in jb && !('error' in ja)) return false;
    return same(strip(ja), strip(jb));
  });
}

/** L13 on the CLI: `get <name>` [-G], NOT_FOUND → STORE_UNREADABLE naming the one unparseable map read. */
function cliGet(inv, a, b, diffs) {
  if (inv.surface !== 'cli' || inv.argv[0] !== 'get') return null;
  const rest = inv.argv.slice(1).filter(x => x !== '-G');
  if (rest.length !== 1 || rest[0].startsWith('-')) return null;
  const name = rest[0];
  if (unreadableMapsRead(inv).length !== 1) return null;
  if (diffs.some(d => d.part === 'files')) return null;
  const ra = a.result, rb = b.result;
  if (ra.exit !== 1 || rb.exit !== 1 || ra.stderr !== rb.stderr) return null;
  const ea = ra.stdout, eb = rb.stdout;
  if (typeof ea !== 'object' || typeof eb !== 'object') return null;
  if (eb.error?.code !== 'NOT_FOUND' || eb.error?.message !== `Entry '${name}' not found`) return null;
  // The map's path as this build names it: the one alias-map warning both builds give.
  const warns = (eb.warnings ?? []).map(w => w.message).filter(m => m.includes('_aliases.json is not a valid store file'));
  if (warns.length !== 1) return null;
  const p = warns[0].slice(0, warns[0].indexOf(' is not a valid store file'));
  if (warns[0] !== warningLine(p)) return null;
  const message = unreadableMessage(p);
  if (!same({ ...ea, error: undefined }, { ...eb, error: undefined })) return null;
  if (ea.error?.code !== 'STORE_UNREADABLE' || ea.error?.message !== message) return null;
  if (!rowsMoveToUnreadable(a.audit, b.audit, message, 'StoreUnreadableError: ')) return null;
  if (!rowsMoveToUnreadable(a.telemetry, b.telemetry, message, 'StoreUnreadableError: ')) return null;
  return 'L13: cli get of a miss while a map it reads is unreadable is STORE_UNREADABLE';
}

/** L13 over MCP: `reverie_get {key}`, "Key '…' not found." → the STORE_UNREADABLE block naming the map. */
function mcpGet(inv, a, b, diffs) {
  if (inv.surface !== 'mcp' || inv.tool !== 'reverie_get') return null;
  const { key } = inv.args;
  if (typeof key !== 'string' || Object.keys(inv.args).some(k => k !== 'key' && k !== 'scope')) return null;
  if (unreadableMapsRead(inv).length !== 1) return null;
  if (diffs.some(d => d.part === 'files')) return null;
  const ta = a.result.text, tb = b.result.text;
  if (a.result.isError !== true || b.result.isError !== true) return null;
  const linesB = tb.split('\n');
  if (linesB[0] !== `Key '${key}' not found.`) return null;
  const warn = linesB.slice(1).find(l => l.startsWith('warning: ') && l.includes('_aliases.json is not a valid store file'));
  if (!warn) return null;
  const p = warn.slice('warning: '.length, warn.indexOf(' is not a valid store file'));
  if (warn !== `warning: ${warningLine(p)}`) return null;
  const message = unreadableMessage(p);
  const block = JSON.stringify({ code: 'STORE_UNREADABLE', attempted: 'read', files: [{ kind: 'aliases', file: p, reason: 'parse' }] }, null, 2);
  // The map is named by the error, so its warning line goes; any other line stays.
  const others = linesB.slice(1).filter(l => l !== warn);
  const expected = [message, '```json', ...block.split('\n'), '```', ...others].join('\n');
  if (ta !== expected) return null;
  if (!rowsMoveToUnreadable(a.audit, b.audit, message, 'StoreUnreadableError: ')) return null;
  if (!rowsMoveToUnreadable(a.telemetry, b.telemetry, message, 'StoreUnreadableError: ')) return null;
  return 'L13: reverie_get of a miss while a map it reads is unreadable is STORE_UNREADABLE';
}

export default function expect305pr3(inv, a, b, diffs) {
  return oneWrite(inv, a, b, diffs) ?? cliGet(inv, a, b, diffs) ?? mcpGet(inv, a, b, diffs);
}
