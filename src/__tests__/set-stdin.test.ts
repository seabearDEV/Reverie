// `rvr set <key>` with the value on stdin. A pipe always worked. A regular
// file on fd 0 — which is what `< file`, a here-string and (in zsh, and in
// bash before 5.1) a heredoc are — read as empty, so the natural way to write
// a multi-line entry from a shell failed with "No input received from stdin".
//
// Spawns the built dist/index.js (assumes `bun run build` has run). The
// file and pipe cases set fd 0 directly instead of going through a shell, so
// what they exercise does not depend on how the local shell implements
// redirection.

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { assertDistHonorsDataDir } from './helpers/spawnGuard';

describe('set reads its value from stdin', () => {
  const testDir = path.join(os.tmpdir(), 'reverie-stdin-' + Math.random().toString(36).slice(2));
  const env = { ...process.env, RVR_DATA_DIR: testDir, RVR_NO_PROJECT: '1' };
  const VALUE = 'line one\nline two\n\nline four: "quotes" and $dollars';

  const setFrom = (stdin: { input: string } | { fd: number }, args: string[]) =>
    spawnSync('bun', ['dist/index.js', 'set', '--global', ...args], 'input' in stdin
      ? { env, input: stdin.input }
      : { env, stdio: [stdin.fd, 'pipe', 'pipe'] });

  const setFromFile = (content: string, args: string[]) => {
    const file = path.join(testDir, `value-${Math.random().toString(36).slice(2)}.txt`);
    fs.writeFileSync(file, content);
    const fd = fs.openSync(file, 'r');
    try {
      return setFrom({ fd }, args);
    } finally {
      fs.closeSync(fd);
    }
  };

  const stored = (key: string): string | undefined => {
    const r = spawnSync('bun', ['dist/index.js', '--json', 'get', key], { env });
    return (JSON.parse(r.stdout.toString()) as { result?: Record<string, string> }).result?.[key];
  };

  beforeAll(() => {
    assertDistHonorsDataDir();
    fs.mkdirSync(testDir, { recursive: true });
  });
  afterAll(() => { fs.rmSync(testDir, { recursive: true, force: true }); });

  it('from a pipe', () => {
    const r = setFrom({ input: VALUE + '\n' }, ['stdin.pipe']);
    expect(r.stderr.toString()).toBe('');
    expect(r.status).toBe(0);
    expect(stored('stdin.pipe')).toBe(VALUE);
  });

  it('from a regular file on fd 0 (`< file`, here-string, zsh heredoc)', () => {
    const r = setFromFile(VALUE + '\n', ['stdin.file']);
    expect(r.stderr.toString()).not.toContain('No input received');
    expect(r.status).toBe(0);
    expect(stored('stdin.file')).toBe(VALUE);
  });

  it('file and pipe store the same bytes for the same input', () => {
    const input = '  leading spaces kept\ttabs\nüñí©ødé — ✓\ntrailing newlines trimmed\n\n\n';
    expect(setFrom({ input }, ['stdin.same.pipe']).status).toBe(0);
    expect(setFromFile(input, ['stdin.same.file']).status).toBe(0);
    expect(stored('stdin.same.file')).toBe(stored('stdin.same.pipe'));
    expect(stored('stdin.same.file')).toBe(input.trimEnd());
  });

  it('reads a file larger than a pipe buffer whole', () => {
    const big = Array.from({ length: 2500 }, (_, i) => `row ${i} ${'x'.repeat(40)}`).join('\n');
    expect(Buffer.byteLength(big)).toBeGreaterThan(100_000);
    expect(setFromFile(big + '\n', ['stdin.big.file']).status).toBe(0);
    expect(setFrom({ input: big + '\n' }, ['stdin.big.pipe']).status).toBe(0);
    expect(stored('stdin.big.file')).toBe(big);
    expect(stored('stdin.big.pipe')).toBe(big);
  });

  it('through a shell heredoc', () => {
    const r = spawnSync('sh', ['-c', "bun dist/index.js set --global stdin.heredoc <<'EOF'\nheredoc one\nheredoc $HOME two\nEOF"], { env });
    expect(r.stderr.toString()).not.toContain('No input received');
    expect(r.status).toBe(0);
    expect(stored('stdin.heredoc')).toBe('heredoc one\nheredoc $HOME two');
  });

  it('an empty file is still "no input", and writes nothing', () => {
    for (const content of ['', '\n\n']) {
      const r = setFromFile(content, ['stdin.empty']);
      expect(r.status).toBe(1);
      expect(r.stderr.toString()).toContain('No input received from stdin.');
    }
    expect(stored('stdin.empty')).toBeUndefined();
  });

  it('--json reports the file-fed write in the envelope', () => {
    const r = setFromFile('json mode value\n', ['--json', 'stdin.json']);
    const envelope = JSON.parse(r.stdout.toString()) as { ok: boolean; command: string };
    expect(envelope.ok).toBe(true);
    expect(envelope.command).toBe('set');
    expect(stored('stdin.json')).toBe('json mode value');
  });

  it('an alias-only update with an empty file on stdin leaves the value alone', () => {
    expect(setFrom({ input: 'kept\n' }, ['stdin.aliasonly']).status).toBe(0);
    const r = setFromFile('', ['stdin.aliasonly', '-a', 'stdinalias']);
    expect(r.status).toBe(0);
    expect(stored('stdin.aliasonly')).toBe('kept');
  });

  // The consequence of reading files: a value-less `set` carrying only -a /
  // --confirm / --no-confirm takes a NON-empty file as the value, exactly as
  // it always has for a pipe. Before the fix the file read as empty, so these
  // were metadata-only updates. Pinned so the change stays a decision.
  it('a value-less set with -a or --confirm takes a non-empty file as the value, like a pipe', () => {
    for (const flags of [['-a', 'stdinvl'], ['--confirm'], ['--no-confirm']]) {
      const tag = flags[0].replace(/^-+/, '');
      for (const via of ['file', 'pipe'] as const) {
        const key = `stdin.valueless.${tag}.${via}`;
        const args = [key, ...flags.map(f => (f === 'stdinvl' ? `stdinvl${via}` : f))];
        expect(setFrom({ input: 'original\n' }, [key]).status).toBe(0);
        const r = via === 'file' ? setFromFile('replacement\n', args) : setFrom({ input: 'replacement\n' }, args);
        expect(r.status).toBe(0);
        expect(stored(key)).toBe('replacement');
      }
    }
  });

  it('`confirm set` and `alias set` never read stdin, so they are safe where stdin is inherited', () => {
    expect(setFrom({ input: 'untouched\n' }, ['stdin.meta']).status).toBe(0);
    const file = path.join(testDir, 'inherited.txt');
    fs.writeFileSync(file, 'this must not become the value\n');
    for (const args of [['confirm', 'set', 'stdin.meta', '--global'], ['alias', 'set', 'stdinmeta', 'stdin.meta', '--global']]) {
      const fd = fs.openSync(file, 'r');
      try {
        expect(spawnSync('bun', ['dist/index.js', ...args], { env, stdio: [fd, 'pipe', 'pipe'] }).status).toBe(0);
      } finally {
        fs.closeSync(fd);
      }
    }
    expect(stored('stdin.meta')).toBe('untouched');
  });
});
