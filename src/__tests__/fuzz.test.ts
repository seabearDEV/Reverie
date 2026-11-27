/**
 * Property-based / fuzz tests.
 *
 * Verifies invariants hold across randomized inputs:
 * - set → get → remove round-trip
 * - flattenObject ↔ expandFlatKeys invertibility
 * - nested path operations preserve siblings
 * - JSON round-trip through the store
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { setNestedValue, getNestedValue, removeNestedValue, flattenObject, expandFlatKeys } from '../utils/objectPath';
import { encryptValue, decryptValue, isEncrypted } from '../utils/crypto';

// ── Helpers ──────────────────────────────────────────────────────────

function randomString(len: number): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < len; i++) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }
  return result;
}

function randomKey(depth: number = Math.ceil(Math.random() * 4)): string {
  const segments: string[] = [];
  for (let i = 0; i < depth; i++) {
    segments.push(randomString(Math.ceil(Math.random() * 8)));
  }
  return segments.join('.');
}

/**
 * Generate a set of random dotted keys in which no key is a prefix of
 * another. This is the invariant `expandFlatKeys` + `flattenObject`
 * round-trip requires — if both `a.b` and `a.b.c` appear in the same
 * flat map, one of them has to lose when expanded (you can't have `a.b`
 * be both a string and an object), so the round-trip is undefined.
 *
 * Candidates are generated one at a time and accepted only if they
 * neither extend nor are extended by an already-accepted key. Bounded
 * retries keep the loop from spinning on a pathological RNG streak;
 * `requested` is a target, not a hard guarantee, and the returned array
 * is always non-empty.
 */
function randomPrefixFreeKeys(requested: number): string[] {
  const accepted: string[] = [];
  const maxAttempts = requested * 20;
  for (let attempt = 0; attempt < maxAttempts && accepted.length < requested; attempt++) {
    const candidate = randomKey();
    if (!candidate) continue;
    let collides = false;
    for (const existing of accepted) {
      if (candidate === existing ||
          candidate.startsWith(existing + '.') ||
          existing.startsWith(candidate + '.')) {
        collides = true;
        break;
      }
    }
    if (!collides) accepted.push(candidate);
  }
  // Guarantee at least one key so the enclosing test loop always has work.
  if (accepted.length === 0) accepted.push('fallback');
  return accepted;
}

function randomValue(): string {
  const types = ['short', 'long', 'unicode', 'special', 'empty'];
  const type = types[Math.floor(Math.random() * types.length)];
  switch (type) {
    case 'short': return randomString(5);
    case 'long': return randomString(500);
    case 'unicode': return 'Hello World ' + randomString(3);
    case 'special': return `value with "quotes" and 'apostrophes' & <brackets>`;
    case 'empty': return '';
    default: return randomString(10);
  }
}

// ── Tests ────────────────────────────────────────────────────────────

describe('fuzz: objectPath set→get→remove invariant', () => {
  it('set then get returns the same value (100 random keys)', () => {
    for (let trial = 0; trial < 100; trial++) {
      const obj: Record<string, unknown> = {};
      const key = randomKey();
      const value = randomValue();

      setNestedValue(obj, key, value);
      const retrieved = getNestedValue(obj, key);
      expect(retrieved).toBe(value);
    }
  });

  it('remove returns true and clears the value (100 random keys)', () => {
    for (let trial = 0; trial < 100; trial++) {
      const obj: Record<string, unknown> = {};
      const key = randomKey();
      setNestedValue(obj, key, randomValue());

      const removed = removeNestedValue(obj, key);
      expect(removed).toBe(true);

      const after = getNestedValue(obj, key);
      expect(after).toBeUndefined();
    }
  });

  it('set preserves sibling keys (50 trials)', () => {
    for (let trial = 0; trial < 50; trial++) {
      const obj: Record<string, unknown> = {};
      // Create a few siblings. Distinct first characters: two fully random
      // 3-character names collide once in 36^3 draws, and a collision makes
      // the second set overwrite the first — the test then fails on its own
      // input (about one full-suite run in a thousand).
      const parent = randomString(4);
      const sibling1 = `${parent}.a${randomString(2)}`;
      const sibling2 = `${parent}.b${randomString(2)}`;
      const val1 = randomValue();
      const val2 = randomValue();

      setNestedValue(obj, sibling1, val1);
      setNestedValue(obj, sibling2, val2);

      expect(getNestedValue(obj, sibling1)).toBe(val1);
      expect(getNestedValue(obj, sibling2)).toBe(val2);
    }
  });

  it('remove one sibling does not affect the other (50 trials)', () => {
    for (let trial = 0; trial < 50; trial++) {
      const obj: Record<string, unknown> = {};
      const parent = randomString(4);
      const key1 = `${parent}.a${randomString(2)}`;
      const key2 = `${parent}.b${randomString(2)}`;
      const val1 = randomValue();
      const val2 = randomValue();

      setNestedValue(obj, key1, val1);
      setNestedValue(obj, key2, val2);

      removeNestedValue(obj, key1);

      expect(getNestedValue(obj, key1)).toBeUndefined();
      expect(getNestedValue(obj, key2)).toBe(val2);
    }
  });
});

describe('fuzz: flattenObject ↔ expandFlatKeys round-trip', () => {
  it('flatten then expand preserves structure (50 trials)', () => {
    for (let trial = 0; trial < 50; trial++) {
      // Build a random nested object
      const obj: Record<string, unknown> = {};
      const numKeys = 3 + Math.floor(Math.random() * 10);
      for (let i = 0; i < numKeys; i++) {
        setNestedValue(obj, randomKey(), randomValue());
      }

      const flat = flattenObject(obj);
      const expanded = expandFlatKeys(flat);
      const reFlatted = flattenObject(expanded);

      // The flat representations should be identical
      expect(reFlatted).toEqual(flat);
    }
  });

  it('expand then flatten returns same flat map (50 trials)', () => {
    // Input must be prefix-free: the `expand → flatten` round-trip is only
    // defined when no key in the flat map is a prefix of another. If both
    // `a.b` and `a.b.c` appear, `expandFlatKeys` has to pick one to win
    // (the other's value is lost), so the round-trip is undefined. Using
    // raw `randomKey()` here produced ~40% flakes whenever the RNG
    // happened to generate colliding keys; see `randomPrefixFreeKeys`.
    for (let trial = 0; trial < 50; trial++) {
      const flat: Record<string, string> = {};
      const numKeys = 3 + Math.floor(Math.random() * 8);
      for (const key of randomPrefixFreeKeys(numKeys)) {
        flat[key] = randomValue();
      }

      const expanded = expandFlatKeys(flat);
      const reFlatted = flattenObject(expanded);

      // Should get back the same keys (values become strings via flattenObject)
      for (const [k, v] of Object.entries(flat)) {
        expect(reFlatted[k]).toBe(v);
      }
    }
  });
});

describe('fuzz: encrypt/decrypt round-trip', () => {
  // 100 PBKDF2 derivations at 600,000 iterations each: about 3.5 s alone,
  // and CPU-bound, so under `bun test --parallel` on a loaded machine every
  // worker competes for it (about 20 s seen). The timeout leaves room for that.
  it('random values survive encrypt→decrypt (50 trials)', { timeout: 60_000 }, () => {
    const password = 'fuzz-test-password-' + randomString(8);
    for (let trial = 0; trial < 50; trial++) {
      const plaintext = randomValue();
      const encrypted = encryptValue(plaintext, password);

      expect(isEncrypted(encrypted)).toBe(true);
      if (plaintext.length > 0) {
        expect(encrypted).not.toContain(plaintext);
      }

      const decrypted = decryptValue(encrypted, password);
      expect(decrypted).toBe(plaintext);
    }
  });

  it('different passwords produce different ciphertexts', () => {
    const plaintext = 'same-input';
    const enc1 = encryptValue(plaintext, 'password1');
    const enc2 = encryptValue(plaintext, 'password2');
    expect(enc1).not.toBe(enc2);
    // But both still start with the encrypted prefix
    expect(isEncrypted(enc1)).toBe(true);
    expect(isEncrypted(enc2)).toBe(true);
  });
});

describe('fuzz: JSON round-trip through store format', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-fuzz-store-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('random entries survive write→read cycle (30 trials)', () => {
    for (let trial = 0; trial < 30; trial++) {
      const entries: Record<string, unknown> = {};
      const numKeys = 5 + Math.floor(Math.random() * 15);

      for (let i = 0; i < numKeys; i++) {
        setNestedValue(entries, randomKey(), randomValue());
      }

      const data = {
        entries,
        aliases: {} as Record<string, string>,
        confirm: {} as Record<string, true>,
      };

      const filePath = path.join(tmpDir, `trial-${trial}.json`);
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2));

      const raw = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw);

      // Verify the flat representations match
      const originalFlat = flattenObject(entries);
      const parsedFlat = flattenObject(parsed.entries);
      expect(parsedFlat).toEqual(originalFlat);
    }
  });
});

describe('fuzz: prototype pollution resistance', () => {
  it('__proto__ paths never pollute Object.prototype (100 trials)', () => {
    for (let trial = 0; trial < 100; trial++) {
      const obj: Record<string, unknown> = {};
      const poisonKey = `__proto__.fuzz${trial}`;

      setNestedValue(obj, poisonKey, 'polluted');

      // Object.prototype must never be affected
      expect(({} as any)[`fuzz${trial}`]).toBeUndefined();
    }
  });

  it('constructor paths never pollute (50 trials)', () => {
    for (let trial = 0; trial < 50; trial++) {
      const obj: Record<string, unknown> = {};
      const poisonKey = `constructor.prototype.fuzz${trial}`;

      setNestedValue(obj, poisonKey, 'polluted');

      expect(({} as any)[`fuzz${trial}`]).toBeUndefined();
    }
  });

  it('expandFlatKeys blocks __proto__ in flat keys (50 trials)', () => {
    for (let trial = 0; trial < 50; trial++) {
      const flat: Record<string, string> = {
        [`__proto__.fuzz${trial}`]: 'polluted',
      };

      expandFlatKeys(flat);

      expect(({} as any)[`fuzz${trial}`]).toBeUndefined();
    }
  });
});

describe('fuzz: large data sets', () => {
  it('handles 1000 entries without error', () => {
    const obj: Record<string, unknown> = {};
    const keys: string[] = [];

    for (let i = 0; i < 1000; i++) {
      const key = `ns${i % 10}.key${i}`;
      keys.push(key);
      setNestedValue(obj, key, `value${i}`);
    }

    // All values retrievable
    for (let i = 0; i < 1000; i++) {
      expect(getNestedValue(obj, keys[i])).toBe(`value${i}`);
    }

    // Flatten works
    const flat = flattenObject(obj);
    expect(Object.keys(flat).length).toBe(1000);
  });

  it('flattenObject handles 10 levels of nesting', () => {
    const obj: Record<string, unknown> = {};
    setNestedValue(obj, 'a.b.c.d.e.f.g.h.i.j', 'deep');

    const flat = flattenObject(obj);
    expect(flat['a.b.c.d.e.f.g.h.i.j']).toBe('deep');
    expect(Object.keys(flat).length).toBe(1);
  });
});
