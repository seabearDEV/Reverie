// The oracle's own model of the run gate's documented rules.
//
// It imports nothing from src/ or dist/ on purpose (#290): a check that
// rebuilds the gate from the code under test shares that code's mistakes.
// Everything here is read from the world on disk with plain `fs`, and the
// rules come from the store notes (context.confirmGate, arch.interpolation,
// arch.scope) and the #279/#280/#289/#292 write-ups:
//
//   - Either list's `true` gates (a project list only inside the project).
//     A name is gated when it matches a flag case aside, or opens the same
//     entry file as a flag in a store a lookup reads (the filesystem's rule,
//     asked of the filesystem here too).
//   - An unreadable `_confirm.json` gates every run; an unreadable
//     `_aliases.json` contributes no aliases.
//   - Aliases are one hop, exact name. Default scope layers the project map
//     over the global one; `-G` (MCP scope "global") reads the global map
//     only; MCP scope "project" reads the project map only.
//   - A run gates every name it looks up: the name as typed, its alias
//     target, and the global alias target when project aliases were in play.
//     That covers each key, each `a:b` segment, a chain entry and each of its
//     members, and every `${…}`/`$(…)` the run reaches.
//   - A reference resolves in the store of the entry that holds it: a global
//     entry's references read the global store only; a project entry's read
//     the project, then the global store. A global chain runs global members.
//
// Two answers come out of it. `reach()` is the closure of everything a run
// can look up, ignoring the depth limit, order and the exec cache: when a run
// executes anything unasked on a correct build, its collect walk completed,
// and a completed walk looks up exactly these names (an entry's references
// resolve the same way whichever path reaches it). `refNames()` is the
// observation-driven subset: the names written in one entry that was seen to
// execute.
import fs from 'node:fs';
import path from 'node:path';

export const STORE_DIRS = { project: 'proj/.reverie', global: 'data/store' };

/** The key rules of the store, as documented for keys: what can name an entry file. */
export function isValidEntryKey(key) {
  if (typeof key !== 'string' || !key || key.startsWith('_')) return false;
  if (key.startsWith('.') || key.endsWith('.')) return false;
  if (key.includes('/') || key.includes('\\') || key.includes('\0')) return false;
  for (const part of key.split('.')) {
    if (!part || part === '..' || part === '__proto__' || part === 'constructor' || part === 'prototype') return false;
  }
  return true;
}

/** A sidecar as documented: missing or empty is an empty map; anything that is not a regular file holding a JSON object is unreadable. */
function readSidecar(file) {
  let st;
  try { st = fs.lstatSync(file); } catch (e) { return e.code === 'ENOENT' ? { map: {} } : { map: {}, irregular: 'stat' }; }
  if (st.isSymbolicLink()) return { map: {}, irregular: 'symlink' };
  if (!st.isFile()) return { map: {}, irregular: 'not-a-file' };
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return { map: {}, irregular: 'read' }; }
  if (!raw.trim()) return { map: {} };
  try {
    const parsed = JSON.parse(raw);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return { map: parsed };
  } catch { /* unparseable */ }
  return { map: {}, irregular: 'unparseable' };
}

function readStore(name, dir) {
  const aliases = readSidecar(path.join(dir, '_aliases.json'));
  const confirm = readSidecar(path.join(dir, '_confirm.json'));
  let names = [];
  try { names = fs.readdirSync(dir).filter(f => f.endsWith('.json') && !f.startsWith('_') && !f.startsWith('.')).map(f => f.slice(0, -5)); } catch { /* no dir */ }
  return {
    name, dir,
    aliases: aliases.irregular ? {} : aliases.map,
    aliasesIrregular: aliases.irregular,
    flags: confirm.irregular ? [] : Object.keys(confirm.map).filter(k => confirm.map[k] === true),
    confirmIrregular: confirm.irregular,
    names,
  };
}

/** The world as the gate would see it from `cwd` ('proj' or 'out'). Read from disk each time it is called. */
export function readWorld(root, cwd) {
  const inProject = cwd !== 'out';
  const P = readStore('project', path.join(root, STORE_DIRS.project));
  const G = readStore('global', path.join(root, STORE_DIRS.global));
  return { root, cwd, inProject, P, G };
}

const store = (w, name) => (name === 'global' ? w.G : w.P);

function aliasMap(w, view) {
  if (view === 'global') return w.G.aliases;
  if (view === 'project') return w.P.aliases;
  return w.inProject ? { ...w.G.aliases, ...w.P.aliases } : w.G.aliases;
}

/** One alias hop, exact name, a trailing colon dropped. */
export function resolve(w, name, view) {
  const clean = name.replace(/:$/, '');
  const m = aliasMap(w, view);
  return Object.hasOwn(m, clean) ? m[clean] : clean;
}

/** The names one lookup gates: as typed, its target, and the global map's target when project aliases were in play. */
export function gateNames(w, typed, resolved, projectAliases) {
  const name = typed.replace(/:$/, '');
  const names = new Set([name, resolved]);
  if (projectAliases) names.add(resolve(w, name, 'global'));
  return [...names];
}

/** Device and inode of the file a key opens in a store dir (stat follows a link, as the gate's own check does). */
function fileId(dir, key) {
  if (!isValidEntryKey(key)) return undefined;
  try {
    const st = fs.statSync(path.join(dir, key + '.json'), { bigint: true });
    return `${st.dev}:${st.ino}`;
  } catch { return undefined; }
}

function leaf(s, key) {
  if (!isValidEntryKey(key)) return undefined;
  const file = path.join(s.dir, key + '.json');
  let st;
  try { st = fs.lstatSync(file); } catch { return undefined; }
  if (!st.isFile()) return undefined;   // a symlinked entry is never read
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed && typeof parsed === 'object' && 'value' in parsed) return { value: parsed.value, store: s.name, file: fileId(s.dir, key) };
  } catch { /* the generator writes none */ }
  return { value: undefined, store: s.name, unreadable: true };
}

function subtree(s, key) {
  const prefix = key + '.';
  return s.names.some(n => n.startsWith(prefix)) ? { value: { subtree: key }, store: s.name } : undefined;
}

/** Where a lookup by key reads: leaves in order (the filesystem decides which spellings open them), then namespaces. */
export function lookup(w, key, view) {
  if (typeof key !== 'string') return undefined;
  const order = view === 'global' ? [w.G] : view === 'project' ? [w.P] : (w.inProject ? [w.P, w.G] : [w.G]);
  for (const s of order) { const v = leaf(s, key); if (v) return v; }
  for (const s of order) { const v = subtree(s, key); if (v) return v; }
  return undefined;
}

/** The view a reference held by an entry of `from` resolves in. */
const refView = from => (from === 'global' ? 'global' : 'auto');

/** Is a name gated by a flag in the lists the run reads? (Case aside, or the same entry file.) */
export function flagged(w, name) {
  const flags = [...(w.inProject ? w.P.flags : []), ...w.G.flags];
  if (flags.length === 0 || typeof name !== 'string') return false;
  const lc = name.toLowerCase();
  if (flags.some(f => f === name || f.toLowerCase() === lc)) return true;
  for (const s of (w.inProject ? [w.P, w.G] : [w.G])) {
    const id = fileId(s.dir, name);
    if (id === undefined) continue;
    if (flags.some(f => fileId(s.dir, f) === id)) return true;
  }
  return false;
}

/** Is a confirmation list the run reads unreadable? Then every run asks. */
export function confirmUnreadable(w) {
  return Boolean((w.inProject && w.P.confirmIrregular) || w.G.confirmIrregular);
}

/** `${…}` refs as `ref` strings and `$(…)` refs as names, as the interpolation scanner finds them. */
export function scanRefs(text) {
  const SENT = '\u0000';
  const p1 = [];
  let out = '';
  let i = 0;
  const braceEnd = start => {   // index of the matching `}`, or -1
    let depth = 1, j = start;
    while (j < text.length && depth > 0) {
      if (text[j] === '{' && j > 0 && text[j - 1] === '$') depth++;
      else if (text[j] === '}') depth--;
      if (depth > 0) j++;
    }
    return depth === 0 ? j : -1;
  };
  while (i < text.length) {
    if (text[i] === '\\' && text[i + 1] === '$' && text[i + 2] === '{') {
      const j = braceEnd(i + 3);
      if (j !== -1) { out += text.slice(i + 1, j + 1); i = j + 1; } else { out += text[i]; i++; }
      continue;
    }
    if (text[i] === '$' && text[i + 1] === '{') {
      const j = braceEnd(i + 2);
      if (j !== -1) {
        const ref = text.slice(i + 2, j);
        if (ref === '') out += '${}';
        else { p1.push(ref); out += SENT; }   // substituted text is never scanned for $(…)
        i = j + 1;
      } else { out += text[i]; i++; }
      continue;
    }
    out += text[i]; i++;
  }
  const p2 = [];
  let refused = false;
  i = 0;
  while (i < out.length) {
    if (out[i] === '\\' && out[i + 1] === '$' && out[i + 2] === '(') {
      const close = out.indexOf(')', i + 3);
      i = close !== -1 ? close + 1 : i + 1;
      continue;
    }
    if (out[i] === '$' && out[i + 1] === '(') {
      const close = out.indexOf(')', i + 2);
      if (close === -1) { i++; continue; }
      const inner = out.slice(i + 2, close);
      if (inner.includes(SENT)) { refused = true; break; }   // `$(${k})`: the key came from a reference
      p2.push(inner.trim());
      i = close + 1;
      continue;
    }
    i++;
  }
  return { p1, p2, refused };
}

/** The key and modifier of a `${…}` ref: the first top-level `:-` or `:?`. */
export function parseRef(ref) {
  let depth = 0;
  for (let i = 0; i < ref.length - 1; i++) {
    if (ref[i] === '$' && ref[i + 1] === '{') { depth++; i++; continue; }
    if (ref[i] === '}' && depth > 0) { depth--; continue; }
    if (depth === 0 && ref[i] === ':' && (ref[i + 1] === '-' || ref[i + 1] === '?')) {
      return { key: ref.slice(0, i), modifier: ref.slice(i, i + 2), modValue: ref.slice(i + 2) };
    }
  }
  return { key: ref };
}

/**
 * Walk the references written in one text held by an entry of `from`.
 * `onEntry(id, found, key)` is called for each entry a reference reaches
 * (a string value); `edge(id)` for each reference to an entry; the names
 * looked up go into `names`, and conditions that stop the collect walk
 * (a `${…}` not found, a `:?`, a non-string `${…}`, a refused `$(${…})`)
 * into `errors`. `:-` bodies are walked when the key is missing there.
 */
function walkText(w, text, from, { names, errors, onEntry, edge }) {
  if (typeof text !== 'string') return;
  const { p1, p2, refused } = scanRefs(text);
  const view = refView(from);
  for (const ref of p1) {
    const { key, modifier, modValue } = parseRef(ref);
    const name = key.trim();
    const resolved = resolve(w, name, view);
    for (const n of gateNames(w, name, resolved, from !== 'global')) names.add(n);
    const found = lookup(w, resolved, view);
    if (!found || found.value === undefined) {
      if (found?.unreadable) { errors.push(`unreadable ${name}`); continue; }
      if (modifier === ':-') walkText(w, modValue ?? '', from, { names, errors, onEntry, edge });
      else errors.push(modifier === ':?' ? `required ${name}` : `missing \${${name}}`);
      continue;
    }
    const id = `${found.store}:${resolved}`;
    edge?.(id);
    if (typeof found.value !== 'string') { errors.push(`not a string \${${name}}`); continue; }
    onEntry?.(id, found, resolved);
  }
  if (refused) errors.push('refused $(${…})');
  for (const name of p2) {
    const resolved = resolve(w, name, view);
    for (const n of gateNames(w, name, resolved, from !== 'global')) names.add(n);
    const found = lookup(w, resolved, view);
    if (!found || typeof found.value !== 'string') continue;   // collect passes it; exec fails there
    const id = `${found.store}:${resolved}`;
    edge?.(id);
    onEntry?.(id, found, resolved);
  }
}

/** The names written in one entry's text (and in the `:-` bodies it takes), in that entry's store view. */
export function refNames(w, text, from) {
  const names = new Set();
  walkText(w, text, from, { names, errors: [] });
  return names;
}

/**
 * Everything a run reaches from its root values: names looked up, entries
 * read (with their entry-file identity), and whether the collect walk must
 * stop (an error condition or a reference cycle anywhere in reach).
 */
export function reach(w, roots) {
  const names = new Set();
  const errors = [];
  const entries = new Map();            // id -> { store, key, file }
  const graph = new Map();              // node -> Set(node)
  const addEdge = (from, to) => { if (!graph.has(from)) graph.set(from, new Set()); graph.get(from).add(to); };
  const visit = (id, found, key) => {
    if (entries.has(id)) return;
    entries.set(id, { store: found.store, key, file: found.file });
    walkText(w, found.value, found.store, { names, errors, onEntry: visit, edge: to => addEdge(id, to) });
  };
  roots.forEach((r, i) => {
    const node = `root#${i}`;
    if (r.id) entries.set(r.id, { store: r.store, key: r.key, file: r.file });
    walkText(w, r.value, r.store, { names, errors, onEntry: visit, edge: to => addEdge(node, to) });
  });
  // A reference cycle stops the walk wherever it is (cycle detection runs before the exec cache).
  const state = new Map();
  const cyclic = node => {
    state.set(node, 1);
    for (const next of graph.get(node) ?? []) {
      const s = state.get(next);
      if (s === 1) return true;
      if (s === undefined && cyclic(next)) return true;
    }
    state.set(node, 2);
    return false;
  };
  for (const node of graph.keys()) if (!state.has(node) && cyclic(node)) { errors.push('cycle'); break; }
  return { names, errors, entries };
}

/**
 * The top level of one invocation: the names it looks up before any value
 * is walked, the root values, and whether it can run at all.
 *   CLI: { surface:'cli', global, chain, keys:[…] }
 *   MCP: { surface:'mcp', scope: undefined|'project'|'global', chain, key }
 */
export function topLevel(w, inv) {
  const names = [];
  const roots = [];
  const fail = why => ({ ok: false, why, names, roots });
  const segmentRoots = (keyGroups, view) => {
    for (const group of keyGroups) {
      for (const segment of group.replace(/:$/, '').split(':')) {
        const resolved = resolve(w, segment, view);
        names.push(...gateNames(w, segment, resolved, view !== 'global'));
        const found = lookup(w, resolved, view);
        if (!found || found.value === undefined) return `not found: ${segment}`;
        if (typeof found.value !== 'string') return `not a string: ${segment}`;
        roots.push({ value: found.value, store: found.store, id: `${found.store}:${resolved}`, key: resolved, file: found.file });
      }
    }
    return null;
  };
  if (inv.surface === 'cli') {
    const view = inv.global ? 'global' : 'auto';
    if (inv.chain) {
      if (inv.keys.length !== 1) return fail('chain takes one key');
      const typed = inv.keys[0];
      const resolved = resolve(w, typed, view);
      const found = lookup(w, resolved, view);
      if (!found || found.value === undefined) return fail(`not found: ${typed}`);
      if (typeof found.value !== 'string') return fail(`not a string: ${typed}`);
      const members = found.value.trim().split(/\s+/);
      if (members.length === 1 && members[0] === '') return fail('empty chain');
      names.push(...gateNames(w, typed, resolved, view !== 'global'));
      const memberView = view === 'global' || found.store === 'global' ? 'global' : 'auto';
      const why = segmentRoots(members, memberView);
      return why ? fail(why) : { ok: true, names, roots };
    }
    const why = segmentRoots(inv.keys, view);
    return why ? fail(why) : { ok: true, names, roots };
  }
  // MCP reverie_run: the key is never split on ':'. Scope "project" with no
  // project falls back to the global store (store.ts resolveStore), lookups
  // and alias map alike; the gate still adds the global alias target.
  const view = inv.scope === 'project' && !w.inProject ? 'global' : (inv.scope ?? 'auto');
  const projectAliases = inv.scope !== 'global';
  const resolved = resolve(w, inv.key, view);
  const found = lookup(w, resolved, view);
  if (!found || found.value === undefined) return fail(`not found: ${inv.key}`);
  names.push(...gateNames(w, inv.key, resolved, projectAliases));
  if (typeof found.value !== 'string') return fail(`not a string: ${inv.key}`);
  if (inv.chain) {
    const members = found.value.trim().split(/\s+/).filter(Boolean);
    if (members.length === 0) return fail('empty chain');
    const memberView = found.store === 'global' ? 'global' : view;
    const memberProjectAliases = found.store === 'global' ? false : projectAliases;
    for (const ck of members) {
      const rk = resolve(w, ck, memberView);
      const member = lookup(w, rk, memberView);
      if (!member || member.value === undefined) return fail(`chain key not found: ${ck}`);
      if (typeof member.value !== 'string') return fail(`chain key not a string: ${ck}`);
      names.push(...gateNames(w, ck, rk, memberProjectAliases));
      roots.push({ value: member.value, store: member.store, id: `${member.store}:${rk}`, key: rk, file: member.file });
    }
    return { ok: true, names, roots };
  }
  roots.push({ value: found.value, store: found.store, id: `${found.store}:${resolved}`, key: resolved, file: found.file });
  return { ok: true, names, roots };
}

/** The entry-file identity of a store's key as the generator wrote it (for markers). */
export function markerFile(w, storeName, key) {
  return fileId(store(w, storeName).dir, key);
}

/** The value stored under a key as written, read straight from its file. */
export function storedValue(w, storeName, key) {
  return leaf(store(w, storeName), key)?.value;
}
