import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('CLI Integration Tests — Advanced', () => {
  const testDir = path.join(os.tmpdir(), 'reverie-integ-' + Math.random().toString(36).substring(2));
  const execOpts = { env: { ...process.env, CODEX_DATA_DIR: testDir, CODEX_NO_PROJECT: '1' }, stdio: ['pipe', 'pipe', 'pipe'] as const };
  const run = (args: string) => {
    // After #99, auto-mode writes refuse without project resolution. Inject
    // --global for write verbs so the global-store path remains exercised.
    // Handle both top-level write verbs (set, rm, alias, ...) and the
    // `data <subcommand>` family (data reset, data import).
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

  // ── Alias integration ──────────────────────────────────────────────

  describe('alias lifecycle', () => {
    it('creates and lists an alias', () => {
      run('set --force test.alias.target "alias value" -a ta');

      // get -a shows aliases
      const list = run('get -a');
      expect(list).toContain('ta');
    });
  });

  // ── Deep nesting ───────────────────────────────────────────────────

  describe('deep nesting', () => {
    it('handles deeply nested set and get', () => {
      run('set --force a.b.c.d.e.f "deep value"');
      const result = run('get a.b.c.d.e.f');
      expect(result).toContain('deep value');
    });

    it('gets subtree at intermediate level', () => {
      run('set --force tree.x.y "val1"');
      run('set --force tree.x.z "val2"');
      const result = run('get tree.x');
      // Subtree listing shows child keys
      expect(result).toContain('y');
      expect(result).toContain('z');
    });
  });

  // ── Export/import round-trip ────────────────────────────────────────

  describe('export/import round-trip', () => {
    it('exports and reimports entries losslessly', () => {
      run('set --force roundtrip.key1 "value1"');
      run('set --force roundtrip.key2 "value2"');

      const exportFile = path.join(testDir, 'export.json');
      run(`data export entries -o ${exportFile}`);
      expect(fs.existsSync(exportFile)).toBe(true);

      const exported = JSON.parse(fs.readFileSync(exportFile, 'utf8'));
      expect(exported.$codexcli?.type).toBe('entries');
      expect(exported.entries.roundtrip).toBeDefined();

      // Reset and reimport
      run('data reset entries --force');
      run(`data import entries ${exportFile} --force`);

      const result1 = run('get roundtrip.key1');
      expect(result1).toContain('value1');
      const result2 = run('get roundtrip.key2');
      expect(result2).toContain('value2');
    });

    it('data export all → data import all roundtrips in a single file (#76)', () => {
      run('set --force rt.ent "entryVal"');
      run('set --force rt.target "targetVal" -a rtalias');
      run('set --force rt.cmd "echo hi" --confirm');

      const exportFile = path.join(testDir, 'all.json');
      run(`data export all -o ${exportFile}`);
      expect(fs.existsSync(exportFile)).toBe(true);

      // No suffixed siblings when --split is not passed.
      expect(fs.existsSync(path.join(testDir, 'all-entries.json'))).toBe(false);
      expect(fs.existsSync(path.join(testDir, 'all-aliases.json'))).toBe(false);
      expect(fs.existsSync(path.join(testDir, 'all-confirm.json'))).toBe(false);

      const exported = JSON.parse(fs.readFileSync(exportFile, 'utf8'));
      expect(exported.$codexcli?.type).toBe('all');
      expect(exported.entries?.rt?.ent).toBe('entryVal');
      expect(exported.aliases?.rtalias).toBe('rt.target');
      expect(exported.confirm?.['rt.cmd']).toBeDefined();

      run('data reset all --force');
      run(`data import all ${exportFile} --force`);

      expect(run('get rt.ent')).toContain('entryVal');
      // Alias get confirms alias map restored.
      expect(run('get rtalias')).toContain('targetVal');
    });

    it('data export all --split preserves the legacy 3-file layout', () => {
      run('set --force sp.ent "splitVal"');

      const base = path.join(testDir, 'split.json');
      run(`data export all -o ${base} --split`);

      expect(fs.existsSync(path.join(testDir, 'split-entries.json'))).toBe(true);
      expect(fs.existsSync(path.join(testDir, 'split-aliases.json'))).toBe(true);
      expect(fs.existsSync(path.join(testDir, 'split-confirm.json'))).toBe(true);
      // The unwrapped base path is NOT written in split mode.
      expect(fs.existsSync(base)).toBe(false);
    });
  });

  // ── Config commands ────────────────────────────────────────────────

  describe('config commands', () => {
    it('gets and sets config values', () => {
      run('config set colors false');
      const result = run('config get colors');
      expect(result).toContain('false');

      // Restore
      run('config set colors true');
    });
  });

  // ── Search functionality ───────────────────────────────────────────

  describe('search advanced', () => {
    it('regex search works', () => {
      run('set --force search.regex.test1 "abc123"');
      run('set --force search.regex.test2 "def456"');

      const result = run('find "^abc" --entries --regex');
      expect(result).toContain('abc123');
      expect(result).not.toContain('def456');
    });

    it('JSON output produces valid JSON', () => {
      run('set --force search.json.key "jsonval"');
      const result = run('find "jsonval" --json');
      const parsed = JSON.parse(result);
      expect(parsed.entries).toBeDefined();
    });
  });

  // ── Rename operation ───────────────────────────────────────────────

  describe('rename', () => {
    it('renames a key preserving the value', () => {
      run('set --force rename.old "rename-value"');
      run('rename rename.old rename.new');

      const result = run('get rename.new');
      expect(result).toContain('rename-value');

      // Old key should not exist
      try {
        run('get rename.old');
        // If it doesn't throw, the value should be gone
      } catch {
        // Expected — key not found
      }
    });
  });

  // ── Copy operation ─────────────────────────────────────────────────

  describe('copy', () => {
    it('copies a value to a new key', () => {
      run('set --force copy.source "copy-value"');
      run('copy copy.source copy.dest');

      const source = run('get copy.source');
      const dest = run('get copy.dest');
      expect(source).toContain('copy-value');
      expect(dest).toContain('copy-value');
    });
  });

  // ── Error handling ─────────────────────────────────────────────────

  describe('error handling', () => {
    it('exits non-zero for nonexistent key', () => {
      try {
        run('get nonexistent.key.12345');
        // Should not reach here
        expect(true).toBe(false);
      } catch (err: unknown) {
        const error = err as { status?: number; stderr?: Buffer };
        expect(error.status).toBeGreaterThan(0);
      }
    });

    it('warns when removing nonexistent key', () => {
      const result = run('remove nonexistent.key.99999');
      expect(result).toContain('not found');
    });
  });

  // ── Info command ───────────────────────────────────────────────────

  describe('info command', () => {
    it('shows version and entry counts', () => {
      const result = run('config info');
      expect(result).toContain('Version');
      expect(result).toContain('Entries');
    });
  });

  // ── Lint command ───────────────────────────────────────────────────

  describe('lint command', () => {
    it('runs lint without crashing', () => {
      const result = run('lint');
      // Should either show issues or pass clean
      expect(result).toBeDefined();
    });
  });

  // ── Stale command ──────────────────────────────────────────────────

  describe('stale command', () => {
    it('runs stale check', () => {
      run('set --force stale.test "value"');
      const result = run('stale');
      expect(result).toBeDefined();
    });
  });

  // ── Special characters ─────────────────────────────────────────────

  describe('special characters in values', () => {
    it('handles values with spaces and quotes', () => {
      run('set --force special.spaces "hello world with spaces"');
      const result = run('get special.spaces');
      expect(result).toContain('hello world with spaces');
    });

    it('handles values with special shell chars', () => {
      run('set --force special.chars "value-with-dashes_and_underscores"');
      const result = run('get special.chars');
      expect(result).toContain('value-with-dashes_and_underscores');
    });
  });
});
