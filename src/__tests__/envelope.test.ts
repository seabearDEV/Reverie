import { describe, it, expect } from 'vitest';
import {
  canonicalStringify,
  computePayloadHash,
  wrapExport,
  tryUnwrapImport,
  EnvelopeMeta,
} from '../utils/envelope';

describe('canonicalStringify', () => {
  it('sorts keys recursively for stable output regardless of insertion order', () => {
    const a = { z: 1, a: 2, m: { y: 3, b: 4 } };
    const b = { a: 2, m: { b: 4, y: 3 }, z: 1 };
    expect(canonicalStringify(a)).toBe(canonicalStringify(b));
  });

  it('preserves array order', () => {
    expect(canonicalStringify([3, 1, 2])).toBe('[3,1,2]');
  });

  it('handles primitives', () => {
    expect(canonicalStringify('x')).toBe('"x"');
    expect(canonicalStringify(42)).toBe('42');
    expect(canonicalStringify(null)).toBe('null');
    expect(canonicalStringify(true)).toBe('true');
  });
});

describe('computePayloadHash', () => {
  it('produces identical hashes for the same payload', () => {
    const payload = { entries: { a: { b: 'c' } } };
    expect(computePayloadHash(payload)).toBe(computePayloadHash(payload));
  });

  it('differs when the payload differs', () => {
    expect(computePayloadHash({ entries: { a: '1' } }))
      .not.toBe(computePayloadHash({ entries: { a: '2' } }));
  });

  it('is insensitive to key insertion order', () => {
    expect(computePayloadHash({ entries: { a: '1', b: '2' } }))
      .toBe(computePayloadHash({ entries: { b: '2', a: '1' } }));
  });
});

describe('wrapExport', () => {
  it('wraps payload in $reverie envelope with computed sha256', () => {
    const wrapped = wrapExport({
      type: 'entries',
      scope: 'project',
      includesEncrypted: false,
      payload: { entries: { a: '1' } },
      version: '1.12.2',
    });
    expect(wrapped.$reverie).toMatchObject({
      type: 'entries',
      scope: 'project',
      includesEncrypted: false,
      version: '1.12.2',
    });
    const meta = wrapped.$reverie as EnvelopeMeta;
    expect(meta.sha256).toHaveLength(64);
    expect(meta.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(wrapped.entries).toEqual({ a: '1' });
  });

  it('includes all three sections for type=all', () => {
    const wrapped = wrapExport({
      type: 'all',
      scope: 'global',
      includesEncrypted: false,
      payload: { entries: {}, aliases: {}, confirm: {} },
      version: '1.12.2',
    });
    expect(wrapped.entries).toBeDefined();
    expect(wrapped.aliases).toBeDefined();
    expect(wrapped.confirm).toBeDefined();
  });
});

describe('tryUnwrapImport', () => {
  const currentVersion = '1.12.2';

  it('returns envelope=null for bare-shape files (backwards-compat)', () => {
    const bare = { some: { key: 'value' } };
    const result = tryUnwrapImport(bare, currentVersion);
    expect(result.envelope).toBeNull();
    expect(result.payload).toBe(bare);
    expect(result.warnings).toEqual([]);
  });

  it('unwraps a well-formed envelope', () => {
    const wrapped = wrapExport({
      type: 'entries',
      scope: 'project',
      includesEncrypted: false,
      payload: { entries: { a: '1' } },
      version: currentVersion,
    });
    const result = tryUnwrapImport(wrapped, currentVersion);
    expect(result.envelope).not.toBeNull();
    expect(result.envelope!.type).toBe('entries');
    expect(result.payload.entries).toEqual({ a: '1' });
    expect(result.warnings).toEqual([]);
  });

  it('rejects a modified file (sha256 mismatch)', () => {
    const wrapped = wrapExport({
      type: 'entries',
      scope: 'project',
      includesEncrypted: false,
      payload: { entries: { a: '1' } },
      version: currentVersion,
    });
    // Tamper with the payload after the hash was computed
    (wrapped.entries as Record<string, string>).a = 'tampered';
    expect(() => tryUnwrapImport(wrapped, currentVersion)).toThrow(/sha256 mismatch/);
  });

  it('warns when envelope.version is newer than the current build', () => {
    const wrapped = wrapExport({
      type: 'entries',
      scope: 'project',
      includesEncrypted: false,
      payload: { entries: {} },
      version: '1.99.0',
    });
    const result = tryUnwrapImport(wrapped, currentVersion);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('newer Reverie version');
  });

  it('does not warn for older or equal envelope versions', () => {
    const older = wrapExport({
      type: 'entries',
      scope: 'project',
      includesEncrypted: false,
      payload: { entries: {} },
      version: '1.0.0',
    });
    expect(tryUnwrapImport(older, currentVersion).warnings).toEqual([]);
  });

  it('rejects a malformed envelope (bad type field)', () => {
    const bad = { $reverie: { type: 'bogus', version: '1.0.0', scope: 'project' }, entries: {} };
    expect(() => tryUnwrapImport(bad, currentVersion)).toThrow(/type must be/);
  });

  it('rejects a malformed envelope (bad scope field)', () => {
    const bad = { $reverie: { type: 'entries', version: '1.0.0', scope: 'bogus' }, entries: {} };
    expect(() => tryUnwrapImport(bad, currentVersion)).toThrow(/scope must be/);
  });

  it('treats a non-object $reverie field as malformed', () => {
    const bad = { $reverie: 'not an object', entries: {} };
    expect(() => tryUnwrapImport(bad, currentVersion)).toThrow(/envelope/);
  });

  it('extracts all three sections for type=all', () => {
    const wrapped = wrapExport({
      type: 'all',
      scope: 'project',
      includesEncrypted: false,
      payload: { entries: { a: '1' }, aliases: { x: 'a' }, confirm: { a: true } },
      version: currentVersion,
    });
    const result = tryUnwrapImport(wrapped, currentVersion);
    expect(result.payload.entries).toEqual({ a: '1' });
    expect(result.payload.aliases).toEqual({ x: 'a' });
    expect(result.payload.confirm).toEqual({ a: true });
  });
});
