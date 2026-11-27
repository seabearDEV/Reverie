// A world: two stores on disk built from a JSON spec, plus the directories a
// run starts from. Every path is under one temp root:
//   home/            HOME for every child
//   data/store/      the global store ($RVR_DATA_DIR/store)
//   proj/.reverie/   the project store; proj/ is the "inside" cwd
//   out/             a cwd outside any project
//   aside/           targets of symlinked sidecars
//   tmp/             TMPDIR
//   log              where every generated command appends its marker
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { STORE_DIRS } from './model.mjs';

/** Refuse a work root that a project lookup walking up from it could mistake for (or migrate into) a project. */
export function assertSafeRoot(root) {
  let dir = path.resolve(root);
  for (;;) {
    for (const name of ['.reverie', '.codexcli', '.codexcli.json']) {
      if (fs.existsSync(path.join(dir, name))) {
        throw new Error(`refusing work root ${root}: ${path.join(dir, name)} exists above it, so a run from "out" would find that store`);
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}

function writeSidecar(root, dir, file, data) {
  if (data === undefined) return;
  const p = path.join(dir, file);
  const irregular = data && typeof data === 'object' && !Array.isArray(data) ? data.$irregular : undefined;
  if (!irregular) { fs.writeFileSync(p, JSON.stringify(data, null, 2)); return; }
  switch (irregular) {
    case 'dir':
      fs.mkdirSync(p);
      fs.writeFileSync(path.join(p, 'inner.json'), JSON.stringify(data.content ?? {}));
      break;
    case 'symlink': {
      // The target holds a valid map: a build that follows the link reads it.
      const target = path.join(root, 'aside', `${path.basename(dir)}-${file}`);
      fs.writeFileSync(target, JSON.stringify(data.content ?? {}));
      fs.symlinkSync(target, p);
      break;
    }
    case 'dangling':
      fs.symlinkSync(path.join(root, 'aside', 'nowhere.json'), p);
      break;
    case 'garbage': fs.writeFileSync(p, '{"oops": tru'); break;
    case 'array': fs.writeFileSync(p, JSON.stringify(Object.keys(data.content ?? { a: 1 }))); break;
    case 'null': fs.writeFileSync(p, 'null'); break;
    case 'empty': fs.writeFileSync(p, ''); break;
    default: throw new Error(`unknown irregular sidecar ${irregular}`);
  }
}

export function buildWorld(root, spec) {
  fs.rmSync(root, { recursive: true, force: true });
  for (const d of ['home', STORE_DIRS.global, STORE_DIRS.project, 'out', 'aside', 'tmp']) fs.mkdirSync(path.join(root, d), { recursive: true });
  for (const [name, rel] of Object.entries(STORE_DIRS)) {
    const st = spec.stores[name];
    if (!st) continue;
    const dir = path.join(root, rel);
    for (const [key, value] of Object.entries(st.entries ?? {})) {
      fs.writeFileSync(path.join(dir, key + '.json'), JSON.stringify({ value, meta: { created: 1, updated: 1 } }, null, 2));
    }
    writeSidecar(root, dir, '_aliases.json', st.aliases);
    writeSidecar(root, dir, '_confirm.json', st.confirm);
  }
}

/**
 * Both stores, byte for byte (lstat: type, bytes, link target), and the store
 * lock siblings. Three store-root files are left out: `_epoch.json` (a commit
 * counter that a refused commit legitimately moves by two; leftovers() checks
 * it is even) and the scaffolding a store's first write creates, `_README.md`
 * and `.gitignore`. A world is built without them, as a hand-made or cloned
 * store can be.
 */
const SCAFFOLD = new Set(['_epoch.json', '_README.md', '.gitignore']);
export function snapshot(root) {
  const lines = [];
  const walk = (abs, rel, top = false) => {
    if (top && SCAFFOLD.has(path.basename(abs))) return;
    let st;
    try { st = fs.lstatSync(abs); } catch { return; }
    if (st.isSymbolicLink()) { lines.push(`L ${rel} -> ${fs.readlinkSync(abs)}`); return; }
    if (st.isDirectory()) {
      lines.push(`D ${rel}`);
      const isStore = Object.values(STORE_DIRS).includes(rel);
      for (const f of fs.readdirSync(abs).sort()) walk(path.join(abs, f), `${rel}/${f}`, isStore);
      return;
    }
    lines.push(`F ${rel} ${crypto.createHash('sha1').update(fs.readFileSync(abs)).digest('hex')}`);
  };
  for (const rel of Object.values(STORE_DIRS)) {
    walk(path.join(root, rel), rel);
    walk(path.join(root, rel + '.lock'), rel + '.lock');
  }
  return lines.join('\n');
}

/** What a finished invocation must not leave: an odd `_epoch.json`, a lock file. */
export function leftovers(root) {
  const problems = [];
  for (const rel of Object.values(STORE_DIRS)) {
    const epochFile = path.join(root, rel, '_epoch.json');
    if (fs.existsSync(epochFile)) {
      let epoch;
      try { epoch = JSON.parse(fs.readFileSync(epochFile, 'utf8')).epoch; } catch { epoch = 'unparseable'; }
      if (!Number.isSafeInteger(epoch) || epoch % 2 !== 0) problems.push(`${rel}/_epoch.json is ${JSON.stringify(epoch)}`);
    }
  }
  const scan = (abs, rel) => {
    let st;
    try { st = fs.lstatSync(abs); } catch { return; }
    if (abs.endsWith('.lock')) problems.push(`lock left behind: ${rel}`);
    if (st.isDirectory() && !st.isSymbolicLink()) for (const f of fs.readdirSync(abs)) scan(path.join(abs, f), `${rel}/${f}`);
  };
  scan(path.join(root, 'proj'), 'proj');
  scan(path.join(root, 'data'), 'data');
  return problems;
}

/** Each store's flags (keys listed `true`), or null when its `_confirm.json` is not a readable map. */
export function flagLists(root) {
  const out = {};
  for (const [name, rel] of Object.entries(STORE_DIRS)) {
    const file = path.join(root, rel, '_confirm.json');
    let st;
    try { st = fs.lstatSync(file); } catch { out[name] = []; continue; }
    if (!st.isFile()) { out[name] = null; continue; }
    try {
      const raw = fs.readFileSync(file, 'utf8');
      const m = raw.trim() ? JSON.parse(raw) : {};
      out[name] = m && typeof m === 'object' && !Array.isArray(m) ? Object.keys(m).filter(k => m[k] === true) : null;
    } catch { out[name] = null; }
  }
  return out;
}
