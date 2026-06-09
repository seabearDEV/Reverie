import fs from 'fs';
import path from 'path';
import os from 'os';
import { generateClaudeMd, CLAUDE_MD_TEMPLATE, generateAgentsMd, AGENTS_MD_TEMPLATE, REVERIE_CORE_GUIDE } from '../commands/claude-md';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-claude-md-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('generateClaudeMd', () => {
  it('creates CLAUDE.md with template content', () => {
    const result = generateClaudeMd({ cwd: tmpDir });
    expect(result).toBe(CLAUDE_MD_TEMPLATE);

    const filePath = path.join(tmpDir, 'CLAUDE.md');
    expect(fs.existsSync(filePath)).toBe(true);
    expect(fs.readFileSync(filePath, 'utf8')).toBe(CLAUDE_MD_TEMPLATE);
  });

  it('skips if CLAUDE.md already exists (no --force)', () => {
    fs.writeFileSync(path.join(tmpDir, 'CLAUDE.md'), 'existing content');

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = generateClaudeMd({ cwd: tmpDir });
    consoleSpy.mockRestore();

    expect(result).toBeNull();
    // Original content preserved
    expect(fs.readFileSync(path.join(tmpDir, 'CLAUDE.md'), 'utf8')).toBe('existing content');
  });

  it('overwrites if --force is set', () => {
    fs.writeFileSync(path.join(tmpDir, 'CLAUDE.md'), 'old content');

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = generateClaudeMd({ cwd: tmpDir, force: true });
    consoleSpy.mockRestore();

    expect(result).toBe(CLAUDE_MD_TEMPLATE);
    expect(fs.readFileSync(path.join(tmpDir, 'CLAUDE.md'), 'utf8')).toBe(CLAUDE_MD_TEMPLATE);
  });

  it('--dryRun returns content without writing', () => {
    const result = generateClaudeMd({ cwd: tmpDir, dryRun: true });
    expect(result).toBe(CLAUDE_MD_TEMPLATE);
    expect(fs.existsSync(path.join(tmpDir, 'CLAUDE.md'))).toBe(false);
  });

  it('--dryRun returns content even if file exists', () => {
    fs.writeFileSync(path.join(tmpDir, 'CLAUDE.md'), 'existing');
    const result = generateClaudeMd({ cwd: tmpDir, dryRun: true });
    // dryRun bypasses the exists check
    expect(result).toBe(CLAUDE_MD_TEMPLATE);
    // File untouched
    expect(fs.readFileSync(path.join(tmpDir, 'CLAUDE.md'), 'utf8')).toBe('existing');
  });

  it('defaults cwd to process.cwd() with dryRun', () => {
    // dryRun avoids writing to the actual project directory
    const result = generateClaudeMd({ dryRun: true });
    expect(result).toBe(CLAUDE_MD_TEMPLATE);
  });
});

describe('CLAUDE_MD_TEMPLATE', () => {
  it('contains Bootstrap section', () => {
    expect(CLAUDE_MD_TEMPLATE).toContain('## Bootstrap');
    expect(CLAUDE_MD_TEMPLATE).toContain('reverie_context');
  });

  it('names both surfaces with the either-surface model (#121, softened post-#117 parity)', () => {
    expect(CLAUDE_MD_TEMPLATE).toContain('same store, same functionality, either surface');
    expect(CLAUDE_MD_TEMPLATE).toContain('reverie_get');
    expect(CLAUDE_MD_TEMPLATE).toContain('rvr get');
    expect(CLAUDE_MD_TEMPLATE).toContain('rvr manifest');
  });

  it('contains Before exploring code section', () => {
    expect(CLAUDE_MD_TEMPLATE).toContain('## Before exploring code');
    expect(CLAUDE_MD_TEMPLATE).toContain('reverie_get');
  });

  it('contains Write back section', () => {
    expect(CLAUDE_MD_TEMPLATE).toContain('## Write back');
    expect(CLAUDE_MD_TEMPLATE).toContain('reverie_set');
  });

  it('contains Do not store section', () => {
    expect(CLAUDE_MD_TEMPLATE).toContain('## Do not store');
  });
});

// #117 WS2: agent-agnostic AGENTS.md.
describe('generateAgentsMd', () => {
  it('creates AGENTS.md with template content', () => {
    const result = generateAgentsMd({ cwd: tmpDir });
    expect(result).toBe(AGENTS_MD_TEMPLATE);
    expect(fs.readFileSync(path.join(tmpDir, 'AGENTS.md'), 'utf8')).toBe(AGENTS_MD_TEMPLATE);
  });

  it('skips if AGENTS.md already exists (no --force)', () => {
    fs.writeFileSync(path.join(tmpDir, 'AGENTS.md'), 'existing');
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = generateAgentsMd({ cwd: tmpDir });
    consoleSpy.mockRestore();
    expect(result).toBeNull();
    expect(fs.readFileSync(path.join(tmpDir, 'AGENTS.md'), 'utf8')).toBe('existing');
  });

  it('--dryRun returns content without writing', () => {
    const result = generateAgentsMd({ cwd: tmpDir, dryRun: true });
    expect(result).toBe(AGENTS_MD_TEMPLATE);
    expect(fs.existsSync(path.join(tmpDir, 'AGENTS.md'))).toBe(false);
  });
});

describe('AGENTS_MD_TEMPLATE', () => {
  it('is agent-agnostic and names both surfaces — same store, either surface (#121)', () => {
    // CLI path
    expect(AGENTS_MD_TEMPLATE).toContain('rvr context');
    expect(AGENTS_MD_TEMPLATE).toContain('--json');
    expect(AGENTS_MD_TEMPLATE).toContain('rvr manifest');
    // MCP path is named too — the file is read before the agent knows its surface,
    // so it must carry the full either-surface decision (this is the #121 fix:
    // the old AGENTS-is-CLI-only / CLAUDE-is-MCP-only split stranded MCP-less agents).
    expect(AGENTS_MD_TEMPLATE).toContain('reverie_context');
    expect(AGENTS_MD_TEMPLATE).toContain('reverie_set');
    expect(AGENTS_MD_TEMPLATE).toContain('same store, same functionality, either surface');
    // Agent-agnostic title, not Claude-specific.
    expect(AGENTS_MD_TEMPLATE).toContain('# Reverie — agent guide');
  });
});

describe('shared core (#121)', () => {
  it('CLAUDE.md and AGENTS.md compose from the same operational core', () => {
    expect(CLAUDE_MD_TEMPLATE).toContain(REVERIE_CORE_GUIDE);
    expect(AGENTS_MD_TEMPLATE).toContain(REVERIE_CORE_GUIDE);
  });
});
