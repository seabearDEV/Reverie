import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  scanCodebase,
  detectProject,
  detectCommands,
  detectFiles,
  detectDeps,
  detectConventions,
  detectContext,
  KNOWN_DEPS,
} from '../commands/scan';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-scan-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Helpers ──────────────────────────────────────────────────────────

function writePkg(overrides: Record<string, unknown> = {}): void {
  const pkg = {
    name: 'test-project',
    description: 'A test project',
    scripts: { build: 'tsc', test: 'vitest', lint: 'eslint .' },
    dependencies: {},
    devDependencies: {},
    ...overrides,
  };
  fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify(pkg));
}

function touch(...paths: string[]): void {
  for (const p of paths) {
    const full = path.join(tmpDir, p);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, '');
  }
}

// ── detectProject ────────────────────────────────────────────────────

describe('detectProject', () => {
  it('extracts name, description, and stack from package.json', () => {
    writePkg({ dependencies: { typescript: '^5', react: '^18' } });
    const entries = detectProject(tmpDir);
    expect(entries.find(e => e.key === 'project.name')?.value).toBe('test-project');
    expect(entries.find(e => e.key === 'project.description')?.value).toBe('A test project');
    const stack = entries.find(e => e.key === 'project.stack')?.value;
    expect(stack).toContain('Node.js');
    expect(stack).toContain('TypeScript');
    expect(stack).toContain('React');
  });

  it('detects Go project from go.mod', () => {
    fs.writeFileSync(path.join(tmpDir, 'go.mod'), 'module github.com/user/repo\n\ngo 1.21\n');
    const entries = detectProject(tmpDir);
    expect(entries.find(e => e.key === 'project.name')?.value).toBe('github.com/user/repo');
    expect(entries.find(e => e.key === 'project.stack')?.value).toBe('Go');
  });

  it('detects Rust project', () => {
    touch('Cargo.toml');
    const entries = detectProject(tmpDir);
    expect(entries.find(e => e.key === 'project.stack')?.value).toBe('Rust');
  });

  it('detects Python project', () => {
    touch('pyproject.toml');
    const entries = detectProject(tmpDir);
    expect(entries.find(e => e.key === 'project.stack')?.value).toBe('Python');
  });

  it('returns empty for empty directory', () => {
    expect(detectProject(tmpDir)).toEqual([]);
  });
});

// ── detectCommands ───────────────────────────────────────────────────

describe('detectCommands', () => {
  it('maps npm scripts to commands.*', () => {
    writePkg({ scripts: { build: 'tsc', test: 'vitest', lint: 'eslint .', dev: 'tsx watch' } });
    const entries = detectCommands(tmpDir);
    expect(entries.find(e => e.key === 'commands.build')?.value).toBe('npm run build');
    expect(entries.find(e => e.key === 'commands.test')?.value).toBe('npm run test');
    expect(entries.find(e => e.key === 'commands.lint')?.value).toBe('npm run lint');
    expect(entries.find(e => e.key === 'commands.dev')?.value).toBe('npm run dev');
  });

  it('detects Go commands', () => {
    touch('go.mod');
    const entries = detectCommands(tmpDir);
    expect(entries.find(e => e.key === 'commands.build')?.value).toBe('go build ./...');
    expect(entries.find(e => e.key === 'commands.test')?.value).toBe('go test ./...');
  });

  it('detects Rust commands', () => {
    touch('Cargo.toml');
    const entries = detectCommands(tmpDir);
    expect(entries.find(e => e.key === 'commands.build')?.value).toBe('cargo build');
    expect(entries.find(e => e.key === 'commands.test')?.value).toBe('cargo test');
  });

  it('detects Python + Makefile commands', () => {
    touch('pyproject.toml', 'Makefile');
    const entries = detectCommands(tmpDir);
    expect(entries.find(e => e.key === 'commands.build')?.value).toBe('make build');
    expect(entries.find(e => e.key === 'commands.test')?.value).toBe('make test');
  });

  it('returns empty when no scripts defined', () => {
    writePkg({ scripts: {} });
    expect(detectCommands(tmpDir)).toEqual([]);
  });
});

// ── detectFiles ──────────────────────────────────────────────────────

describe('detectFiles', () => {
  it('detects TypeScript entry point', () => {
    touch('src/index.ts');
    const entries = detectFiles(tmpDir);
    expect(entries.find(e => e.key === 'files.entry')?.value).toContain('src/index.ts');
  });

  it('detects Go entry point', () => {
    touch('main.go');
    const entries = detectFiles(tmpDir);
    expect(entries.find(e => e.key === 'files.entry')?.value).toContain('main.go');
  });

  it('detects test directory', () => {
    touch('src/__tests__/dummy.ts');
    const entries = detectFiles(tmpDir);
    expect(entries.find(e => e.key === 'files.tests')?.value).toContain('__tests__');
  });

  it('detects tsconfig', () => {
    touch('tsconfig.json');
    const entries = detectFiles(tmpDir);
    expect(entries.find(e => e.key === 'files.tsconfig')).toBeDefined();
  });

  it('detects Dockerfile', () => {
    touch('Dockerfile');
    const entries = detectFiles(tmpDir);
    expect(entries.find(e => e.key === 'files.docker')?.value).toContain('Dockerfile');
  });

  it('detects GitHub Actions CI', () => {
    touch('.github/workflows/ci.yml');
    const entries = detectFiles(tmpDir);
    expect(entries.find(e => e.key === 'files.ci')?.value).toContain('GitHub Actions');
  });

  it('detects GitLab CI', () => {
    touch('.gitlab-ci.yml');
    const entries = detectFiles(tmpDir);
    expect(entries.find(e => e.key === 'files.ci')?.value).toContain('GitLab');
  });

  it('returns only first entry point match', () => {
    touch('src/index.ts', 'src/main.ts');
    const entries = detectFiles(tmpDir);
    const entryPoints = entries.filter(e => e.key === 'files.entry');
    expect(entryPoints).toHaveLength(1);
  });

  it('returns empty for empty directory', () => {
    expect(detectFiles(tmpDir)).toEqual([]);
  });
});

// ── detectDeps ───────────────────────────────────────────────────────

describe('detectDeps', () => {
  it('detects known dependencies', () => {
    writePkg({ dependencies: { express: '^4', react: '^18' } });
    const entries = detectDeps(tmpDir);
    expect(entries.find(e => e.key === 'deps.express')?.value).toContain('Express');
    expect(entries.find(e => e.key === 'deps.react')?.value).toContain('React');
  });

  it('detects devDependencies', () => {
    writePkg({ devDependencies: { vitest: '^2', esbuild: '^0.20' } });
    const entries = detectDeps(tmpDir);
    expect(entries.find(e => e.key === 'deps.vitest')).toBeDefined();
    expect(entries.find(e => e.key === 'deps.esbuild')).toBeDefined();
  });

  it('skips unknown dependencies', () => {
    writePkg({ dependencies: { 'some-internal-pkg': '1.0' } });
    const entries = detectDeps(tmpDir);
    expect(entries).toEqual([]);
  });

  it('handles scoped packages (@ stripped, / replaced)', () => {
    writePkg({ dependencies: { '@anthropic-ai/sdk': '^1' } });
    const entries = detectDeps(tmpDir);
    expect(entries.find(e => e.key === 'deps.anthropic-ai-sdk')).toBeDefined();
  });

  it('returns empty without package.json', () => {
    expect(detectDeps(tmpDir)).toEqual([]);
  });
});

// ── detectConventions ────────────────────────────────────────────────

describe('detectConventions', () => {
  it('detects Vitest test runner', () => {
    writePkg({ devDependencies: { vitest: '^2' } });
    const entries = detectConventions(tmpDir);
    expect(entries.find(e => e.key === 'conventions.tests')?.value).toContain('Vitest');
  });

  it('detects Jest test runner', () => {
    writePkg({ devDependencies: { jest: '^29' } });
    const entries = detectConventions(tmpDir);
    expect(entries.find(e => e.key === 'conventions.tests')?.value).toContain('Jest');
  });

  it('detects ESM module system', () => {
    writePkg({ type: 'module' });
    const entries = detectConventions(tmpDir);
    expect(entries.find(e => e.key === 'conventions.modules')?.value).toContain('ESM');
  });

  it('detects CJS module system', () => {
    writePkg({ type: 'commonjs' });
    const entries = detectConventions(tmpDir);
    expect(entries.find(e => e.key === 'conventions.modules')?.value).toContain('CommonJS');
  });

  it('detects ESLint from config file', () => {
    writePkg();
    touch('eslint.config.js');
    const entries = detectConventions(tmpDir);
    expect(entries.find(e => e.key === 'conventions.linting')?.value).toContain('ESLint');
  });

  it('detects Prettier from config file', () => {
    writePkg();
    touch('.prettierrc');
    const entries = detectConventions(tmpDir);
    expect(entries.find(e => e.key === 'conventions.formatting')?.value).toContain('Prettier');
  });

  it('detects TypeScript strict mode', () => {
    writePkg();
    fs.writeFileSync(path.join(tmpDir, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { strict: true, exactOptionalPropertyTypes: true },
    }));
    const entries = detectConventions(tmpDir);
    const types = entries.find(e => e.key === 'conventions.types');
    expect(types?.value).toContain('strict');
    expect(types?.value).toContain('exactOptionalPropertyTypes');
  });

  it('detects pytest', () => {
    touch('pyproject.toml', 'conftest.py');
    const entries = detectConventions(tmpDir);
    expect(entries.find(e => e.key === 'conventions.tests')?.value).toContain('pytest');
  });
});

// ── detectContext ─────────────────────────────────────────────────────

describe('detectContext', () => {
  it('detects GitHub Actions CI', () => {
    touch('.github/workflows/ci.yml');
    const entries = detectContext(tmpDir);
    expect(entries.find(e => e.key === 'context.ci')?.value).toContain('GitHub Actions');
  });

  it('detects Docker', () => {
    touch('Dockerfile');
    const entries = detectContext(tmpDir);
    expect(entries.find(e => e.key === 'context.docker')).toBeDefined();
  });

  it('detects .env.example', () => {
    touch('.env.example');
    const entries = detectContext(tmpDir);
    expect(entries.find(e => e.key === 'context.env')).toBeDefined();
  });

  it('detects npm workspaces monorepo', () => {
    writePkg({ workspaces: ['packages/*'] });
    fs.mkdirSync(path.join(tmpDir, 'packages'), { recursive: true });
    const entries = detectContext(tmpDir);
    expect(entries.find(e => e.key === 'context.monorepo')?.value).toContain('workspaces');
  });

  it('detects Turborepo monorepo', () => {
    touch('turbo.json', 'packages/a/package.json');
    const entries = detectContext(tmpDir);
    expect(entries.find(e => e.key === 'context.monorepo')?.value).toContain('Turborepo');
  });

  it('detects pnpm workspace monorepo', () => {
    touch('pnpm-workspace.yaml');
    const entries = detectContext(tmpDir);
    expect(entries.find(e => e.key === 'context.monorepo')?.value).toContain('pnpm');
  });

  it('returns empty for vanilla directory', () => {
    expect(detectContext(tmpDir)).toEqual([]);
  });
});

// ── scanCodebase (end-to-end) ─────────────────────────────────────────

describe('scanCodebase', () => {
  it('returns comprehensive entries for a Node.js project', () => {
    writePkg({
      dependencies: { express: '^4' },
      devDependencies: { vitest: '^2', typescript: '^5' },
      scripts: { build: 'tsc', test: 'vitest' },
    });
    touch('src/index.ts', 'src/__tests__/app.test.ts', 'tsconfig.json', '.github/workflows/ci.yml');
    fs.writeFileSync(path.join(tmpDir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true } }));

    const entries = scanCodebase(tmpDir);

    // Should have entries across multiple namespaces
    const namespaces = new Set(entries.map(e => e.key.split('.')[0]));
    expect(namespaces.has('project')).toBe(true);
    expect(namespaces.has('commands')).toBe(true);
    expect(namespaces.has('files')).toBe(true);
    expect(namespaces.has('deps')).toBe(true);
    expect(namespaces.has('conventions')).toBe(true);
    expect(namespaces.has('context')).toBe(true);
  });

  it('returns entries for a Go project', () => {
    fs.writeFileSync(path.join(tmpDir, 'go.mod'), 'module github.com/user/app\n\ngo 1.21\n');
    touch('main.go');

    const entries = scanCodebase(tmpDir);
    expect(entries.find(e => e.key === 'project.stack')?.value).toBe('Go');
    expect(entries.find(e => e.key === 'commands.build')?.value).toBe('go build ./...');
    expect(entries.find(e => e.key === 'files.entry')?.value).toContain('main.go');
  });

  it('returns empty for empty directory', () => {
    expect(scanCodebase(tmpDir)).toEqual([]);
  });
});

// ── KNOWN_DEPS table ─────────────────────────────────────────────────

describe('KNOWN_DEPS', () => {
  it('has entries for common packages', () => {
    expect(KNOWN_DEPS['express']).toBeDefined();
    expect(KNOWN_DEPS['react']).toBeDefined();
    expect(KNOWN_DEPS['vitest']).toBeDefined();
    expect(KNOWN_DEPS['prisma']).toBeDefined();
    expect(KNOWN_DEPS['zod']).toBeDefined();
  });

  it('has no empty descriptions', () => {
    for (const [, desc] of Object.entries(KNOWN_DEPS)) {
      expect(desc.length).toBeGreaterThan(0);
    }
  });
});
