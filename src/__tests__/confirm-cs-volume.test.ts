// #255 (review F2, N1): a flag listed on a filesystem that folds names must
// still gate once the stores are on one that does not.
//
// The global store holds `ops.start`, the project `opſ.start` (long s). On
// default APFS either name opens either file; on a case-sensitive volume, or
// on Linux, each opens only its own. Copied there, a flag listed under one of
// the two names gated nothing of the other: `run opſ.start` (the project's
// entry) or `run ops.start` (the global one, reached from the project) ran
// unasked. Every spelling that names the entry is listed now.
//
// The flags are set where the temp dir folds (default APFS), then the stores
// are copied onto a Case-sensitive APFS disk image, and `run` is asked there.
// macOS only (hdiutil); skipped where the temp dir does not fold, or where no
// image can be made.

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { assertDistHonorsDataDir } from './helpers/spawnGuard';

interface Envelope { ok: boolean; result?: Record<string, unknown>; error?: { code: string; message: string } }

const LONG = `op${String.fromCodePoint(0x17f)}.start`;   // opſ.start
const CS_SETUP_MS = 60_000;
const SLOW_TEST_MS = 30_000;

describe.skipIf(process.platform !== 'darwin')('flags set where names fold still gate on a case-sensitive volume (#255)', () => {
  const cli = path.resolve('dist/index.js');
  let imageRoot = '';
  let mount = '';
  let ready = false;
  let world = '';

  const rvrAt = (root: string, where: string, ...args: string[]) => {
    const e: Record<string, string | undefined> = { ...process.env, RVR_DATA_DIR: path.join(root, 'data'), RVR_AGENT_NAME: 'test' };
    delete e.RVR_SESSION;
    delete e.RVR_NO_PROJECT;
    delete e.RVR_PROJECT;
    delete e.RVR_OUTPUT;
    const r = spawnSync('bun', [cli, ...args], { cwd: path.join(root, where), env: e as NodeJS.ProcessEnv, input: '' });
    return { stdout: r.stdout.toString(), stderr: r.stderr.toString(), status: r.status };
  };
  const marker = (name: string) => path.join(world, `ran-${name}`);
  const flagsIn = (dir: string): string[] => {
    const file = path.join(dir, '_confirm.json');
    return fs.existsSync(file) ? Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')) as object).sort() : [];
  };

  beforeAll(() => {
    assertDistHonorsDataDir();
    imageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'reverie-csvol-'));
    mount = path.join(imageRoot, 'mnt');
    const image = path.join(imageRoot, 'cs.dmg');
    const made = spawnSync('hdiutil', ['create', '-size', '50m', '-fs', 'Case-sensitive APFS', '-volname', 'rvrcs', image]);
    if (made.status !== 0) return;
    fs.mkdirSync(mount);
    const attached = spawnSync('hdiutil', ['attach', image, '-nobrowse', '-mountpoint', mount]);
    if (attached.status !== 0) return;
    // The volume keeps the two apart, and the temp dir folds them.
    fs.writeFileSync(path.join(mount, 'ops.start.json'), '{}');
    const keepsApart = !fs.existsSync(path.join(mount, `${LONG}.json`)) && !fs.existsSync(path.join(mount, 'OPS.start.json'));
    fs.rmSync(path.join(mount, 'ops.start.json'));
    fs.writeFileSync(path.join(imageRoot, 'ops.start.json'), '{}');
    const folds = fs.existsSync(path.join(imageRoot, `${LONG}.json`));
    fs.rmSync(path.join(imageRoot, 'ops.start.json'));
    ready = keepsApart && folds;
  }, CS_SETUP_MS);

  afterAll(() => {
    if (mount && fs.existsSync(mount)) spawnSync('hdiutil', ['detach', mount, '-force']);
    if (imageRoot) fs.rmSync(imageRoot, { recursive: true, force: true });
  }, CS_SETUP_MS);

  beforeEach(() => {
    world = fs.mkdtempSync(path.join(imageRoot || os.tmpdir(), 'world-'));
    for (const d of ['p1', 'outside', 'data']) fs.mkdirSync(path.join(world, d));
  });
  afterEach(() => { fs.rmSync(world, { recursive: true, force: true }); });

  /**
   * On the folding temp volume: the global `ops.start` and the project's
   * `opſ.start`, then `flag` from the project. Then the project and the data
   * dir copied onto the case-sensitive volume, and both names run there from
   * the project. Neither may run unasked.
   */
  function flagThenRunWhereNothingFolds(flag: string[], label: string): { projectFlags: string[]; globalFlags: string[] } {
    expect(rvrAt(world, 'p1', 'init', '--no-scan', '--no-claude', '--no-agents').status).toBe(0);
    expect(rvrAt(world, 'outside', 'set', '-G', 'ops.start', `touch ${marker('global')}`).status).toBe(0);
    expect(rvrAt(world, 'p1', 'set', LONG, `touch ${marker('project')}`).status).toBe(0);
    expect(rvrAt(world, 'p1', ...flag).status).toBe(0);

    const copy = path.join(mount, label);
    fs.mkdirSync(copy);
    for (const d of ['p1', 'data']) fs.cpSync(path.join(world, d), path.join(copy, d), { recursive: true });
    fs.mkdirSync(path.join(copy, 'outside'));
    try {
      // Two entries there now: the project's `opſ.start`, and the global
      // `ops.start`, which the project reaches since it holds no such name.
      for (const name of [LONG, 'ops.start']) {
        const env = JSON.parse(rvrAt(copy, 'p1', '--json', 'run', name).stdout) as Envelope;
        expect(env.error?.code, `${label}: run ${name}`).toBe('REQUIRES_CONFIRMATION');
      }
      expect(fs.existsSync(marker('project')), label).toBe(false);
      expect(fs.existsSync(marker('global')), label).toBe(false);
      return { projectFlags: flagsIn(path.join(copy, 'p1', '.reverie')), globalFlags: flagsIn(path.join(copy, 'data', 'store')) };
    } finally {
      fs.rmSync(copy, { recursive: true, force: true });
    }
  }

  it('confirm set -G ops.start, the global store\'s name (F2)', () => {
    if (!ready) return;
    expect(flagThenRunWhereNothingFolds(['confirm', 'set', '-G', 'ops.start'], 'f2').globalFlags).toEqual(['ops.start', LONG]);
  }, SLOW_TEST_MS);

  it('confirm set -G opſ.start, the project\'s name (N1)', () => {
    if (!ready) return;
    expect(flagThenRunWhereNothingFolds(['confirm', 'set', '-G', LONG], 'n1').globalFlags).toEqual(['ops.start', LONG]);
  }, SLOW_TEST_MS);

  it('confirm set ops.start without -G: the project list (N1)', () => {
    if (!ready) return;
    expect(flagThenRunWhereNothingFolds(['confirm', 'set', 'ops.start'], 'nog').projectFlags).toEqual(['ops.start', LONG]);
  }, SLOW_TEST_MS);

  it('the flag-only set --confirm, the same', () => {
    if (!ready) return;
    expect(flagThenRunWhereNothingFolds(['set', LONG, '--confirm', '-G'], 'set').globalFlags).toEqual(['ops.start', LONG]);
  }, SLOW_TEST_MS);

  it('the volume was made: these tests ran', () => {
    // A machine that cannot make the image skips the checks above silently;
    // this says so in the output instead of passing for nothing.
    if (!ready) console.warn('confirm-cs-volume: no case-sensitive volume, checks skipped');
    expect(typeof ready).toBe('boolean');
  });
});
