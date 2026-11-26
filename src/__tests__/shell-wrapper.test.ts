/**
 * #281: the shell wrapper evaled a JSON envelope.
 *
 * `rvr config completions install` adds a shell function that runs
 * `rvr run … --source` and evals its stdout. With `--json` that stdout was the
 * envelope, whose warnings quote store file names, and a cloned repository
 * chooses those: one unparseable `.reverie/x$(touch PWN).json` ran its payload
 * on `rvr run <any key> --json`, `--dry` included. `--debug` lines reached the
 * eval the same way, in text mode.
 *
 * Each layer is tested on its own, under `zsh -f` and `bash --norc`:
 *   - the binary: `run --source` prints the command and nothing else, so a
 *     wrapper installed before the fix is safe with today's binary;
 *   - the wrapper: `--json`, RVR_OUTPUT=json and `--dry` never reach the eval,
 *     checked against a fake binary that prints a payload for `--source`.
 * Nothing here reads the user's shell profile; HOME is a temp dir.
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { generateShellWrapper } from '../completions';
import { assertDistHonorsDataDir } from './helpers/spawnGuard';

/** The wrapper as `config completions install` wrote it before #281, for `rvr`. */
const OLD_WRAPPER = `# Reverie shell wrapper (rvr) — eval "rvr run" in the current shell so cd/export/alias work
rvr() {
  local subcmd="" has_help=false
  for arg in "$@"; do
    if [[ "$arg" == "-h" || "$arg" == "--help" ]]; then
      has_help=true
    elif [[ "$arg" != -* && -z "$subcmd" ]]; then
      subcmd="$arg"
    fi
  done
  if [[ "$has_help" == false && ("$subcmd" == "run" || "$subcmd" == "r") ]]; then
    local __rvr_cmd __rvr_exit
    __rvr_cmd="$(command rvr "$@" --source)"
    __rvr_exit=$?
    [[ $__rvr_exit -ne 0 ]] && return $__rvr_exit
    [[ -n "$__rvr_cmd" ]] && eval "$__rvr_cmd"
  else
    command rvr "$@"
  fi
}
`;
const NEW_WRAPPER = generateShellWrapper('rvr');

const shellArgs = (sh: 'zsh' | 'bash', script: string): string[] =>
  sh === 'zsh' ? ['-f', '-c', script] : ['--norc', '--noprofile', '-c', script];
const SHELLS = (['zsh', 'bash'] as const).filter(sh => spawnSync(sh, shellArgs(sh, 'true')).status === 0);
const SLOW_TEST_MS = 30_000;

let root: string;
let project: string;
let binDir: string;
const marker = () => path.join(project, 'PWN');
const ranMarker = () => path.join(root, 'safe-ran');

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'reverie-wrapper-'));
  project = path.join(root, 'clone');
  binDir = path.join(root, 'bin');
  for (const d of ['data', 'home', 'bin', 'there', path.join('clone', '.reverie')]) fs.mkdirSync(path.join(root, d), { recursive: true });
  const store = path.join(project, '.reverie');
  fs.writeFileSync(path.join(store, 'safe.cmd.json'), JSON.stringify({ value: `touch '${ranMarker()}'` }));
  fs.writeFileSync(path.join(store, 'go.there.json'), JSON.stringify({ value: `cd '${path.join(root, 'there')}'` }));
  // What the repository ships: one store file that does not parse, named so
  // that its quoted name runs a command when a shell evaluates it.
  fs.writeFileSync(path.join(store, 'x$(touch PWN).json'), '{broken');
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => {
  const e: Record<string, string | undefined> = {
    ...process.env,
    PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
    HOME: path.join(root, 'home'),
    RVR_DATA_DIR: path.join(root, 'data'),
    ...extra,
  };
  for (const name of ['RVR_SESSION', 'RVR_NO_PROJECT', 'RVR_PROJECT', 'RVR_OUTPUT', 'DEBUG']) {
    if (!(name in extra)) delete e[name];
  }
  return e as NodeJS.ProcessEnv;
};

/** Run `line` in a fresh `sh` with only `wrapper` defined, in the clone. */
const inShell = (sh: 'zsh' | 'bash', wrapper: string, line: string) => {
  const r = spawnSync(sh, shellArgs(sh, `${wrapper}\n${line}`), { cwd: project, env: env(), input: '', timeout: 20000 });
  return { stdout: r.stdout.toString(), stderr: r.stderr.toString(), status: r.status };
};

describe('the binary: `run --source` prints the command and nothing else (#281)', () => {
  const cli = path.resolve('dist/index.js');
  const rvr = (args: string[], extra: Record<string, string> = {}) => {
    const r = spawnSync('bun', [cli, ...args], { cwd: project, env: env(extra), input: '', timeout: 15000 });
    return { stdout: r.stdout.toString(), stderr: r.stderr.toString(), status: r.status };
  };
  const command = () => `touch '${ranMarker()}'\n`;

  beforeAll(() => { assertDistHonorsDataDir(); });

  it('with --json: no envelope, the command alone; the warnings and a note go to stderr', () => {
    const r = rvr(['run', 'safe.cmd', '--json', '--source']);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(command());
    expect(r.stderr).toContain('JSON output (--json, RVR_OUTPUT=json) is off');
    expect(r.stderr).toContain('x$(touch PWN).json is not a valid store file');
    // JSON mode is off, not just kept off stdout: no envelope on either stream.
    expect(r.stderr).not.toContain('"reverie"');
  }, SLOW_TEST_MS);

  it('with --json before the verb, and with RVR_OUTPUT=json', () => {
    expect(rvr(['--json', 'run', 'safe.cmd', '--source']).stdout).toBe(command());
    expect(rvr(['run', 'safe.cmd', '--source'], { RVR_OUTPUT: 'json' }).stdout).toBe(command());
  }, SLOW_TEST_MS);

  it('with --dry --json: nothing at all', () => {
    const r = rvr(['run', 'safe.cmd', '--dry', '--json', '--source']);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  }, SLOW_TEST_MS);

  it('with --debug: the debug lines, which quote the file name, go to stderr', () => {
    const r = rvr(['run', 'safe.cmd', '--source', '--debug']);
    expect(r.stdout).toBe(command());
    expect(r.stderr).toContain('[DEBUG]');
  }, SLOW_TEST_MS);

  it('the command still counts as the response in telemetry', () => {
    expect(rvr(['run', 'safe.cmd', '--source']).stdout).toBe(command());
    const rows = fs.readFileSync(path.join(root, 'data', 'telemetry.jsonl'), 'utf8').trim().split('\n')
      .map(l => JSON.parse(l) as { tool?: string; responseSize?: number });
    expect(rows.reverse().find(r => r.tool === 'reverie_run')?.responseSize).toBe(Buffer.byteLength(command()));
  }, SLOW_TEST_MS);

  it('get --source --json is untouched: its --source is another option', () => {
    const r = rvr(['get', 'safe.cmd', '--source', '--json']);
    const envelope = JSON.parse(r.stdout) as { ok: boolean };
    expect(envelope.ok).toBe(true);
  }, SLOW_TEST_MS);
});

describe.each(SHELLS)('under %s', (sh) => {
  describe('the real binary on PATH', () => {
    beforeAll(() => { assertDistHonorsDataDir(); });
    beforeEach(() => {
      const shim = path.join(binDir, 'rvr');
      fs.writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${path.resolve('dist/index.js')}" "$@"\n`);
      fs.chmodSync(shim, 0o755);
    });

    describe('a wrapper installed before the fix', () => {
      it('`rvr run <key> --json`: the payload does not run', () => {
        const r = inShell(sh, OLD_WRAPPER, 'rvr run safe.cmd --json');
        expect(fs.existsSync(marker())).toBe(false);
        expect(r.stdout).not.toContain('"reverie"');
        // The binary printed the command instead, and the old wrapper ran it.
        expect(fs.existsSync(ranMarker())).toBe(true);
        expect(r.stderr).toContain('JSON output (--json, RVR_OUTPUT=json) is off');
      }, SLOW_TEST_MS);

      it('`rvr run <key> --dry --json`: nothing runs', () => {
        inShell(sh, OLD_WRAPPER, 'rvr run safe.cmd --dry --json');
        expect(fs.existsSync(marker())).toBe(false);
        expect(fs.existsSync(ranMarker())).toBe(false);
      }, SLOW_TEST_MS);

      it('RVR_OUTPUT=json, and --debug: the payload does not run', () => {
        inShell(sh, OLD_WRAPPER, 'export RVR_OUTPUT=json; rvr run safe.cmd');
        inShell(sh, OLD_WRAPPER, 'rvr run safe.cmd --debug');
        expect(fs.existsSync(marker())).toBe(false);
      }, SLOW_TEST_MS);
    });

    describe('the wrapper installed now', () => {
      it('`rvr run <key> --json`: the envelope is printed, not evaluated', () => {
        const r = inShell(sh, NEW_WRAPPER, 'rvr run safe.cmd --json');
        expect(r.status).toBe(0);
        const envelope = JSON.parse(r.stdout) as { ok: boolean; warnings?: { code: string; message: string }[] };
        expect(envelope.ok).toBe(true);
        expect(envelope.warnings?.some(w => w.code === 'STORE_UNREADABLE' && w.message.includes('x$(touch PWN).json'))).toBe(true);
        expect(fs.existsSync(marker())).toBe(false);
      }, SLOW_TEST_MS);

      it('RVR_OUTPUT=json and --json before the verb: the envelope too', () => {
        for (const line of ['export RVR_OUTPUT=json; rvr run safe.cmd', 'rvr --json run safe.cmd']) {
          const r = inShell(sh, NEW_WRAPPER, line);
          expect((JSON.parse(r.stdout) as { ok: boolean }).ok).toBe(true);
        }
        expect(fs.existsSync(marker())).toBe(false);
      }, SLOW_TEST_MS);

      it('`rvr run <key> --dry`: the preview is printed and nothing runs', () => {
        const r = inShell(sh, NEW_WRAPPER, 'rvr run safe.cmd --dry');
        expect(r.status).toBe(0);
        expect(r.stdout).toContain(`touch '${ranMarker()}'`);
        expect(fs.existsSync(ranMarker())).toBe(false);
        expect(fs.existsSync(marker())).toBe(false);
      }, SLOW_TEST_MS);

      it('`rvr run <key>` and `rvr r <key>` still run in this shell; --debug runs no payload', () => {
        const r = inShell(sh, NEW_WRAPPER, 'rvr run go.there && pwd');
        expect(r.status).toBe(0);
        expect(r.stdout.trim().split('\n').pop()).toMatch(/\/there$/);
        inShell(sh, NEW_WRAPPER, 'rvr r safe.cmd --debug');
        expect(fs.existsSync(ranMarker())).toBe(true);
        expect(fs.existsSync(marker())).toBe(false);
      }, SLOW_TEST_MS);
    });
  });

  describe('the wrapper alone, against a binary that prints a payload for --source', () => {
    const argLog = () => path.join(root, 'args.log');
    const hostile = () => path.join(project, 'HOSTILE');
    beforeEach(() => {
      const fake = path.join(binDir, 'rvr');
      fs.writeFileSync(fake, [
        '#!/bin/sh',
        `printf '%s\\n' "$*" >> '${argLog()}'`,
        'for a in "$@"; do [ "$a" = "--source" ] && { echo "touch HOSTILE"; exit 0; }; done',
        `echo '{"reverie":"1","ok":true}'`,
        '',
      ].join('\n'));
      fs.chmodSync(fake, 0o755);
    });
    const sourcePassed = () => fs.readFileSync(argLog(), 'utf8').includes('--source');

    it('control: a plain run is evaluated', () => {
      inShell(sh, NEW_WRAPPER, 'rvr run k');
      expect(fs.existsSync(hostile())).toBe(true);
    });

    it('control: the old wrapper evaluates a --json run', () => {
      inShell(sh, OLD_WRAPPER, 'rvr run k --json');
      expect(fs.existsSync(hostile())).toBe(true);
    });

    it.each([
      ['rvr run k --json'],
      ['rvr run k --json=true'],
      ['rvr --json r k'],
      ['rvr run k --dry'],
      ['export RVR_OUTPUT=json; rvr run k'],
      ['RVR_OUTPUT=json rvr run k'],
    ])('`%s` goes straight to the binary', (line) => {
      const r = inShell(sh, NEW_WRAPPER, line);
      expect(fs.existsSync(hostile())).toBe(false);
      expect(sourcePassed()).toBe(false);
      expect(r.stdout).toContain('"ok":true');
    });
  });
});
