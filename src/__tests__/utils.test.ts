import { flattenObject } from '../utils/objectPath';
import { debug } from '../utils/debug';
import { deepMerge } from '../utils/deepMerge';

// Mock formatting so debug() doesn't depend on config/fs
vi.mock('../formatting', () => ({
  color: {
    boldColors: { yellow: (t: string) => t },
    gray: (t: string) => t,
  },
}));

function nestedSetValue(obj: Record<string, any>, path: string, value: any): void {
  const parts = path.split('.');
  let current = obj;
  
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    current[key] = current[key] || {};
    current = current[key];
  }
  
  current[parts[parts.length - 1]] = value;
}

describe('Utils', () => {
  describe('flattenObject', () => {
    it('flattens nested objects into dot notation', () => {
      const input = {
        server: {
          production: {
            ip: '192.168.1.100',
            port: 8080
          },
          development: {
            ip: '127.0.0.1',
            port: 3000
          }
        },
        app: {
          name: 'TestApp'
        }
      };
      
      const expected = {
        'server.production.ip': '192.168.1.100',
        'server.production.port': '8080',
        'server.development.ip': '127.0.0.1',
        'server.development.port': '3000',
        'app.name': 'TestApp'
      };
      
      expect(flattenObject(input)).toEqual(expected);
    });
    
    it('handles empty objects', () => {
      expect(flattenObject({})).toEqual({});
    });
    
    it('preserves non-nested properties', () => {
      const input = { name: 'Test', value: 123 };
      expect(flattenObject(input)).toEqual({ name: 'Test', value: '123' });
    });
  });
  
  describe('nestedSetValue', () => {
    it('sets a value using dot notation path', () => {
      const obj: Record<string, any> = {};
      nestedSetValue(obj, 'server.production.ip', '192.168.1.100');
      expect(obj).toEqual({
        server: {
          production: {
            ip: '192.168.1.100'
          }
        }
      });
    });
    
    it('updates an existing value', () => {
      const obj: Record<string, any> = {
        server: {
          production: {
            ip: '192.168.1.100'
          }
        }
      };
      nestedSetValue(obj, 'server.production.ip', '192.168.1.200');
      expect(obj).toEqual({
        server: {
          production: {
            ip: '192.168.1.200'
          }
        }
      });
    });
    
    it('creates intermediate objects as needed', () => {
      const obj: Record<string, any> = {};
      nestedSetValue(obj, 'a.very.deep.nested.path', 'value');
      expect(obj.a?.very?.deep?.nested?.path).toBe('value');
    });
  });

  describe('debug', () => {
    let consoleSpy: SpyInstance;
    const originalDebug = process.env.DEBUG;

    beforeEach(() => {
      consoleSpy = vi.spyOn(console, 'log').mockImplementation();
    });

    afterEach(() => {
      consoleSpy.mockRestore();
      if (originalDebug === undefined) {
        delete process.env.DEBUG;
      } else {
        process.env.DEBUG = originalDebug;
      }
    });

    it('logs message when DEBUG is true', () => {
      process.env.DEBUG = 'true';
      debug('test message');
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('[DEBUG] test message'));
    });

    it('logs data object when data param provided', () => {
      process.env.DEBUG = 'true';
      debug('with data', { key: 'value' });
      expect(consoleSpy).toHaveBeenCalledTimes(2);
      expect(consoleSpy.mock.calls[1][0]).toContain('"key": "value"');
    });

    it('does not log data when data param omitted', () => {
      process.env.DEBUG = 'true';
      debug('no data');
      expect(consoleSpy).toHaveBeenCalledTimes(1);
    });

    it('does not log when DEBUG is not true', () => {
      delete process.env.DEBUG;
      debug('silent');
      expect(consoleSpy).not.toHaveBeenCalled();
    });
  });

  describe('deepMerge', () => {
    it('recursively merges nested objects', () => {
      const target = { a: { x: 1, y: 2 }, b: 'keep' };
      const source = { a: { y: 3, z: 4 }, c: 'new' };
      const result = deepMerge(target, source);

      expect(result).toEqual({ a: { x: 1, y: 3, z: 4 }, b: 'keep', c: 'new' });
    });

    it('overrides non-object values from source', () => {
      const target = { a: 'old' };
      const source = { a: 'new' };
      expect(deepMerge(target, source)).toEqual({ a: 'new' });
    });

    it('does not mutate the target', () => {
      const target = { a: { x: 1 } };
      const source = { a: { y: 2 } };
      deepMerge(target, source);
      expect(target).toEqual({ a: { x: 1 } });
    });
  });
});