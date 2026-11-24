// End-to-end integration tests for the #117 WS1 structured-output envelope
// and WS2 manifest. Spawns the built dist/index.js exactly like the other
// integration suites (assumes `bun run build` has run — CI builds first).

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { assertDistHonorsDataDir } from './helpers/spawnGuard';

describe('CLI JSON envelope (#117)', () => {
  const testDir = path.join(os.tmpdir(), 'reverie-json-' + Math.random().toString(36).slice(2));
  const baseEnv = { ...process.env, RVR_DATA_DIR: testDir, RVR_NO_PROJECT: '1' };

  // Returns { stdout, status }. Writes auto-target the global store (#99): we
  // append `--global` after the verb token (skipping a leading `--json`), so
  // it lands on the leaf command's -G option rather than a command group.
  const run = (args: string, env: Record<string, string> = {}) => {
    const verb = args.replace(/^--json\s+/, '').split(/\s+/)[0];
    if (/^(set|rm|remove|copy|cp|rename|run)$/.test(verb)) {
      args = args.replace(new RegExp(`(\\b${verb}\\b)`), '$1 --global');
    } else if (verb === 'confirm' || verb === 'alias') {
      // group commands: -G lives on the leaf — append at the end.
      args = `${args} --global`;
    }
    try {
      const stdout = execSync(`bun dist/index.js ${args}`, {
        env: { ...baseEnv, ...env }, stdio: ['pipe', 'pipe', 'pipe'],
      }).toString();
      return { stdout, status: 0 };
    } catch (e: unknown) {
      const err = e as { stdout?: Buffer; status?: number };
      return { stdout: (err.stdout ?? Buffer.from('')).toString(), status: err.status ?? 1 };
    }
  };

  const parse = (s: string) => JSON.parse(s);

  beforeAll(() => {
    assertDistHonorsDataDir();
    fs.mkdirSync(testDir, { recursive: true });
  });
  afterAll(() => { fs.rmSync(testDir, { recursive: true, force: true }); });

  it('wraps a successful read in the versioned envelope', () => {
    run('set env.k "hello"');
    const env = parse(run('--json get env.k').stdout);
    expect(env.reverie).toBe('1');
    expect(env.ok).toBe(true);
    expect(env.command).toBe('get');
    expect(env.result).toEqual({ 'env.k': 'hello' });
  });

  it('RVR_OUTPUT=json enables JSON mode session-wide', () => {
    run('set env.k2 "v2"');
    const env = parse(run('get env.k2', { RVR_OUTPUT: 'json' }).stdout);
    expect(env.ok).toBe(true);
    expect(env.result).toEqual({ 'env.k2': 'v2' });
  });

  it('emits a structured error with non-zero exit for a missing key', () => {
    const r = run('--json get env.does.not.exist');
    expect(r.status).not.toBe(0);
    const env = parse(r.stdout);
    expect(env.ok).toBe(false);
    expect(env.error.code).toBe('NOT_FOUND');
  });

  it('emits exactly one envelope on stdout for a mutation', () => {
    const out = run('--json set env.m "x"').stdout.trim();
    expect(out.split('\n').filter(l => l === '}').length).toBe(1); // one closing brace at col 0
    const env = parse(out);
    expect(env.ok).toBe(true);
    expect(env.command).toBe('set');
    expect(env.result.key).toBe('env.m');
  });

  it('run --dry returns the resolved command preview', () => {
    run('set env.cmd "echo hi"');
    const env = parse(run('--json run env.cmd --dry').stdout);
    expect(env.ok).toBe(true);
    expect(env.result.command).toBe('echo hi');
  });

  it('run executes and captures stdout/exitCode', () => {
    run('set env.cmd2 "echo captured"');
    const env = parse(run('--json run env.cmd2 --yes').stdout);
    expect(env.ok).toBe(true);
    expect(env.result.exitCode).toBe(0);
    expect(env.result.stdout).toContain('captured');
  });

  it('run on a confirm entry without --yes refuses with E_REQUIRES_CONFIRMATION', () => {
    run('set env.danger "echo boom"');
    run('confirm set env.danger');
    const r = run('--json run env.danger');
    expect(r.status).not.toBe(0);
    const env = parse(r.stdout);
    expect(env.ok).toBe(false);
    expect(env.error.code).toBe('REQUIRES_CONFIRMATION');
    expect(env.error.preview).toBe('echo boom');
    expect(env.result.command).toBe('echo boom');
  });

  it('manifest --json describes the command tree and MCP map', () => {
    const env = parse(run('--json manifest').stdout);
    expect(env.ok).toBe(true);
    expect(env.command).toBe('manifest');
    expect(env.result.envelope.version).toBe('1');
    expect(Object.keys(env.result.mcpToolMap)).toHaveLength(19);
    expect(env.result.commands.some((c: { name: string }) => c.name === 'get')).toBe(true);
  });

  // ── Advertised error codes are actually produced (review #1) ──────────

  it('run on an encrypted entry without --decrypt yields ENCRYPTED_NO_PASSWORD', () => {
    run('set env.sec "secret cmd" --encrypt', { RVR_PASSWORD: 'pw' });
    const r = run('--json run env.sec');
    expect(r.status).not.toBe(0);
    const env = parse(r.stdout);
    expect(env.ok).toBe(false);
    expect(env.error.code).toBe('ENCRYPTED_NO_PASSWORD');
  });

  it('run surfaces a spawn failure as COMMAND_FAILED (not a silent ok:true)', () => {
    run('set env.cmd3 "echo nope"');
    const r = run('--json run env.cmd3 --yes', { SHELL: '/nonexistent/shell-xyz' });
    expect(r.status).not.toBe(0);
    const env = parse(r.stdout);
    expect(env.ok).toBe(false);
    expect(env.error.code).toBe('COMMAND_FAILED');
  });

  it('every frozen error code is reachable — manifest advertises only real codes', () => {
    // Guards against doc/code drift: the prose lists used to advertise codes
    // (DECRYPT_FAILED, ENCRYPTED_NO_PASSWORD, INPUT_REQUIRED) the CLI never
    // emitted. The instruction blobs now interpolate this same frozen set.
    const env = parse(run('--json manifest').stdout);
    const codes: string[] = env.result.envelope.errorCodes;
    for (const c of ['ENCRYPTED_NO_PASSWORD', 'DECRYPT_FAILED', 'INPUT_REQUIRED', 'COMMAND_FAILED']) {
      expect(codes).toContain(c);
    }
  });

  // ── config get/set emit a populated envelope (review #2) ──────────────

  it('config set --json returns the changed key in result', () => {
    const env = parse(run('--json config set theme dark').stdout);
    expect(env.ok).toBe(true);
    expect(env.command).toBe('config set');
    expect(env.result.key).toBe('theme');
    expect(env.result.value).toBe('dark');
  });

  it('config get --json returns the value instead of dropping it', () => {
    run('config set theme light');
    const env = parse(run('--json config get theme').stdout);
    expect(env.ok).toBe(true);
    expect(env.command).toBe('config get');
    expect(env.result.theme).toBe('light');
  });

  // ── audit --follow --json streams NDJSON rows (#135) ──────────────────
  // Replaced the pre-#135 refusal test: watch mode is now the supported
  // machine surface for watcher agents — raw rows, no envelope.

  it('audit --follow --json streams NDJSON rows for new writes (#135)', async () => {
    const { spawn } = await import('child_process');
    // --include-test: the harness sets RVR_TEST (#130), so the probe row is
    // test-tagged and the stream's default exclusion would (correctly) hide it.
    const proc = spawn('bun', ['dist/index.js', '--json', 'audit', '--follow', '--include-test'], { env: baseEnv });
    let out = '';
    proc.stdout.on('data', (d: Buffer) => { out += d.toString(); });
    try {
      // Let fs.watchFile arm (250ms poll interval), then produce a write.
      await new Promise(r => setTimeout(r, 600));
      run('set stream.probe "val"');
      const deadline = Date.now() + 5000;
      while (!out.includes('stream.probe') && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 100));
      }
    } finally {
      proc.kill('SIGINT');
    }
    const line = out.split('\n').find(l => l.includes('stream.probe'));
    expect(line).toBeDefined();
    const row = JSON.parse(line!);
    expect(row.tool).toBe('reverie_set');
    expect(row.key).toBe('stream.probe');
    // Raw row, not an envelope
    expect(row.reverie).toBeUndefined();
  }, 15000);

  // ── #119 WS3: RVR_SESSION-bridged write-amp guard ─────────────────────

  it('3rd same-key set sharing RVR_SESSION emits a WRITE_AMP warning in the envelope', () => {
    const session = { RVR_SESSION: 'ws3-amp-test' };
    const first = parse(run('--json set ws3.k "v1"', session).stdout);
    expect(first.warnings ?? []).toHaveLength(0);
    parse(run('--json set ws3.k "v2"', session).stdout);
    const third = parse(run('--json set ws3.k "v3"', session).stdout);
    expect(third.ok).toBe(true);
    const amp = (third.warnings as { code: string; count?: number }[]).find(w => w.code === 'WRITE_AMP');
    expect(amp).toBeDefined();
    expect(amp!.count).toBe(3);
  });

  it('same three sets without RVR_SESSION stay warning-free (per-process sessions)', () => {
    parse(run('--json set ws3.solo "v1"').stdout);
    parse(run('--json set ws3.solo "v2"').stdout);
    const third = parse(run('--json set ws3.solo "v3"').stdout);
    expect(third.ok).toBe(true);
    expect(((third.warnings ?? []) as { code: string }[]).filter(w => w.code === 'WRITE_AMP')).toHaveLength(0);
  });

  // ── #207: harness session fallback ──────────────────────────────────
  // _setup.ts scrubs the harness session variable, so the suite's own
  // spawns are per-process whether or not it runs inside Claude Code; these
  // set the harness env explicitly.

  const HARNESS_ID = '0b7c2f0e-1111-4222-8333-444455556666';
  const telemetryRows = () => fs.readFileSync(path.join(testDir, 'telemetry.jsonl'), 'utf8').trim().split('\n')
    .map(l => JSON.parse(l) as { tool: string; key?: string; ns?: string; session: string; sessionDetected?: boolean });

  it('adopts the Claude Code session id when RVR_SESSION is unset: the guard trips and rows are tagged', () => {
    const harness = { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: HARNESS_ID };
    const first = parse(run('--json set h207.k "v1"', harness).stdout);
    expect(first.warnings ?? []).toHaveLength(0);
    parse(run('--json set h207.k "v2"', harness).stdout);
    const third = parse(run('--json set h207.k "v3"', harness).stdout);
    expect(third.ok).toBe(true);
    const amp = (third.warnings as { code: string; count?: number }[]).find(w => w.code === 'WRITE_AMP');
    expect(amp?.count).toBe(3);

    const rows = telemetryRows().filter(r => r.session === HARNESS_ID);
    expect(rows).toHaveLength(3);
    expect(rows.every(r => r.sessionDetected === true)).toBe(true);
    expect(fs.existsSync(path.join(testDir, 'sessions', `${HARNESS_ID}.json`))).toBe(true);
  });

  it('explicit RVR_SESSION wins over the harness id and is not tagged detected', () => {
    const env = { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: HARNESS_ID, RVR_SESSION: 'h207-explicit' };
    parse(run('--json set h207.explicit "v"', env).stdout);
    const rows = telemetryRows().filter(r => r.session === 'h207-explicit');
    expect(rows).toHaveLength(1);
    expect(rows[0].sessionDetected).toBeUndefined();
  });

  // ── The handoff is exempt from the write-amp guard ───────────────────
  // context.next_session is rewritten as a session progresses, by design.
  // Once sessions were detected (#207) the convention tripped the guard on
  // every third rewrite, with advice ("has the entry stabilized?") that does
  // not apply to it.

  const ampWarnings = (stdout: string) =>
    ((parse(stdout).warnings ?? []) as { code: string }[]).filter(w => w.code === 'WRITE_AMP').length;

  it('the handoff never trips WRITE_AMP, under an explicit or a detected session', () => {
    for (const env of [
      { RVR_SESSION: 'handoff-exempt' } as Record<string, string>,
      { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: '7a1d9c3e-aaaa-4bbb-8ccc-ddddeeeeffff' } as Record<string, string>,
    ]) {
      for (let i = 1; i <= 4; i++) {
        const r = run(`--json set context.next_session "note ${i}"`, env);
        expect(parse(r.stdout).ok).toBe(true);
        expect(ampWarnings(r.stdout)).toBe(0);
      }
      // Same session, an ordinary key: the guard is still live.
      run('--json set handoff.control "v1"', env);
      run('--json set handoff.control "v2"', env);
      expect(ampWarnings(run('--json set handoff.control "v3"', env).stdout)).toBe(1);
    }
  });

  it('a handoff written through an alias is exempt too (the guard sees the resolved key)', () => {
    const env = { RVR_SESSION: 'handoff-alias' };
    run('set context.next_session "seed"', env);
    run('alias set ho context.next_session', env);
    for (let i = 1; i <= 3; i++) {
      const r = run(`--json set ho "aliased note ${i}"`, env);
      expect(parse(r.stdout).ok).toBe(true);
      expect(ampWarnings(r.stdout)).toBe(0);
    }
    expect(parse(run('--json get context.next_session').stdout).result).toEqual({ 'context.next_session': 'aliased note 3' });
  });

  // ── The guard counts per store ───────────────────────────────────────
  // An entry is a key in one store. `run` pins every write to the global
  // store, so these spawn inside real project directories instead: no
  // RVR_NO_PROJECT, no --global. Throws on a non-zero exit.

  const runIn = (cwd: string, args: string, env: Record<string, string>) => {
    const projectEnv: Record<string, string | undefined> = { ...baseEnv, ...env };
    delete projectEnv.RVR_NO_PROJECT;
    return execSync(`bun ${JSON.stringify(path.resolve('dist/index.js'))} ${args}`, {
      cwd, env: projectEnv, stdio: ['pipe', 'pipe', 'pipe'],
    }).toString();
  };

  it('the same key in two projects and the global store is three entries, each with its own count', () => {
    const env = { RVR_SESSION: 'per-store' };
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reverie-json-stores-'));
    try {
      const [projA, projB] = ['a', 'b'].map((name) => {
        const dir = path.join(root, name);
        fs.mkdirSync(dir);
        runIn(dir, 'init', env);
        expect(fs.existsSync(path.join(dir, '.reverie'))).toBe(true);
        return dir;
      });
      expect(ampWarnings(runIn(projA, '--json set stores.k "a1"', env))).toBe(0);
      expect(ampWarnings(runIn(projA, '--json set stores.k "a2"', env))).toBe(0);
      // First write of the key in a second project, then in the global
      // store: on the key name alone each was "written 3 times".
      expect(ampWarnings(runIn(projB, '--json set stores.k "b1"', env))).toBe(0);
      expect(ampWarnings(runIn(projB, '--json set --global stores.k "g1"', env))).toBe(0);
      // The first project's own third write is the one that trips.
      expect(ampWarnings(runIn(projA, '--json set stores.k "a3"', env))).toBe(1);
      // Each landed where it was sent.
      expect(parse(runIn(projA, '--json get stores.k', env)).result).toEqual({ 'stores.k': 'a3' });
      expect(parse(runIn(projB, '--json get stores.k', env)).result).toEqual({ 'stores.k': 'b1' });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 15000);

  // ── The guard counts only writes that stored a value ─────────────────
  // `set <key> --confirm`, `--no-confirm` and `-a <alias>` update metadata;
  // `edit` closed without changes writes nothing. Each used to take a slot
  // in the window, so an entry written once could warn.

  const ampCount = (stdout: string) =>
    ((parse(stdout).warnings ?? []) as { code: string; count?: number }[]).find(w => w.code === 'WRITE_AMP')?.count;

  it('a set that stores no value does not count as a write', () => {
    const env = { RVR_SESSION: 'meta-only' };
    run('--json set meta.k "v1"', env);
    for (const flags of ['--confirm', '--no-confirm', '-a metak', '--confirm', '--no-confirm']) {
      const r = run(`--json set meta.k ${flags}`, env);
      expect(parse(r.stdout).ok).toBe(true);
      expect(ampWarnings(r.stdout)).toBe(0);
    }
    // One value write so far: the second is quiet and the third trips, at 3.
    expect(ampWarnings(run('--json set meta.k "v2"', env).stdout)).toBe(0);
    expect(ampCount(run('--json set meta.k "v3"', env).stdout)).toBe(3);
  }, 15000);

  it('edit counts only when it saves a change', () => {
    const env = { RVR_SESSION: 'edit-count' };
    // $VISUAL wins over $EDITOR, so both are set: the suite must not open
    // whatever editor the developer's shell names.
    const unchanged = { ...env, VISUAL: 'true', EDITOR: 'true' };
    const script = path.join(testDir, 'append-editor.sh');
    fs.writeFileSync(script, '#!/bin/sh\nprintf x >> "$1"\n', { mode: 0o755 });
    const appends = { ...env, VISUAL: script, EDITOR: script };

    run('--json set edit.k "v1"', env);
    for (let i = 0; i < 3; i++) {
      const r = run('--json edit --global edit.k', unchanged);
      expect(r.status).toBe(0);
      expect(ampWarnings(r.stdout)).toBe(0);
    }
    // A saved change is a write: with the set above, the second trips at 3.
    expect(ampWarnings(run('--json edit --global edit.k', appends).stdout)).toBe(0);
    expect(ampCount(run('--json edit --global edit.k', appends).stdout)).toBe(3);
    expect(parse(run('--json get edit.k').stdout).result).toEqual({ 'edit.k': 'v1xx' });
  }, 15000);

  // ── #120 guard: no result-less ok envelopes, no stdout pollution ───────
  // Every successful JSON-mode command must carry a `result` (an ok envelope
  // with no result means the handler's output was silently dropped — the
  // config get/set bug class), and stdout must be exactly one parseable JSON
  // document (pollution means a console.log escaped the sink — the
  // config examples bug class). parse() throws on polluted stdout.

  it('every successful command emits an envelope with a result', () => {
    const commands = [
      'set guard.k "v"',
      'get guard.k',
      'find guard',
      'context',
      'context --size-only',
      'alias set gk guard.k',
      'alias list',
      'confirm set guard.k',
      'confirm remove guard.k',
      // value-less set variants: confirm-only updates
      'set guard.k --confirm',
      'set guard.k --no-confirm',
      'copy guard.k guard.k2',
      'rename guard.k2 guard.k3',
      'alias remove gk',
      // value-less set variant: alias-only update (after `alias remove gk` —
      // an entry holds one alias, so setting it earlier would replace gk)
      'set guard.k -a gkalias',
      'config set theme dark',
      'config get theme',
      // -o keeps the export artifact in the test dir instead of repo cwd
      `data export entries -o ${path.join(testDir, 'guard-export.json')}`,
      'stale',
      'lint',
      'manifest',
      'stats',
    ];
    for (const cmd of commands) {
      const r = run(`--json ${cmd}`);
      const env = parse(r.stdout);
      expect(env.reverie, `${cmd}: not an envelope`).toBe('1');
      expect(env.ok, `${cmd}: failed — ${JSON.stringify(env.error)}`).toBe(true);
      expect(env.result !== undefined, `${cmd}: ok envelope without result`).toBe(true);
    }
  });
});
