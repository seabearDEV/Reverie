import { interpolate, interpolateObject } from '../utils/interpolate';
import { getValue } from '../storage';
import { resolveKey } from '../alias';
import { execSync } from 'child_process';

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

const mockGetValue = vi.mocked(getValue);
const mockResolveKey = vi.mocked(resolveKey);
const mockExecSync = vi.mocked(execSync);

beforeEach(() => {
  vi.clearAllMocks();
  mockResolveKey.mockImplementation((key: string) => key);
});

describe('interpolation — advanced edge cases', () => {
  // ── Unicode handling ────────────────────────────────────────────────

  describe('unicode in keys and values', () => {
    it('handles unicode values', () => {
      mockGetValue.mockReturnValueOnce('Hello World');
      expect(interpolate('${greeting}')).toBe('Hello World');
    });

    it('handles emoji in values', () => {
      mockGetValue.mockReturnValueOnce('Build: success');
      expect(interpolate('Status: ${status}')).toBe('Status: Build: success');
    });

    it('handles CJK characters in values', () => {
      mockGetValue.mockReturnValueOnce('Hello');
      expect(interpolate('${msg}')).toBe('Hello');
    });
  });

  // ── Deeply nested resolution ────────────────────────────────────────

  describe('deeply nested references', () => {
    it('resolves 5 levels of nested references', () => {
      mockGetValue.mockImplementation((key: string) => {
        const map: Record<string, string> = {
          a: '${b}',
          b: '${c}',
          c: '${d}',
          d: '${e}',
          e: 'final',
        };
        return map[key];
      });
      expect(interpolate('${a}')).toBe('final');
    });

    it('hits depth limit on very deep chains', () => {
      // Each level references a unique key to avoid circular detection
      let counter = 0;
      mockGetValue.mockImplementation(() => {
        counter++;
        return `\${level${counter}}`;
      });
      expect(() => interpolate('${level0}', 2)).toThrow(/depth limit exceeded/);
    });

    it('resolves nested default within nested default', () => {
      mockGetValue.mockImplementation((key: string) => {
        if (key === 'inner') return 'resolved-inner';
        return undefined;
      });
      // ${missing:-${also_missing:-${inner}}}
      expect(interpolate('${missing:-${also_missing:-${inner}}}')).toBe('resolved-inner');
    });
  });

  // ── Complex conditional patterns ───────────────────────────────────

  describe('complex conditionals', () => {
    it('default value with embedded text', () => {
      mockGetValue.mockImplementation(() => undefined);
      expect(interpolate('Server: ${host:-localhost}:${port:-8080}')).toBe('Server: localhost:8080');
    });

    it('multiple defaults in one string', () => {
      mockGetValue.mockImplementation(() => undefined);
      expect(interpolate('${a:-x} ${b:-y} ${c:-z}')).toBe('x y z');
    });

    it('mixed defaults and required in one string', () => {
      mockGetValue.mockImplementation((key: string) => {
        if (key === 'ok') return 'present';
        return undefined;
      });
      expect(interpolate('${ok} ${missing:-fallback}')).toBe('present fallback');
    });

    it(':? with empty message uses generic message', () => {
      mockGetValue.mockReturnValueOnce(undefined);
      expect(() => interpolate('${key:?}')).toThrow('"key" is required but not set');
    });

    it('default containing colons and special chars', () => {
      mockGetValue.mockReturnValueOnce(undefined);
      expect(interpolate('${url:-https://example.com:8080/path?q=1}')).toBe('https://example.com:8080/path?q=1');
    });
  });

  // ── Exec interpolation advanced ─────────────────────────────────────

  describe('exec interpolation advanced', () => {
    it('handles command with arguments', () => {
      mockGetValue.mockReturnValueOnce('echo "hello world"');
      mockExecSync.mockReturnValueOnce('hello world\n');
      expect(interpolate('$(cmd)')).toBe('hello world');
    });

    it('strips only trailing newline from output', () => {
      mockGetValue.mockReturnValueOnce('cat file');
      mockExecSync.mockReturnValueOnce('line1\nline2\n');
      expect(interpolate('$(cmd)')).toBe('line1\nline2');
    });

    it('handles empty command output', () => {
      mockGetValue.mockReturnValueOnce('true');
      mockExecSync.mockReturnValueOnce('\n');
      expect(interpolate('$(cmd)')).toBe('');
    });

    it('handles command output without trailing newline', () => {
      mockGetValue.mockReturnValueOnce('printf hello');
      mockExecSync.mockReturnValueOnce('hello');
      expect(interpolate('$(cmd)')).toBe('hello');
    });

    it('uses SHELL env var for execution', () => {
      mockGetValue.mockReturnValueOnce('echo test');
      mockExecSync.mockReturnValueOnce('test\n');
      interpolate('$(cmd)');
      expect(mockExecSync).toHaveBeenCalledWith('echo test', expect.objectContaining({
        encoding: 'utf-8',
        timeout: 10000,
      }));
    });

    it('10 second timeout on exec', () => {
      mockGetValue.mockReturnValueOnce('sleep 100');
      mockExecSync.mockReturnValueOnce('ok\n');
      interpolate('$(cmd)');
      expect(mockExecSync).toHaveBeenCalledWith('sleep 100', expect.objectContaining({
        timeout: 10000,
      }));
    });
  });

  // ── interpolateObject advanced ──────────────────────────────────────

  describe('interpolateObject advanced', () => {
    it('handles nested objects', () => {
      mockGetValue.mockImplementation((key: string) => {
        if (key === 'base') return '/home';
        return undefined;
      });
      const result = interpolateObject({
        path: '${base}/docs',
        nested: { deep: '${base}/nested' } as any,
      });
      // flattenObject + interpolateObject flattens first
      expect(result['path']).toBe('/home/docs');
    });

    it('handles object with no interpolation markers', () => {
      const result = interpolateObject({
        plain: 'no markers here',
        another: 'also plain',
      });
      expect(result['plain']).toBe('no markers here');
      expect(result['another']).toBe('also plain');
    });

    it('handles empty object', () => {
      const result = interpolateObject({});
      expect(result).toEqual({});
    });

    it('preserves multiple encrypted values', () => {
      const result = interpolateObject({
        key1: 'encrypted::v1:abc',
        key2: 'encrypted::v1:def',
        plain: 'normal',
      });
      expect(result['key1']).toBe('encrypted::v1:abc');
      expect(result['key2']).toBe('encrypted::v1:def');
      expect(result['plain']).toBe('normal');
    });
  });

  // ── Malformed input handling ────────────────────────────────────────

  describe('malformed input handling', () => {
    it('handles ${} in middle of text', () => {
      expect(interpolate('before ${} after')).toBe('before ${} after');
    });

    it('handles multiple unclosed braces', () => {
      expect(interpolate('${open ${another')).toBe('${open ${another');
    });

    it('handles dollar sign without brace', () => {
      expect(interpolate('cost is $100')).toBe('cost is $100');
    });

    it('handles nested braces without dollar', () => {
      expect(interpolate('json: {"key": "value"}')).toBe('json: {"key": "value"}');
    });

    it('handles just a dollar sign', () => {
      expect(interpolate('$')).toBe('$');
    });

    it('handles empty string', () => {
      expect(interpolate('')).toBe('');
    });

    it('handles whitespace-only string', () => {
      expect(interpolate('   ')).toBe('   ');
    });
  });

  // ── Alias resolution in interpolation ───────────────────────────────

  describe('alias resolution in interpolation', () => {
    it('resolves alias chain in ${ref}', () => {
      mockResolveKey.mockImplementation((key: string) => {
        if (key === 'srv') return 'server.production.ip';
        return key;
      });
      mockGetValue.mockImplementation((key: string) => {
        if (key === 'server.production.ip') return '10.0.0.1';
        return undefined;
      });
      expect(interpolate('IP: ${srv}')).toBe('IP: 10.0.0.1');
    });

    it('resolves alias in $(exec) ref', () => {
      mockResolveKey.mockImplementation((key: string) => {
        if (key === 'build') return 'commands.build';
        return key;
      });
      mockGetValue.mockImplementation((key: string) => {
        if (key === 'commands.build') return 'npm run build';
        return undefined;
      });
      mockExecSync.mockReturnValueOnce('ok\n');
      expect(interpolate('$(build)')).toBe('ok');
    });
  });

  // ── Backslash escape ────────────────────────────────────────────────
  describe('backslash escape', () => {
    it('emits literal ${key} when escaped with backslash', () => {
      expect(interpolate('\\${foo}')).toBe('${foo}');
    });

    it('emits literal $(...) when escaped with backslash', () => {
      expect(interpolate('\\$(cmd)')).toBe('$(cmd)');
    });

    it('does not call getValue for escaped value refs', () => {
      interpolate('\\${project.name}');
      expect(mockGetValue).not.toHaveBeenCalled();
    });

    it('does not call execSync for escaped exec refs', () => {
      interpolate('\\$(commands.build)');
      expect(mockExecSync).not.toHaveBeenCalled();
    });

    it('mixes escaped and live refs', () => {
      mockGetValue.mockImplementation((key: string) => {
        if (key === 'name') return 'reverie';
        return undefined;
      });
      expect(interpolate('\\${literal} and ${name}')).toBe('${literal} and reverie');
    });

    it('handles multiple escaped refs in one string', () => {
      expect(interpolate('\\${a} then \\${b}')).toBe('${a} then ${b}');
    });

    it('handles escaped ref with modifiers', () => {
      expect(interpolate('\\${key:-default}')).toBe('${key:-default}');
    });

    it('preserves backslash not followed by interpolation', () => {
      expect(interpolate('path\\to\\file')).toBe('path\\to\\file');
    });

    it('handles escaped exec ref alongside live value ref', () => {
      mockGetValue.mockImplementation((key: string) => {
        if (key === 'ver') return '1.0';
        return undefined;
      });
      expect(interpolate('${ver} \\$(cmd)')).toBe('1.0 $(cmd)');
    });
  });
});
