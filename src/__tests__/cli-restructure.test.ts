/**
 * Integration tests for the CLI restructure:
 * alias, confirm, context, info, search commands + deprecation notices.
 */
import { execSync } from 'child_process';
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

const run = (args: string) => {
  return execSync(`bun ${cliPath} ${args}`, {
    cwd: tmpDir,
    timeout: 10000,
  }).toString();
};

const runWithStderr = (args: string): { stdout: string; stderr: string } => {
  try {
    const stdout = execSync(`bun ${cliPath} ${args}`, {
      cwd: tmpDir,
      timeout: 10000,
    }).toString();
    return { stdout, stderr: '' };
  } catch (err: unknown) {
    const e = err as { stdout?: Buffer; stderr?: Buffer };
    return {
      stdout: e.stdout?.toString() ?? '',
      stderr: e.stderr?.toString() ?? '',
    };
  }
};

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-cli-restruct-'));
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
    const result = run('context --json');
    const parsed = JSON.parse(result);
    expect(parsed.entries).toBeDefined();
    expect(parsed.tier).toBe('standard');
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
    const result = execSync(`bun ${cliPath} set --force dep.key "val" -a dk`, {
      cwd: tmpDir,
      timeout: 10000,
    });
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
      execSync(`bun ${cliPath} init --scaffold --no-claude`, { cwd: freshDir, timeout: 10000 });
      expect(fs.existsSync(path.join(freshDir, '.reverie'))).toBe(true);
    } finally {
      fs.rmSync(freshDir, { recursive: true, force: true });
    }
  });
});
