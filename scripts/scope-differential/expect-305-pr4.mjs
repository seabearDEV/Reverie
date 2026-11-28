// The differences ledger PR 4 (#305: L15–L27) makes, against a build before it:
//   bun scripts/scope-differential/diff.mjs --against <main dist> --expect scripts/scope-differential/expect-305-pr4.mjs
//
// The module rebuilds the record of the build before (`b`) into the record
// the change predicts, one rule at a time, and the difference is expected
// only when that is exactly the record of the build under test (`a`). Each
// rule applies where its item applies, and nowhere else:
//
//   README     The store's `_README.md` template names `rm <key>` / `data
//              reset` for an invalid file (L17): a README the build before
//              seeded with the old text is seeded with the new text.
//   L25        A command that wrote nothing to a store (refused, or nothing
//              to write) no longer leaves `_epoch.json`, `_README.md` and
//              `.gitignore` there. These worlds start without them, so where
//              the build under test has none of the three in a store, the
//              build before's are dropped — only when it had all three, the
//              README and .gitignore as seeded and the epoch even.
//   hint       The fix an unparseable alias map's message gives names
//              `data reset aliases` (with -G for the global map) instead of
//              a hand delete (L17), in every output, audit and telemetry row.
//              A row's responseSize moves by exactly the length the replaced
//              text changed, and by nothing else.
//   L15        `set` (a batch too) / `reverie_set` of a name that is no entry
//              while an alias map the lookup reads does not parse: the build
//              before created an entry under the typed name; the build under
//              test refuses with STORE_UNREADABLE naming that map, and writes
//              nothing. Found by the files: every entry file the build
//              before created is one the invocation named, and the build
//              under test has none of them.
//   L23        On a filesystem that folds names (macOS), `remove` /
//              `reverie_remove` of an entry typed in another case: the build
//              before said NOT_FOUND ("exists in the global store" on the
//              CLI); the build under test removes the stored entry and the
//              aliases pointing at it. Never seen on Linux, where `get` finds
//              nothing under that spelling either.
import crypto from 'crypto';
import { layoutNamed, GLOBAL_ENTRIES, PROJECT_ENTRIES } from './lib/worlds.mjs';

const STORES = { project: 'proj/.reverie', global: 'data/store' };
const hashOf = text => `F ${crypto.createHash('sha1').update(text).digest('hex').slice(0, 16)}`;
const epochFile = n => hashOf(`${JSON.stringify({ epoch: n })}\n`);
/** The seeded files, as lib/exec.mjs records them (the README templates hashed from the two builds' seeds). */
const README_BEFORE = 'F f07cf53ea8abb83d';
const README_AFTER = 'F 25a864f9dbaffcff';
const GITIGNORE = hashOf('# Per-clone store state, managed by Reverie — not shared via git.\n_epoch.json\n');

const parse = s => { try { return JSON.parse(s); } catch { return undefined; } };
const same = (x, y) => JSON.stringify(x) === JSON.stringify(y);
const sortKeys = o => Object.fromEntries(Object.entries(o).sort(([x], [y]) => x.localeCompare(y)));
const clone = o => JSON.parse(JSON.stringify(o));

function epochOf(rec) {
  for (let n = 2; n <= 1000; n += 2) if (epochFile(n) === rec) return n;
  return undefined;
}

// ── hint ───────────────────────────────────────────────────────────────

const OLD_FIX = 'delete that file by hand (the store will not remove a file it cannot read).';
const OLD_HINT = /Restore (\S+_aliases\.json) from version control or a backup, or delete that file by hand \(the store will not remove a file it cannot read\)\./g;

/** The new fix for the alias map at `p`, as the CLI (index.js) or the MCP server (mcp-server.js) names itself. */
function newFix(surface, p) {
  const bin = surface === 'cli' ? 'index.js' : 'mcp-server.js';
  const g = p.includes('data/store/_aliases.json') ? ' -G' : '';
  return `remove it: \`${bin} data reset aliases${g}\`, which empties it.`;
}

/** The fix stated once for a list of files (the bootstrap block, a warning block), before and after. */
const OLD_SHARED = 'from version control or a backup, or delete it by hand (the store will not remove a file it cannot read).';
const newShared = surface => {
  const bin = surface === 'cli' ? 'index.js' : 'mcp-server.js';
  return `from version control or a backup, or remove it: \`${bin} rm <key>\` for an entry, \`${bin} data reset aliases\` or \`confirm\` for the alias map or the confirmation list (with -G in the global store).`;
};
const OLD_SHARED_RE = /([Rr]estore each) from version control or a backup, or delete it by hand \(the store will not remove a file it cannot read\)\./g;

/** `s` with every old alias-map hint replaced; `delta` is how many characters that moved it. */
function rehint(surface, s) {
  let delta = 0;
  const out = s.replace(OLD_HINT, (_m, p) => {
    const fix = newFix(surface, p);
    delta += fix.length - OLD_FIX.length;
    return `Restore ${p} from version control or a backup, or ${fix}`;
  }).replace(OLD_SHARED_RE, (_m, lead) => {
    delta += newShared(surface).length - OLD_SHARED.length;
    return `${lead} ${newShared(surface)}`;
  });
  return { out, delta };
}

function rehintResult(surface, result) {
  const { out, delta } = rehint(surface, JSON.stringify(result));
  return { result: JSON.parse(out), delta };
}

function rehintRows(surface, rows) {
  return rows.map(r => rehint(surface, r).out);
}

// ── rows ───────────────────────────────────────────────────────────────

/**
 * Rows of the two records the same, key order aside: `expected` (the build
 * before's, rebuilt) against `actual`. A row's responseSize must move by
 * `delta` when the build before's was not 0 (a batch's earlier pairs report
 * 0 on both), unless `anySize`: a refusal's response is another text.
 */
function rowsMatch(expected, actual, delta, anySize = false) {
  if (expected.length !== actual.length) return false;
  return expected.every((er, i) => {
    const e = parse(er), x = parse(actual[i]);
    if (!e || !x) return er === actual[i];
    if ('responseSize' in e !== 'responseSize' in x) return false;
    if ('responseSize' in e && !anySize) {
      const want = e.responseSize === 0 ? 0 : e.responseSize + delta;
      if (x.responseSize !== want) return false;
    }
    const strip = r => { const c = { ...r }; delete c.responseSize; return sortKeys(c); };
    return same(strip(e), strip(x));
  });
}

// ── README and L25 ─────────────────────────────────────────────────────

/** b's files with the README rule and the L25 rule applied, judged against a's; the rules used. */
function scaffold(aFiles, bFiles) {
  const files = { ...bFiles };
  const used = new Set();
  for (const dir of Object.values(STORES)) {
    const readme = `${dir}/_README.md`, gi = `${dir}/.gitignore`, ep = `${dir}/_epoch.json`;
    if (files[readme] === README_BEFORE && aFiles[readme] === README_AFTER) {
      files[readme] = README_AFTER;
      used.add('README');
    }
    if (!(readme in aFiles) && !(gi in aFiles) && !(ep in aFiles)
      && (files[readme] === README_BEFORE || files[readme] === README_AFTER)
      && files[gi] === GITIGNORE && epochOf(files[ep]) !== undefined) {
      delete files[readme];
      delete files[gi];
      delete files[ep];
      used.add('L25');
    }
  }
  return { files, used };
}

// ── L15 ────────────────────────────────────────────────────────────────

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

/** The names a set invocation writes, in order, and whether it is one. */
function setNames(inv) {
  if (inv.surface === 'cli') {
    if (inv.argv[0] !== 'set') return null;
    const args = inv.argv.slice(1);
    if (args[0]?.includes('=')) return args.filter(x => x.includes('=')).map(x => x.slice(0, x.indexOf('=')));
    return [args[0]];
  }
  return inv.tool === 'reverie_set' && typeof inv.args.key === 'string' && inv.args.value !== undefined ? [inv.args.key] : null;
}

const refusal = (name, p, fix) =>
  `Refusing to set '${name}', which may be an alias in an alias map that cannot be read: ${p} is not a valid store file. Nothing was written. Restore ${p} from version control or a backup, or ${fix} Then retry.`;

/**
 * L15: what the build under test gives, rebuilt from the build before's
 * record, or null when this is not that case.
 */
function l15(inv, a, b, files) {
  const names = setNames(inv);
  if (!names) return null;
  const maps = unreadableMapsRead(inv);
  if (maps.length !== 1) return null;
  // The entry files the build before created that the build under test does not have.
  const created = Object.keys(files).filter(p => !(p in a.files) && /\.json$/.test(p) && !/\/_/.test(p) && !p.endsWith('/_epoch.json'));
  if (created.length === 0) return null;
  const createdNames = created.map(p => p.slice(p.lastIndexOf('/') + 1, -'.json'.length));
  if (!createdNames.every(n => names.includes(n)) || createdNames.length !== names.length) return null;
  for (const p of created) delete files[p];
  // An alias the build before set with the value (`-a`, `alias`): the map as the world had it.
  const aliasNew = inv.surface === 'cli' ? inv.argv[inv.argv.indexOf('-a') + 1] : inv.args.alias;
  const hasAlias = inv.surface === 'cli' ? inv.argv.includes('-a') : typeof inv.args.alias === 'string';
  for (const [store, dir] of Object.entries(STORES)) {
    const p = `${dir}/_aliases.json`;
    if (files[p] === a.files[p]) continue;
    if (!hasAlias) return null;
    const before = parse(b.sidecars[`${store}/_aliases.json`]);
    const after = parse(a.sidecars[`${store}/_aliases.json`]);
    const initial = layoutNamed(inv.world).aliases[store === 'project' ? 0 : 1];
    if (!before || !after || initial.$irregular || !same(sortKeys(after), sortKeys(initial))) return null;
    if (!(aliasNew in before) || same(sortKeys(before), sortKeys(after))) return null;
    files[p] = a.files[p];
  }
  // The map's path as the build names it, from the warning or text of the build before.
  const map = maps[0];
  const fileName = map === 'global' ? 'data/store/_aliases.json' : '.reverie/_aliases.json';
  const text = inv.surface === 'cli' ? JSON.stringify(b.result.stdout) : b.result.text;
  const m = text.match(new RegExp(`([^\\s"]*${fileName.replace(/[.]/g, '\\.')}) is not a valid store file`));
  if (!m) return null;
  const p = m[1];
  const fix = newFix(inv.surface, p);
  const last = names[names.length - 1];
  let result;
  if (inv.surface === 'cli') {
    const out = b.result.stdout;
    if (typeof out !== 'object' || out.ok !== true || b.result.exit !== 0) return null;
    result = {
      exit: 1, signal: null,
      stdout: { reverie: '1', ok: false, command: 'set', warnings: rehintResult('cli', out.warnings ?? []).result, error: { code: 'STORE_UNREADABLE', message: refusal(last, p, fix) } },
      stderr: b.result.stderr,
    };
  } else {
    if (b.result.isError) return null;
    const block = JSON.stringify({ code: 'STORE_UNREADABLE', attempted: 'write', files: [{ kind: 'aliases', file: p, reason: 'parse' }] }, null, 2);
    result = { text: [refusal(last, p, fix), '```json', ...block.split('\n'), '```'].join('\n'), isError: true };
  }
  // The rows: each pair refused, nothing after it, the refusal's own error text over MCP.
  const refuseRow = (r, i) => {
    const row = parse(rehint(inv.surface, r).out);
    if (!row || row.success !== true) return undefined;
    delete row.after;
    row.success = false;
    row.errorCode = 'STORE_UNREADABLE';
    row.refusedReason = 'store_unreadable';
    if (inv.surface === 'mcp' && 'params' in row && 'key' in row) row.error = `StoreUnreadableError: ${refusal(names[i] ?? last, p, fix)}`;
    return JSON.stringify(row);
  };
  const audit = b.audit.map(refuseRow);
  const telemetry = b.telemetry.map(refuseRow);
  if (audit.includes(undefined) || telemetry.includes(undefined)) return null;
  return { rule: 'L15', result, audit, telemetry };
}

// ── L23 ────────────────────────────────────────────────────────────────

/** L23: a removal of an entry typed in another case, rebuilt; null when this is not that case. */
function l23(inv, a, b, files) {
  if (inv.world !== 'case') return null;
  let typed, store;
  if (inv.surface === 'cli') {
    if (inv.argv[0] !== 'remove' || inv.argv.includes('-a')) return null;
    typed = inv.argv[1];
    store = inv.argv.includes('-G') ? 'global' : 'project';
  } else {
    if (inv.tool !== 'reverie_remove' || inv.args.is_alias) return null;
    typed = inv.args.key;
    store = inv.args.scope === 'global' ? 'global' : 'project';
  }
  if (inv.cwd === 'out' && store === 'project') return null;
  const entries = store === 'global' ? GLOBAL_ENTRIES : PROJECT_ENTRIES;
  const stored = Object.keys(entries).find(k => k !== typed && k.toLowerCase() === typed.toLowerCase());
  if (stored === undefined) return null;
  const dir = STORES[store];
  const entryFile = `${dir}/${stored}.json`;
  if (!(entryFile in files) || entryFile in a.files) return null;
  delete files[entryFile];
  // The aliases pointing at it or under it go in the same write.
  const before = parse(b.sidecars[`${store}/_aliases.json`]) ?? {};
  const want = Object.fromEntries(Object.entries(before).filter(([, t]) => t !== stored && !t.startsWith(`${stored}.`)));
  const after = parse(a.sidecars[`${store}/_aliases.json`]);
  if (!after || !same(sortKeys(after), sortKeys(want))) return null;
  files[`${dir}/_aliases.json`] = a.files[`${dir}/_aliases.json`];
  let result;
  if (inv.surface === 'cli') {
    if (b.result.exit !== 1 || b.result.stdout?.error?.code !== 'NOT_FOUND') return null;
    result = { exit: 0, signal: null, stdout: { reverie: '1', ok: true, command: 'remove', result: { key: typed, removed: true } }, stderr: b.result.stderr };
  } else {
    if (b.result.text !== `Key '${typed}' not found.`) return null;
    result = { text: `Removed: ${typed}`, isError: false };
  }
  const succeed = r => {
    const row = parse(r);
    if (!row || row.errorCode !== 'NOT_FOUND') return undefined;
    delete row.errorCode;
    delete row.error;
    row.success = true;
    return JSON.stringify(row);
  };
  const audit = b.audit.map(succeed);
  const telemetry = b.telemetry.map(succeed);
  if (audit.includes(undefined) || telemetry.includes(undefined)) return null;
  return { rule: 'L23', result, audit, telemetry };
}

// ── the rule ───────────────────────────────────────────────────────────

export default function expect305pr4(inv, a, b) {
  const scaffolded = scaffold(a.files, b.files);
  const rules = [...scaffolded.used];
  let files = scaffolded.files;
  // An item rule rebuilds the files on a copy, adopted only when it applies.
  const itemFiles = { ...files };
  const item = l15(inv, a, b, itemFiles) ?? l23(inv, a, b, itemFiles);
  if (item) {
    files = itemFiles;
    rules.push(item.rule);
    if (!same(item.result, a.result)) return null;
    if (!rowsMatch(item.audit, a.audit, 0, true) || !rowsMatch(item.telemetry, a.telemetry, 0, true)) return null;
  } else {
    if (!same(a.sidecars, b.sidecars)) return null;
    const { result, delta } = rehintResult(inv.surface, b.result);
    if (delta !== 0) rules.push('hint');
    if (!same(result, a.result)) return null;
    if (!rowsMatch(rehintRows(inv.surface, b.audit), a.audit, delta)) return null;
    if (!rowsMatch(rehintRows(inv.surface, b.telemetry), a.telemetry, delta)) return null;
  }
  if (!same(sortKeys(files), sortKeys(a.files))) return null;
  return rules.length === 0 ? null : rules.join(' + ');
}
