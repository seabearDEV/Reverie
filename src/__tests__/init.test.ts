/**
 * Integration tests for the enhanced `rvr init` command.
 */
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { readDirectoryStore } from './helpers/readStoreState';

let tmpDir: string;

// v1.10.0: `rvr init` creates a `.codexcli/` directory, not a `.codexcli.json`
// file. These helpers read the new layout and reconstitute the legacy shape.
const readProjectData = (dir: string) =>
  readDirectoryStore(path.join(dir, '.codexcli'));

const projectStorePath = (dir: string) => path.join(dir, '.codexcli');

// Resolve the CLI path relative to the project root (two levels up from __tests__)
const cliPath = path.resolve(__dirname, '..', '..', 'dist', 'index.js');

const run = (args: string, cwd?: string) => {
  return execSync(`node ${cliPath} ${args}`, {
    cwd: cwd ?? tmpDir,
    timeout: 10000,
  }).toString();
};

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-init-'));
  // Seed a minimal package.json so scaffold has something to detect
  fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({
    name: 'init-test',
    description: 'Test project',
    scripts: { build: 'tsc', test: 'vitest' },
    dependencies: { express: '^4' },
    devDependencies: { vitest: '^2', typescript: '^5' },
  }));
  fs.writeFileSync(path.join(tmpDir, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { strict: true },
  }));
  fs.mkdirSync(path.join(tmpDir, 'src/__tests__'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'src/index.ts'), '');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('rvr init — full flow', () => {
  it('creates .codexcli/ with scanned entries', () => {
    const output = run('init');
    expect(output).toContain('Created:');

    const data = readProjectData(tmpDir);
    expect((data.entries as any).project.name).toBe('init-test');
    expect((data.entries as any).project.stack).toContain('Node.js');
    expect((data.entries as any).commands.build).toBe('npm run build');
    expect((data.entries as any).files.entry).toContain('src/index.ts');
    expect((data.entries as any).conventions.types).toContain('strict');
  });

  it('creates CLAUDE.md', () => {
    run('init');
    const claudeMd = fs.readFileSync(path.join(tmpDir, 'CLAUDE.md'), 'utf8');
    expect(claudeMd).toContain('## Bootstrap');
    expect(claudeMd).toContain('codex_context');
    expect(claudeMd).toContain('codex_set');
  });

  it('seeds conventions.persistence', () => {
    run('init');
    const data = readProjectData(tmpDir);
    const persistence = (data.entries as any).conventions.persistence;
    expect(persistence).toContain('.codexcli');
    expect(persistence).toContain('CLAUDE.md');
    expect(persistence).toContain('MEMORY.md');
  });

  it('detects deps from package.json', () => {
    run('init');
    const data = readProjectData(tmpDir);
    expect((data.entries as any).deps.express).toContain('Express');
    expect((data.entries as any).deps.vitest).toContain('Vitest');
  });
});

describe('rvr init — idempotency', () => {
  it('running twice produces no duplicates', () => {
    run('init');
    const output2 = run('init');
    // Second run: .codexcli/ exists, entries exist, CLAUDE.md exists
    expect(output2).toContain('already exists');
  });

  it('second run does not modify existing entries', () => {
    run('init');
    const first = readProjectData(tmpDir);

    run('init');
    const second = readProjectData(tmpDir);

    // Compare entries (ignoring _meta timestamps)
    delete first._meta;
    delete second._meta;
    expect(second).toEqual(first);
  });
});

describe('rvr init — flags', () => {
  it('--no-scan skips codebase analysis', () => {
    run('init --no-scan');
    const data = readProjectData(tmpDir);
    // Entries should be empty (no scan)
    expect(data.entries).toEqual({});
  });

  it('--no-claude skips CLAUDE.md generation', () => {
    run('init --no-claude');
    expect(fs.existsSync(projectStorePath(tmpDir))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'CLAUDE.md'))).toBe(false);
  });

  it('--force overwrites existing CLAUDE.md', () => {
    fs.writeFileSync(path.join(tmpDir, 'CLAUDE.md'), 'custom content');
    run('init --force');
    const claudeMd = fs.readFileSync(path.join(tmpDir, 'CLAUDE.md'), 'utf8');
    expect(claudeMd).toContain('## Bootstrap');
    expect(claudeMd).not.toContain('custom content');
  });

  it('--remove deletes .codexcli/', () => {
    run('init'); // create it first
    expect(fs.existsSync(projectStorePath(tmpDir))).toBe(true);

    run('init --remove');
    expect(fs.existsSync(projectStorePath(tmpDir))).toBe(false);
  });

  it('--scaffold still works (backward compat)', () => {
    run('init --scaffold');
    const data = readProjectData(tmpDir);
    expect((data.entries as any).project.name).toBe('init-test');
  });

  it('--dry-run previews without writing', () => {
    const output = run('init --dry-run');
    expect(output).toContain('Would scaffold');
    // Files should NOT be created
    expect(fs.existsSync(projectStorePath(tmpDir))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, 'CLAUDE.md'))).toBe(false);
  });
});

describe('rvr init — empty directory', () => {
  it('creates .codexcli/ and CLAUDE.md even with no project files', () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-init-empty-'));
    try {
      run('init', emptyDir);
      expect(fs.existsSync(projectStorePath(emptyDir))).toBe(true);
      expect(fs.existsSync(path.join(emptyDir, 'CLAUDE.md'))).toBe(true);
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});
