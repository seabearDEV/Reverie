// `rvr set <key>` with the value on stdin. A pipe always worked. A regular
// file on fd 0 — which is what `< file`, a here-string and (in zsh, and in
// bash before 5.1) a heredoc are — read as empty, so the natural way to write
// a multi-line entry from a shell failed with "No input received from stdin".
//
// Spawns the built dist/index.js (assumes `bun run build` has run). The
// file and pipe cases set fd 0 directly instead of going through a shell, so
// what they exercise does not depend on how the local shell implements
// redirection.

import { spawn, spawnSync } from 'child_process';
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

  // ── #225: stdin that is open and silent ──────────────────────────────
  // An agent harness can leave the shell's stdin open with nothing on it. A
  // metadata-only `set` waited there forever. Every spawn below carries a
  // kill timer, so a regression fails a test instead of hanging the suite.

  interface Run { status: number | null; stdout: string; stderr: string; killed: boolean; elapsedMs: number }
  const WINDOW_MS = 300;

  const setWithOpenStdin = (
    args: string[],
    opts: { killAfterMs: number; feed?: { afterMs: number; text: string }[]; endAfterMs?: number; json?: boolean },
  ): Promise<Run> => new Promise(resolve => {
    const started = Date.now();
    const child = spawn('bun', ['dist/index.js', ...(opts.json ? ['--json'] : []), 'set', '--global', ...args], {
      env: { ...env, RVR_STDIN_WAIT_MS: String(WINDOW_MS) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let killed = false;
    const timers: ReturnType<typeof setTimeout>[] = [];
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.stdin.on('error', () => { /* the child let go of stdin: expected */ });
    for (const f of opts.feed ?? []) timers.push(setTimeout(() => { child.stdin.write(f.text); }, f.afterMs));
    if (opts.endAfterMs !== undefined) timers.push(setTimeout(() => { child.stdin.end(); }, opts.endAfterMs));
    timers.push(setTimeout(() => { killed = true; child.kill('SIGKILL'); }, opts.killAfterMs));
    child.on('close', status => {
      for (const t of timers) clearTimeout(t);
      resolve({ status, stdout, stderr, killed, elapsedMs: Date.now() - started });
    });
  });

  const jsonGet = (...args: string[]) =>
    JSON.parse(spawnSync('bun', ['dist/index.js', '--json', ...args], { env }).stdout.toString()) as { ok: boolean; error?: { code: string } };

  it('#225: a metadata-only set gives up on a silent stdin and applies the flag alone', async () => {
    for (const flags of [['--confirm'], ['--no-confirm'], ['-a', 'silentalias']]) {
      const key = `stdin.silent.${flags[0].replace(/^-+/, '')}`;
      expect(setFrom({ input: 'original\n' }, [key]).status).toBe(0);
      const r = await setWithOpenStdin([key, ...flags], { killAfterMs: 8000 });
      expect(r.killed, `${flags.join(' ')}: still waiting after 8s`).toBe(false);
      expect(r.status, flags.join(' ')).toBe(0);
      expect(r.stdout + r.stderr, flags.join(' ')).toContain(`No value arrived on stdin within ${WINDOW_MS}ms`);
      expect(stored(key), flags.join(' ')).toBe('original');
    }
    // The flags were applied: the confirm entry now refuses to run without --yes.
    expect(jsonGet('run', 'stdin.silent.confirm', '--global').error?.code).toBe('REQUIRES_CONFIRMATION');
    // …and the alias resolves to its entry (the result is keyed by the entry's key).
    const viaAlias = JSON.parse(spawnSync('bun', ['dist/index.js', '--json', 'get', 'silentalias'], { env }).stdout.toString()) as { result?: Record<string, string> };
    expect(viaAlias.result).toEqual({ 'stdin.silent.a': 'original' });
  });

  it('#225: in JSON mode the give-up is a warning in the envelope and the call succeeds', async () => {
    expect(setFrom({ input: 'original\n' }, ['stdin.silent.json']).status).toBe(0);
    const r = await setWithOpenStdin(['stdin.silent.json', '--confirm'], { killAfterMs: 8000, json: true });
    expect(r.killed).toBe(false);
    const envelope = JSON.parse(r.stdout) as { ok: boolean; warnings?: { message: string }[] };
    expect(envelope.ok).toBe(true);
    expect((envelope.warnings ?? []).some(w => w.message.includes('No value arrived on stdin'))).toBe(true);
  });

  it('#225: a value whose first byte beats the deadline is taken whole, however late the rest', async () => {
    const r = await setWithOpenStdin(['stdin.slow', '--confirm'], {
      killAfterMs: 8000,
      feed: [{ afterMs: 50, text: 'part one\n' }, { afterMs: WINDOW_MS * 3, text: 'part two\n' }],
      endAfterMs: WINDOW_MS * 3 + 100,
    });
    expect(r.killed).toBe(false);
    expect(r.status).toBe(0);
    expect(r.stdout + r.stderr).not.toContain('No value arrived');
    expect(stored('stdin.slow')).toBe('part one\npart two');
  });

  it('#225: a set that needs a value still waits for it', async () => {
    // No flag: there is nothing to apply without a value, so the deadline
    // does not apply. Killed by the timer well past the window.
    const r = await setWithOpenStdin(['stdin.needsvalue'], { killAfterMs: WINDOW_MS * 5 });
    expect(r.killed).toBe(true);
    expect(stored('stdin.needsvalue')).toBeUndefined();
  });
});
