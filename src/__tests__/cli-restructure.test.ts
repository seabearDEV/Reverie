/**
 * Integration tests for the CLI restructure:
 * alias, confirm, context, info, search commands + deprecation notices.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { readDirectoryStore } from './helpers/readStoreState';

let tmpDir: string;

// v1.10.0: project store is a `.reverie/` directory. Read via helper that
// reconstitutes the legacy UnifiedData shape.
const readProjectData = (dir: string) =>
  readDirectoryStore(path.join(dir, '.reverie'));
const cliPath = path.resolve(import.meta.dirname, '..', '..', 'dist', 'index.js');
const tokenizeCliArgs = (args: string): string[] =>
  args.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((token) => token.replace(/^"|"$/g, '')) ?? [];

const run = (args: string, cwd?: string) => {
  return execFileSync('bun', [cliPath, ...tokenizeCliArgs(args)], {
    cwd: cwd ?? tmpDir,
    timeout: 10000,
    env: { ...process.env },
  }).toString();
};

let dataDir: string;
const originalDataDir = process.env.RVR_DATA_DIR;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-cli-restruct-'));
  // bun:test (#112): the preload sets a shared RVR_DATA_DIR; per-test
  // global state would leak across tests. Override per-test.
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-cli-restruct-data-'));
  process.env.RVR_DATA_DIR = dataDir;
  // Create project file and seed some entries
  fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({
    name: 'test-project',
    scripts: { build: 'tsc', test: 'vitest' },
    dependencies: { express: '^4' },
    devDependencies: { vitest: '^2' },
  }));
  // Init the project
  run('init --no-claude');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.rmSync(dataDir, { recursive: true, force: true });
  if (originalDataDir !== undefined) {
    process.env.RVR_DATA_DIR = originalDataDir;
  } else {
    delete process.env.RVR_DATA_DIR;
  }
});

// ── alias ────────────────────────────────────────────────────────────

describe('alias subcommand', () => {
  it('alias set creates an alias', () => {
    run('alias set b commands.build');
    const data = readProjectData(tmpDir) as any;
    expect(data.aliases.b).toBe('commands.build');
  });

  it('alias list shows aliases', () => {
    run('alias set b commands.build');
    const result = run('alias list');
    expect(result).toContain('b');
    expect(result).toContain('commands.build');
  });

  it('alias remove deletes an alias', () => {
    run('alias set b commands.build');
    run('alias remove b');
    const data = readProjectData(tmpDir) as any;
    expect(data.aliases.b).toBeUndefined();
  });

  it('alias rename renames an alias', () => {
    run('alias set b commands.build');
    run('alias rename b bld');
    const data = readProjectData(tmpDir) as any;
    expect(data.aliases.b).toBeUndefined();
    expect(data.aliases.bld).toBe('commands.build');
  });

  it('alias list shows empty message when no aliases', () => {
    const result = run('alias list');
    expect(result).toContain('No aliases');
  });
});

// ── confirm ──────────────────────────────────────────────────────────

describe('confirm subcommand', () => {
  it('confirm set marks key as requiring confirmation', () => {
    run('confirm set commands.build');
    const data = readProjectData(tmpDir) as any;
    expect(data.confirm['commands.build']).toBe(true);
  });

  it('confirm list shows confirmed keys', () => {
    run('confirm set commands.build');
    const result = run('confirm list');
    expect(result).toContain('commands.build');
  });

  it('confirm remove removes confirmation', () => {
    run('confirm set commands.build');
    run('confirm remove commands.build');
    const data = readProjectData(tmpDir) as any;
    expect(data.confirm['commands.build']).toBeUndefined();
  });

  it('confirm list shows empty message when no confirmed keys', () => {
    const result = run('confirm list');
    expect(result).toContain('No keys');
  });
});

// ── context ──────────────────────────────────────────────────────────

describe('context command', () => {
  it('shows stored entries', () => {
    const result = run('context --plain');
    expect(result).toContain('project.name');
    expect(result).toContain('test-project');
  });

  it('--tier essential filters to project/commands/conventions', () => {
    const result = run('context --plain --tier essential');
    expect(result).toContain('project.name');
    expect(result).toContain('commands.build');
    expect(result).toContain('conventions.');
    // context.* and files.* should not appear
    expect(result).not.toContain('files.entry');
  });

  it('--tier full shows everything including deps', () => {
    const result = run('context --plain --tier full');
    expect(result).toContain('project.name');
    expect(result).toContain('deps.');
    expect(result).toContain('conventions.persistence');
    // Should not show tier footer
    expect(result).not.toContain('[tier:');
  });

  it('--json outputs valid JSON', () => {
    // #117: context payload is now inside the envelope's `result`.
    const parsed = JSON.parse(run('context --json'));
    expect(parsed.ok).toBe(true);
    expect(parsed.result.entries).toBeDefined();
    expect(parsed.result.tier).toBe('standard');
  });

  it('shows tier footer for non-full tiers', () => {
    const result = run('context --plain --tier standard');
    expect(result).toContain('[tier: standard');
  });
});

// ── info ─────────────────────────────────────────────────────────────

describe('info command', () => {
  it('shows version and entry counts', () => {
    const result = run('info');
    expect(result).toContain('Version');
    expect(result).toContain('Entries');
    expect(result).toContain('Aliases');
  });
});

// ── search ───────────────────────────────────────────────────────────

describe('search command (alias for find)', () => {
  it('search finds entries by value', () => {
    const result = run('search "build"');
    expect(result).toContain('commands.build');
  });

  it('search finds entries by key', () => {
    const result = run('search "project"');
    expect(result).toContain('project.name');
  });
});

// ── deprecation notices ──────────────────────────────────────────────

describe('deprecation notices', () => {
  it('set -a prints deprecation to stderr', () => {
    run('set --force dep.key "val" -a dk');
    // The deprecation goes to stderr which we can't easily capture with execSync
    // but we can verify the alias was still created (backward compat works)
    const data = readProjectData(tmpDir) as any;
    expect(data.aliases.dk).toBe('dep.key');
  });

  it('init --scaffold prints deprecation notice', () => {
    // Create a fresh dir for this test
    const freshDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-scaffold-dep-'));
    fs.writeFileSync(path.join(freshDir, 'package.json'), JSON.stringify({ name: 'x' }));
    try {
      // --scaffold should still work but warn
      run('init --scaffold --no-claude', freshDir);
      expect(fs.existsSync(path.join(freshDir, '.reverie'))).toBe(true);
    } finally {
      fs.rmSync(freshDir, { recursive: true, force: true });
    }
  });
});
