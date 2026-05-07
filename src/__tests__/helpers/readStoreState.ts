/**
 * Test helper that reads a v1.10.0 file-per-entry store directory and
 * reconstitutes the legacy UnifiedData shape (`{entries, aliases, confirm, _meta}`)
 * that most existing tests assert against. Lets tests migrate to the new
 * layout without rewriting every assertion.
 *
 * Falls back to reading a pre-migration `data.json` in the same parent directory
 * if the store directory doesn't exist yet, so tests that set up the old format
 * and trigger migration via the store API can still read the pre-migration state.
 */
import fs from 'fs';
import path from 'path';

export interface ReconstitutedStoreState {
  entries: Record<string, unknown>;
  aliases: Record<string, unknown>;
  confirm: Record<string, unknown>;
  _meta?: Record<string, number>;
}

/**
 * Read a store directory (containing entry wrappers and sidecars) and
 * reconstruct the UnifiedData shape. If the directory doesn't exist, fall
 * back to reading `<dataDir>/data.json` (the legacy pre-migration file).
 *
 * @param dataDir  The parent directory containing either `store/` (new) or
 *                 `data.json` (legacy). For project stores, pass the path to
 *                 the `.reverie/` directory directly as `storeDir` instead.
 * @param storeDir Optional absolute path to the store directory. If omitted,
 *                 defaults to `path.join(dataDir, 'store')`.
 */
export function readStoreState(dataDir: string, storeDir?: string): ReconstitutedStoreState {
  const resolvedStoreDir = storeDir ?? path.join(dataDir, 'store');

  if (fs.existsSync(resolvedStoreDir) && fs.statSync(resolvedStoreDir).isDirectory()) {
    return readDirectoryStore(resolvedStoreDir);
  }

  // Pre-migration fallback
  const legacyPath = path.join(dataDir, 'data.json');
  if (fs.existsSync(legacyPath)) {
    return JSON.parse(fs.readFileSync(legacyPath, 'utf8')) as ReconstitutedStoreState;
  }

  return { entries: {}, aliases: {}, confirm: {} };
}

/**
 * Read a store directory (or a project `.reverie/` directory) and reconstruct
 * the UnifiedData shape.
 */
export function readDirectoryStore(storeDir: string): ReconstitutedStoreState {
  const entries: Record<string, unknown> = {};
  const meta: Record<string, number> = {};
  let aliases: Record<string, unknown> = {};
  let confirm: Record<string, unknown> = {};

  const files = fs.readdirSync(storeDir);
  for (const file of files) {
    const filePath = path.join(storeDir, file);
    if (file === '_aliases.json') {
      aliases = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;
      continue;
    }
    if (file === '_confirm.json') {
      confirm = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;
      continue;
    }
    if (file.endsWith('.json') && !file.startsWith('_')) {
      const key = file.slice(0, -'.json'.length);
      const wrapper = JSON.parse(fs.readFileSync(filePath, 'utf8')) as {
        value: unknown;
        meta?: { updated?: number; created?: number };
      };
      setNested(entries, key, wrapper.value);
      if (wrapper.meta?.updated !== undefined) {
        meta[key] = wrapper.meta.updated;
      }
    }
  }

  const result: ReconstitutedStoreState = { entries, aliases, confirm };
  if (Object.keys(meta).length > 0) result._meta = meta;
  return result;
}

function setNested(obj: Record<string, unknown>, key: string, value: unknown): void {
  const parts = key.split('.');
  let current = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    // Guard against prototype pollution via well-known dangerous property names.
    if (part === '__proto__' || part === 'constructor' || part === 'prototype') return;
    const next = current[part];
    if (next === null || next === undefined || typeof next !== 'object') {
      // Use Object.create(null) so intermediate objects have no prototype to pollute.
      const fresh = Object.create(null) as Record<string, unknown>;
      current[part] = fresh;
      current = fresh;
    } else {
      current = next as Record<string, unknown>;
    }
  }
  const lastPart = parts[parts.length - 1];
  if (lastPart !== '__proto__' && lastPart !== 'constructor' && lastPart !== 'prototype') {
    current[lastPart] = value;
  }
}

/**
 * Write a legacy UnifiedData-shaped object to a directory as the new
 * file-per-entry layout. Useful for tests that want to seed the store
 * in the new format directly instead of writing the old `data.json`
 * and relying on migration.
 */
export function writeDirectoryStore(
  storeDir: string,
  state: { entries?: Record<string, unknown>; aliases?: Record<string, unknown>; confirm?: Record<string, unknown>; _meta?: Record<string, number> }
): void {
  if (!fs.existsSync(storeDir)) {
    fs.mkdirSync(storeDir, { recursive: true });
  }

  const flat = flattenNested(state.entries ?? {});
  for (const [key, value] of Object.entries(flat)) {
    const updated = state._meta?.[key];
    const wrapper = updated !== undefined
      ? { value, meta: { created: updated, updated } }
      : { value };
    fs.writeFileSync(path.join(storeDir, `${key}.json`), JSON.stringify(wrapper, null, 2));
  }

  fs.writeFileSync(path.join(storeDir, '_aliases.json'), JSON.stringify(state.aliases ?? {}, null, 2));
  fs.writeFileSync(path.join(storeDir, '_confirm.json'), JSON.stringify(state.confirm ?? {}, null, 2));
}

function flattenNested(
  obj: Record<string, unknown>,
  prefix = ''
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      Object.assign(out, flattenNested(value as Record<string, unknown>, fullKey));
    } else {
      out[fullKey] = value;
    }
  }
  return out;
}
