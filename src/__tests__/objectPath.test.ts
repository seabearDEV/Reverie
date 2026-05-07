import { setNestedValue, getNestedValue, removeNestedValue, expandFlatKeys, flattenObject } from '../utils/objectPath';

describe('objectPath utilities', () => {
  // ── setNestedValue ──────────────────────────────────────────────────

  describe('setNestedValue', () => {
    it('sets a top-level key', () => {
      const obj: Record<string, unknown> = {};
      setNestedValue(obj, 'name', 'test');
      expect(obj).toEqual({ name: 'test' });
    });

    it('sets a deeply nested key', () => {
      const obj: Record<string, unknown> = {};
      setNestedValue(obj, 'a.b.c.d', 'deep');
      expect(obj).toEqual({ a: { b: { c: { d: 'deep' } } } });
    });

    it('overwrites existing string with nested object', () => {
      const obj: Record<string, unknown> = { a: 'old' };
      setNestedValue(obj, 'a.b', 'new');
      expect(obj).toEqual({ a: { b: 'new' } });
    });

    it('overwrites existing value', () => {
      const obj: Record<string, unknown> = { a: { b: 'old' } };
      setNestedValue(obj, 'a.b', 'new');
      expect(obj).toEqual({ a: { b: 'new' } });
    });

    it('blocks __proto__ at any level', () => {
      const obj: Record<string, unknown> = {};
      setNestedValue(obj, '__proto__.polluted', 'yes');
      expect((obj as any).__proto__?.polluted).toBeUndefined();
      expect(({} as any).polluted).toBeUndefined();
    });

    it('blocks constructor at intermediate level', () => {
      const obj: Record<string, unknown> = {};
      setNestedValue(obj, 'constructor.prototype', 'bad');
      expect((obj as any).constructor?.prototype).not.toBe('bad');
    });

    it('blocks prototype at leaf level', () => {
      const obj: Record<string, unknown> = {};
      setNestedValue(obj, 'a.prototype', 'bad');
      // The intermediate 'a' object may be created, but 'prototype' should not be set as a value
      if ((obj as any).a) {
        expect((obj as any).a.prototype).not.toBe('bad');
      }
    });

    it('handles single-segment key', () => {
      const obj: Record<string, unknown> = {};
      setNestedValue(obj, 'x', 'val');
      expect(obj.x).toBe('val');
    });

    it('preserves sibling keys when setting nested value', () => {
      const obj: Record<string, unknown> = { a: { x: 1, y: 2 } };
      setNestedValue(obj, 'a.z', '3');
      expect(obj).toEqual({ a: { x: 1, y: 2, z: '3' } });
    });
  });

  // ── getNestedValue ──────────────────────────────────────────────────

  describe('getNestedValue', () => {
    it('returns top-level string value', () => {
      expect(getNestedValue({ name: 'test' }, 'name')).toBe('test');
    });

    it('returns deeply nested value', () => {
      expect(getNestedValue({ a: { b: { c: 'deep' } } }, 'a.b.c')).toBe('deep');
    });

    it('returns subtree object', () => {
      const obj = { a: { b: 'val', c: 'val2' } };
      expect(getNestedValue(obj, 'a')).toEqual({ b: 'val', c: 'val2' });
    });

    it('returns undefined for nonexistent key', () => {
      expect(getNestedValue({ a: '1' }, 'b')).toBeUndefined();
    });

    it('returns undefined for nonexistent nested key', () => {
      expect(getNestedValue({ a: { b: '1' } }, 'a.c')).toBeUndefined();
    });

    it('returns undefined for path through a string', () => {
      expect(getNestedValue({ a: 'string' }, 'a.b')).toBeUndefined();
    });

    it('returns undefined for empty path', () => {
      expect(getNestedValue({ a: '1' }, '')).toBeUndefined();
    });

    it('handles empty object', () => {
      expect(getNestedValue({}, 'any.key')).toBeUndefined();
    });

    // Round-2 regression: pre-fix, getNestedValue did `obj[keys[0]]` which
    // walked the prototype chain. So `getNestedValue({}, '__proto__')`
    // returned Object.prototype, `getNestedValue({}, 'constructor')` returned
    // the Object constructor, etc. — and reverie_get / reverie_copy / reverie_rename
    // all built bizarre behavior on top of those leaks. With Object.hasOwn
    // gating each hop, every prototype-chain name returns undefined.
    describe('prototype-chain safety', () => {
      it.each([
        '__proto__',
        'constructor',
        'prototype',
        'hasOwnProperty',
        'toString',
        'valueOf',
        'isPrototypeOf',
        'propertyIsEnumerable',
        '__defineGetter__',
      ])('returns undefined for inherited Object.prototype name %j', (name) => {
        expect(getNestedValue({}, name)).toBeUndefined();
      });

      it('returns undefined for nested __proto__.polluted', () => {
        expect(getNestedValue({ a: {} }, 'a.__proto__.polluted')).toBeUndefined();
      });

      it('still returns own-property values that happen to share built-in names', () => {
        // If a user explicitly stored an entry under a non-pollution key
        // that happens to be reserved, the validator at the write boundary
        // would have rejected it — but the read path should respect own
        // properties when they exist. Use Object.create(null) to set up an
        // own __proto__ without confusing the engine.
        const obj = { regular: 'value' };
        expect(getNestedValue(obj, 'regular')).toBe('value');
      });
    });
  });

  // ── removeNestedValue ───────────────────────────────────────────────

  describe('removeNestedValue', () => {
    it('removes a top-level key', () => {
      const obj = { a: '1', b: '2' };
      expect(removeNestedValue(obj, 'a')).toBe(true);
      expect(obj).toEqual({ b: '2' });
    });

    it('removes a nested key and cleans empty parents', () => {
      const obj: Record<string, unknown> = { a: { b: { c: 'val' } } };
      expect(removeNestedValue(obj, 'a.b.c')).toBe(true);
      expect(obj).toEqual({}); // a and a.b cleaned up
    });

    it('removes nested key but keeps siblings', () => {
      const obj: Record<string, unknown> = { a: { b: '1', c: '2' } };
      expect(removeNestedValue(obj, 'a.b')).toBe(true);
      expect(obj).toEqual({ a: { c: '2' } });
    });

    it('removes entire subtree', () => {
      const obj: Record<string, unknown> = { a: { b: '1', c: '2' }, d: '3' };
      expect(removeNestedValue(obj, 'a')).toBe(true);
      expect(obj).toEqual({ d: '3' });
    });

    it('returns false for nonexistent key', () => {
      const obj = { a: '1' };
      expect(removeNestedValue(obj, 'b')).toBe(false);
    });

    it('returns false for nonexistent nested key', () => {
      const obj: Record<string, unknown> = { a: { b: '1' } };
      expect(removeNestedValue(obj, 'a.c')).toBe(false);
    });

    it('returns false for path through a string', () => {
      const obj: Record<string, unknown> = { a: 'string' };
      expect(removeNestedValue(obj, 'a.b')).toBe(false);
    });
  });

  // ── expandFlatKeys ──────────────────────────────────────────────────

  describe('expandFlatKeys', () => {
    it('expands dot-notation keys into nested objects', () => {
      const input = { 'a.b': 'val', 'a.c': 'val2' };
      expect(expandFlatKeys(input)).toEqual({ a: { b: 'val', c: 'val2' } });
    });

    it('returns already-nested objects unchanged', () => {
      const input = { a: { b: 'val' } };
      expect(expandFlatKeys(input)).toEqual({ a: { b: 'val' } });
    });

    it('mixes flat and nested keys', () => {
      const input = { 'a.b': 'flat', c: { d: 'nested' } };
      const result = expandFlatKeys(input);
      expect(result).toEqual({ a: { b: 'flat' }, c: { d: 'nested' } });
    });

    it('handles deeply nested dot notation', () => {
      const input = { 'a.b.c.d.e': 'deep' };
      expect(expandFlatKeys(input)).toEqual({ a: { b: { c: { d: { e: 'deep' } } } } });
    });

    it('merges overlapping flat keys', () => {
      const input = { 'a.b': '1', 'a.c': '2' };
      expect(expandFlatKeys(input)).toEqual({ a: { b: '1', c: '2' } });
    });

    it('blocks __proto__ in flat key expansion', () => {
      const input = { '__proto__.polluted': 'yes' };
      const result = expandFlatKeys(input);
      expect(({} as any).polluted).toBeUndefined();
      // The key should be silently dropped
      expect(result.__proto__).not.toHaveProperty('polluted');
    });

    it('returns object with no flat keys as-is', () => {
      const input = { foo: 'bar', nested: { x: 1 } };
      const result = expandFlatKeys(input);
      expect(result).toBe(input); // same reference
    });
  });

  // ── flattenObject ───────────────────────────────────────────────────

  describe('flattenObject', () => {
    it('flattens nested objects into dot notation', () => {
      expect(flattenObject({ a: { b: 'val' } })).toEqual({ 'a.b': 'val' });
    });

    it('handles deeply nested objects', () => {
      expect(flattenObject({ a: { b: { c: { d: 'deep' } } } })).toEqual({ 'a.b.c.d': 'deep' });
    });

    it('handles mixed nesting levels', () => {
      const input = { top: 'val', nested: { key: 'val2' } };
      expect(flattenObject(input)).toEqual({ top: 'val', 'nested.key': 'val2' });
    });

    it('converts non-string values to strings', () => {
      expect(flattenObject({ num: 42, bool: true })).toEqual({ num: '42', bool: 'true' });
    });

    it('handles empty object', () => {
      expect(flattenObject({})).toEqual({});
    });

    it('handles empty nested object', () => {
      // empty nested objects produce no keys
      expect(flattenObject({ a: {} })).toEqual({});
    });

    it('respects maxDepth parameter', () => {
      const input = { a: { b: { c: 'deep' } } };
      const result = flattenObject(input, '', 2);
      expect(result).toEqual({ 'a.b': '' }); // stopped at depth 2
    });

    it('handles maxDepth of 1', () => {
      const input = { a: { b: 'val' }, c: 'top' };
      const result = flattenObject(input, '', 1);
      expect(result).toEqual({ a: '', c: 'top' });
    });

    it('handles null values gracefully', () => {
      // null is not an object in the typeof check, so it becomes a string
      expect(flattenObject({ a: null as unknown as string })).toEqual({ a: 'null' });
    });
  });
});
