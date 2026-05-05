import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('CLI Integration Tests', () => {
  // Create a temporary directory for test data
  const testDir = path.join(os.tmpdir(), 'codexcli-test-' + Math.random().toString(36).substring(2));
  const execOpts = { env: { ...process.env, CODEX_DATA_DIR: testDir, CODEX_NO_PROJECT: '1' }, stdio: ['pipe', 'pipe', 'pipe'] as const };

  const run = (args: string) => {
    // After #99, auto-mode writes refuse without project resolution. Inject
    // --global for write verbs so the global-store path remains exercised.
    if (/^(set|rm|remove|copy|cp|rename|mv|alias|confirm|edit)\b/.test(args)) {
      args = args.replace(/^(\S+)/, '$1 --global');
    } else if (/^data (reset|import)\b/.test(args)) {
      args = args.replace(/^(data \S+)/, '$1 --global');
    }
    return execSync(`node dist/index.js ${args}`, execOpts).toString();
  };

  beforeAll(() => {
    fs.mkdirSync(testDir, { recursive: true });
  });

  afterAll(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('shows help when run without arguments', () => {
    const result = run('');
    expect(result).toContain('USAGE:');
    expect(result).toContain('COMMANDS');
  });

  it('adds and retrieves an entry', () => {
    run('set --force test.key "test value"');
    const result = run('get test.key');
    expect(result).toContain('test value');
  });

  it('handles search functionality', () => {
    run('set --force search.test.1 "searchable value one"');
    run('set --force search.test.2 "searchable value two"');

    const keyResult = run('find search.test --entries');
    expect(keyResult).toContain('Found 2 matches');
    expect(keyResult).toContain('searchable value one');
    expect(keyResult).toContain('searchable value two');

    const valueResult = run('find "value two" --entries');
    expect(valueResult).not.toContain('search.test.1');
  });

  it('removes entries properly', () => {
    run('set --force remove.test "value to remove"');

    let result = run('get remove.test');
    expect(result).toContain('value to remove');

    run('remove remove.test');

    // get on a removed key exits non-zero, so execSync throws
    try {
      result = run('get remove.test');
    } catch (err: unknown) {
      const stderr = (err as { stderr?: Buffer }).stderr?.toString() ?? '';
      expect(stderr).toContain('not found');
      return;
    }
    // If it didn't throw, the entry shouldn't contain the old value
    expect(result).not.toContain('value to remove');
  });

  // #99: an auto-mode write with no resolvable project is refused with
  // exit code 1 and the multiline guidance message on stderr. Bypass the
  // run helper so --global is NOT auto-injected — that's the whole point.
  it('refuses auto-mode writes when project resolution fails (#99)', () => {
    let stderr = '';
    let status: number | null = null;
    try {
      execSync(`node dist/index.js set --force project.refused "v"`, execOpts);
    } catch (err: unknown) {
      const e = err as { stderr?: Buffer; status?: number };
      stderr = e.stderr?.toString() ?? '';
      status = e.status ?? null;
    }
    expect(status).toBe(1);
    expect(stderr).toContain('Project resolution failed');
    expect(stderr).toContain('CODEX_NO_PROJECT');
    expect(stderr).toContain('--scope global');
  });
});
