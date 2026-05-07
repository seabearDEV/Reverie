import crypto from 'crypto';

export type EnvelopeType = 'entries' | 'aliases' | 'confirm' | 'all';

export interface EnvelopeMeta {
  version: string;
  type: EnvelopeType;
  scope: 'project' | 'global';
  exportedAt: string;
  includesEncrypted: boolean;
  sha256: string;
}

const ENVELOPE_KEY = '$codexcli';

const SECTIONS_FOR_TYPE: Record<EnvelopeType, readonly string[]> = {
  entries: ['entries'],
  aliases: ['aliases'],
  confirm: ['confirm'],
  all: ['entries', 'aliases', 'confirm'],
};

/**
 * Canonical JSON stringification for hashing. Keys sorted recursively so
 * the hash is stable across pretty-print settings and insertion-order
 * variations. Matches the hash at export and import regardless of how the
 * file was formatted on disk.
 */
export function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map(k => JSON.stringify(k) + ':' + canonicalStringify(obj[k])).join(',')}}`;
}

export function computePayloadHash(payload: Record<string, unknown>): string {
  return crypto.createHash('sha256').update(canonicalStringify(payload)).digest('hex');
}

interface WrapParams {
  type: EnvelopeType;
  scope: 'project' | 'global';
  includesEncrypted: boolean;
  payload: Record<string, unknown>;
  version: string;
}

/**
 * Wrap a payload (one or more section objects) with the integrity envelope.
 * Returns an object suitable for JSON.stringify — writers control the indent.
 */
export function wrapExport(params: WrapParams): Record<string, unknown> {
  const meta: EnvelopeMeta = {
    version: params.version,
    type: params.type,
    scope: params.scope,
    exportedAt: new Date().toISOString(),
    includesEncrypted: params.includesEncrypted,
    sha256: computePayloadHash(params.payload),
  };
  return { [ENVELOPE_KEY]: meta, ...params.payload };
}

export interface UnwrapResult {
  envelope: EnvelopeMeta | null;
  payload: Record<string, unknown>;
  warnings: string[];
}

/**
 * Detect envelope vs. bare shape, verify integrity, extract payload.
 *
 * - If `$codexcli` is present, validate the envelope, verify sha256, build
 *   the payload from the sections named by `envelope.type`, and collect any
 *   warnings (e.g. future version).
 * - If `$codexcli` is absent, treat the whole object as the bare payload —
 *   the caller's existing section-detection logic takes over.
 *
 * Throws on shape errors or sha256 mismatch. The caller surfaces warnings.
 */
export function tryUnwrapImport(obj: Record<string, unknown>, currentVersion: string): UnwrapResult {
  const raw = obj[ENVELOPE_KEY];
  if (raw === undefined) {
    return { envelope: null, payload: obj, warnings: [] };
  }

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`Malformed ${ENVELOPE_KEY} envelope: expected object.`);
  }
  const env = raw as Record<string, unknown>;

  const type = env.type;
  if (type !== 'entries' && type !== 'aliases' && type !== 'confirm' && type !== 'all') {
    throw new Error(`Malformed ${ENVELOPE_KEY} envelope: type must be entries/aliases/confirm/all (got ${JSON.stringify(type)}).`);
  }
  const version = env.version;
  if (typeof version !== 'string') {
    throw new Error(`Malformed ${ENVELOPE_KEY} envelope: version must be a string.`);
  }
  const scope = env.scope;
  if (scope !== 'project' && scope !== 'global') {
    throw new Error(`Malformed ${ENVELOPE_KEY} envelope: scope must be project or global (got ${JSON.stringify(scope)}).`);
  }
  const exportedAt = typeof env.exportedAt === 'string' ? env.exportedAt : '';
  const includesEncrypted = env.includesEncrypted === true;
  const sha256 = typeof env.sha256 === 'string' ? env.sha256 : '';

  const payload: Record<string, unknown> = {};
  const sectionKeys = SECTIONS_FOR_TYPE[type];
  for (const key of sectionKeys) {
    const section = obj[key];
    if (section === undefined) continue;
    if (section === null || typeof section !== 'object' || Array.isArray(section)) {
      throw new Error(`Malformed envelope payload: '${key}' must be an object.`);
    }
    payload[key] = section;
  }

  if (sha256) {
    const actual = computePayloadHash(payload);
    if (actual !== sha256) {
      throw new Error(
        `Envelope sha256 mismatch — the file has been modified since export. ` +
        `Expected ${sha256}, got ${actual}.`
      );
    }
  }

  const warnings: string[] = [];
  if (compareVersions(version, currentVersion) > 0) {
    warnings.push(
      `Import was produced by a newer Reverie version (${version}, this build is ${currentVersion}). Proceeding, but some fields may not be recognized.`
    );
  }

  const envelope: EnvelopeMeta = { version, type, scope, exportedAt, includesEncrypted, sha256 };
  return { envelope, payload, warnings };
}

/**
 * Compare semver-ish x.y.z strings. Returns 1 if a > b, -1 if a < b, 0 if
 * equal. Tolerates prerelease suffixes by treating them as lower than a
 * release of the same x.y.z (`1.12.2-beta.0` < `1.12.2`). Non-numeric
 * segments fall back to string compare. Good enough for the future-version
 * warning — we don't need strict semver semantics here.
 */
function compareVersions(a: string, b: string): number {
  const [aRelease, aPre] = a.split('-', 2);
  const [bRelease, bPre] = b.split('-', 2);
  const ap = aRelease.split('.');
  const bp = bRelease.split('.');
  const len = Math.max(ap.length, bp.length);
  for (let i = 0; i < len; i++) {
    const an = Number(ap[i] ?? '0');
    const bn = Number(bp[i] ?? '0');
    if (!Number.isNaN(an) && !Number.isNaN(bn)) {
      if (an !== bn) return an > bn ? 1 : -1;
    } else {
      const as = ap[i] ?? '';
      const bs = bp[i] ?? '';
      if (as !== bs) return as > bs ? 1 : -1;
    }
  }
  if (aPre === bPre) return 0;
  if (aPre === undefined) return 1;
  if (bPre === undefined) return -1;
  return aPre > bPre ? 1 : -1;
}
