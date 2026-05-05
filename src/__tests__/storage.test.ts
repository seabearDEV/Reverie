import { handleError, loadData, saveData, getErrorMessage, getValue, setValue, removeValue, getEntriesFlat, validateImportEntries, validateImportAliases, validateImportConfirm } from '../storage';

vi.mock('../store', () => ({
  loadEntries: vi.fn(() => ({})),
  saveEntries: vi.fn(),
  loadEntriesMerged: vi.fn(() => ({})),
  clearStoreCaches: vi.fn(),
  findProjectFile: vi.fn(() => null),
  clearProjectFileCache: vi.fn(),
  getEffectiveScope: vi.fn(() => 'global'),
}));

vi.mock('../projectResolution', () => ({
  resolveScopeForWrite: vi.fn((scope) => {
    if (scope === 'project' || scope === 'global') return scope;
    // Default: simulate project resolved so auto/undefined → 'project'
    return 'project';
  }),
}));

vi.mock('../formatting', () => ({
  color: {
    red: vi.fn((text: string) => `[red]${text}[/red]`),
    gray: vi.fn((text: string) => `[gray]${text}[/gray]`)
  }
}));

import { loadEntries, saveEntries, loadEntriesMerged, clearStoreCaches, findProjectFile } from '../store';
import { resolveScopeForWrite } from '../projectResolution';

describe('Storage', () => {
  const originalConsoleError = console.error;
  const originalDebug = process.env.DEBUG;

  beforeEach(() => {
    vi.clearAllMocks();
    console.error = vi.fn();
    delete process.env.DEBUG;
  });

  afterEach(() => {
    console.error = originalConsoleError;
    if (originalDebug !== undefined) {
      process.env.DEBUG = originalDebug;
    } else {
      delete process.env.DEBUG;
    }
  });

  describe('handleError', () => {
    // Round-3 fix: handleError used to swallow the underlying error message
    // in non-DEBUG mode (only printed `message`, never the error itself).
    // CLI users hit this when invalid keys produced "Failed to set entry:"
    // with no detail. The format is now consistent: `<prefix><message>: <error>`
    // in both modes, with the stack trace gated on DEBUG. process.exitCode
    // is also set to 1 so wrappers can detect failures.
    afterEach(() => {
      // handleError now sets exitCode; reset between tests so failures
      // don't leak into the suite-level exit code.
      process.exitCode = undefined;
    });

    it('logs red-colored message + error in non-DEBUG mode', () => {
      handleError('Something failed', new Error('oops'));

      expect(console.error).toHaveBeenCalledTimes(1);
      expect(console.error).toHaveBeenCalledWith('[red]Something failed[/red]: oops');
      expect(process.exitCode).toBe(1);
    });

    it('in DEBUG mode, logs message + error + gray stack trace', () => {
      process.env.DEBUG = 'true';
      const err = new Error('oops');

      handleError('Something failed', err);

      expect(console.error).toHaveBeenCalledWith('[red]Something failed[/red]: oops');
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('[gray]')
      );
      expect(process.exitCode).toBe(1);
    });

    it('includes context prefix when provided', () => {
      handleError('Something failed', new Error('oops'), 'myContext');

      expect(console.error).toHaveBeenCalledWith(
        '[red][myContext] Something failed[/red]: oops'
      );
      expect(process.exitCode).toBe(1);
    });

    it('includes context prefix in DEBUG mode', () => {
      process.env.DEBUG = 'true';
      const err = new Error('oops');

      handleError('Something failed', err, 'ctx');

      expect(console.error).toHaveBeenCalledWith(
        '[red][ctx] Something failed[/red]: oops'
      );
      expect(process.exitCode).toBe(1);
    });

    it('stringifies non-Error values in the message line', () => {
      handleError('Something failed', 'a plain string');
      expect(console.error).toHaveBeenCalledWith(
        '[red]Something failed[/red]: a plain string'
      );
      expect(process.exitCode).toBe(1);
    });
  });



  describe('getErrorMessage', () => {
    it('extracts message from an Error instance', () => {
      expect(getErrorMessage(new Error('oops'))).toBe('oops');
    });

    it('converts a string to itself', () => {
      expect(getErrorMessage('plain string')).toBe('plain string');
    });

    it('converts a number to its string representation', () => {
      expect(getErrorMessage(42)).toBe('42');
    });
  });

  describe('loadData', () => {
    it('delegates to loadEntriesMerged for auto scope', () => {
      (loadEntriesMerged as Mock).mockReturnValue({ key: 'value' });

      const result = loadData();
      expect(result).toEqual({ key: 'value' });
      expect(loadEntriesMerged).toHaveBeenCalled();
    });

    it('delegates to loadEntries for explicit scope', () => {
      (loadEntries as Mock).mockReturnValue({ key: 'value' });

      const result = loadData('global');
      expect(result).toEqual({ key: 'value' });
      expect(loadEntries).toHaveBeenCalledWith('global');
    });
  });

  describe('saveData', () => {
    it('resolves auto scope before delegating (#99)', () => {
      // auto/undefined is passed to resolveScopeForWrite which collapses it
      // to a concrete scope; the mock returns 'project' for the auto path.
      saveData({ key: 'value' });
      expect(resolveScopeForWrite).toHaveBeenCalledWith(undefined);
      expect(saveEntries).toHaveBeenCalledWith({ key: 'value' }, 'project');
    });

    it('passes explicit scope through', () => {
      saveData({ key: 'value' }, 'global');
      expect(saveEntries).toHaveBeenCalledWith({ key: 'value' }, 'global');
    });
  });

  describe('getValue', () => {
    it('returns nested value via loadEntries', () => {
      (loadEntries as Mock).mockReturnValue({ server: { ip: '1.2.3.4' } });

      const result = getValue('server.ip', 'global');
      expect(result).toBe('1.2.3.4');
    });

    it('falls through from project to global with auto scope', () => {
      (findProjectFile as Mock).mockReturnValue('/some/.codexcli.json');
      (loadEntries as Mock)
        .mockReturnValueOnce({}) // project: no value
        .mockReturnValueOnce({ server: { ip: '1.2.3.4' } }); // global: has value

      const result = getValue('server.ip');
      expect(result).toBe('1.2.3.4');
    });
  });

  describe('setValue key validation gate (regression)', () => {
    // Pre-fix, setValue called setNestedValue with no validation, and the
    // file-system layer's isValidEntryKey only ran much later inside save().
    // That allowed several broken behaviors:
    //   1. ".dotleading" was silently normalized to "dotleading" on write,
    //      while reads of ".dotleading" returned not-found (phantom mismatch)
    //   2. "constructor.prototype.polluted", "prototype" reported success but
    //      never persisted (phantom write)
    //   3. "__proto__" crashed deeper in the pipeline with
    //      "TypeError: path.split is not a function"
    //
    // After the fix, all of these reject cleanly at the storage boundary
    // before any in-memory mutation happens.
    it.each([
      ['.dotleading'],
      ['trailing.'],
      ['__proto__'],
      ['constructor.prototype.polluted'],
      ['prototype'],
      ['flog..doubledot'],
      ['flog/with/slashes'],
      ['_aliases'],
      [''],
    ])('rejects invalid key %j with a clean error', (badKey) => {
      expect(() => setValue(badKey, 'evil')).toThrow(/Invalid store key/);
      // And critically: loadEntries should NEVER have been called, because
      // the validator runs before any I/O.
      expect(loadEntries).not.toHaveBeenCalled();
    });

    it('removeValue returns false (not throw) for invalid keys', () => {
      // Probing with user input shouldn't crash — return "nothing removed".
      expect(removeValue('__proto__')).toBe(false);
      expect(removeValue('.dotleading')).toBe(false);
      expect(removeValue('')).toBe(false);
      expect(loadEntries).not.toHaveBeenCalled();
    });
  });

  describe('import validators (round-2 regression)', () => {
    // Pre-fix, codex_import / ccli import would silently drop entries with
    // prototype-pollution names, leading dots, or empty segments via
    // expandFlatKeys → isSafeKey, then report "merged successfully" with
    // nothing actually persisted. These validators run before the save
    // and reject the whole import with a descriptive error listing every
    // bad key.

    // The real attack vector is JSON.parse — JS object literals can't create
    // an own __proto__ property (the literal triggers the prototype setter,
    // not property assignment), but JSON.parse('{"__proto__":"evil"}') DOES
    // create an own __proto__ key. These tests use JSON.parse to mirror what
    // actually arrives from codex_import / ccli import.

    describe('validateImportEntries', () => {
      it('passes for an all-safe entries object', () => {
        expect(() => validateImportEntries({
          arch: { storage: 'note' },
          'flag.foo': 'bar',
        })).not.toThrow();
      });

      it('rejects nested __proto__ from JSON', () => {
        const obj = JSON.parse('{"a":{"__proto__":"evil"}}') as Record<string, unknown>;
        expect(() => validateImportEntries(obj))
          .toThrow(/invalid entry keys.*__proto__/);
      });

      it('rejects top-level prototype-chain names from JSON', () => {
        expect(() => validateImportEntries(JSON.parse('{"__proto__":"evil"}') as Record<string, unknown>))
          .toThrow(/invalid entry keys/);
        expect(() => validateImportEntries(JSON.parse('{"constructor":"evil"}') as Record<string, unknown>))
          .toThrow(/invalid entry keys/);
        expect(() => validateImportEntries(JSON.parse('{"prototype":"evil"}') as Record<string, unknown>))
          .toThrow(/invalid entry keys/);
      });

      it('rejects sidecar collisions', () => {
        expect(() => validateImportEntries({ _aliases: 'x' }))
          .toThrow(/invalid entry keys.*_aliases/);
      });

      it('rejects path-traversal characters', () => {
        expect(() => validateImportEntries({ 'a/b': 'x' }))
          .toThrow(/invalid entry keys/);
      });

      it('rejects leading-dot keys (the .dotleading regression)', () => {
        // This used to slip through: expandFlatKeys would silently normalize
        // ".dotleading" → "dotleading" because isSafeKey rejects the empty
        // first segment, the parent walk breaks out, and the leaf gets set
        // on the result root. The fix is to validate the RAW input before
        // expandFlatKeys runs, and isValidEntryKey explicitly rejects
        // leading and trailing dots.
        expect(() => validateImportEntries({ '.dotleading': 'evil' }))
          .toThrow(/invalid entry keys.*\.dotleading/);
        expect(() => validateImportEntries({ 'trailing.': 'evil' }))
          .toThrow(/invalid entry keys.*trailing\./);
      });

      it('reports multiple bad keys at once', () => {
        const obj = JSON.parse('{"good":"ok","__proto__":"bad1","_aliases":"bad2"}') as Record<string, unknown>;
        expect(() => validateImportEntries(obj))
          .toThrow(/(__proto__.*_aliases|_aliases.*__proto__)/);
      });

      // #79 — CodexValue leaves are strings only. Non-string leaves used
      // to pass structural validation and get written through, then
      // surface as confusing errors in downstream read paths.
      it('rejects number leaf values', () => {
        expect(() => validateImportEntries({ count: 42 as unknown as string }))
          .toThrow(/non-string leaf values.*count/);
      });

      it('rejects boolean leaf values', () => {
        expect(() => validateImportEntries({ flag: true as unknown as string }))
          .toThrow(/non-string leaf values.*flag/);
      });

      it('rejects array leaf values', () => {
        expect(() => validateImportEntries({ items: ['a', 'b'] as unknown as string }))
          .toThrow(/non-string leaf values.*items/);
      });

      it('rejects null leaf values', () => {
        expect(() => validateImportEntries({ empty: null as unknown as string }))
          .toThrow(/non-string leaf values.*empty/);
      });

      it('reports every non-string leaf in a mixed import', () => {
        const bad = {
          a: 'ok',
          num: 1 as unknown as string,
          bool: false as unknown as string,
          arr: [] as unknown as string,
          nested: { n: null as unknown as string },
        };
        expect(() => validateImportEntries(bad))
          .toThrow(/non-string leaf values.*(num.*bool.*arr.*nested\.n|nested\.n.*num)/);
      });
    });

    describe('validateImportAliases', () => {
      it('passes for safe alias name and target', () => {
        expect(() => validateImportAliases({ chk: 'commands.check' }))
          .not.toThrow();
      });

      it('rejects invalid alias name from JSON', () => {
        const obj = JSON.parse('{"__proto__":"safe.target"}') as Record<string, unknown>;
        expect(() => validateImportAliases(obj))
          .toThrow(/invalid alias names.*__proto__/);
      });

      it('rejects invalid alias target', () => {
        // Target "__proto__" is just a string value, no JSON quirk needed.
        expect(() => validateImportAliases({ safe_name: '__proto__' }))
          .toThrow(/invalid alias targets.*__proto__/);
      });

      it('rejects empty-string alias name', () => {
        expect(() => validateImportAliases({ '': 'safe.target' }))
          .toThrow(/invalid alias names/);
      });

      it('reports both invalid name and invalid target in one error', () => {
        const obj = JSON.parse('{"__proto__":"/etc/passwd"}') as Record<string, unknown>;
        expect(() => validateImportAliases(obj))
          .toThrow(/invalid alias names.*invalid alias targets/);
      });
    });

    describe('validateImportConfirm', () => {
      it('passes for safe keys', () => {
        expect(() => validateImportConfirm({ 'commands.release': true }))
          .not.toThrow();
      });

      it('rejects __proto__ as a confirm key from JSON', () => {
        const obj = JSON.parse('{"__proto__":true}') as Record<string, unknown>;
        expect(() => validateImportConfirm(obj))
          .toThrow(/invalid confirm keys.*__proto__/);
      });
    });
  });

});
