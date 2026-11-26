/**
 * #274: the test suite must never write the checkout's own `.reverie/`.
 *
 * In-process tests run from the checkout, so project resolution finds its
 * committed store, and a store mock missing an export let a full run write
 * `a.B` and `commands.new` into it (2026-11-26). The preload records the
 * checkout in RVR_TEST_CHECKOUT, and under RVR_TEST=1 the store refuses every
 * write inside it: entry, sidecar, epoch and lock.
 *
 * The refusals below are aimed at a stand-in checkout in a temp directory,
 * so that with the guard taken out the writes land there, not in the real one.
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { TEST_CHECKOUT_ENV, createDirectoryStore, testCheckoutRefusal } from '../utils/directoryStore';
import { assertDistHonorsDataDir } from './helpers/spawnGuard';

const realCheckout = path.resolve(import.meta.dir, '..', '..');

describe('the preload records the checkout (#274)', () => {
  it('is the checkout this suite runs from', () => {
    expect(process.env.RVR_TEST).toBe('1');
    expect(process.env[TEST_CHECKOUT_ENV]).toBe(realCheckout);
    expect(fs.existsSync(path.join(realCheckout, 'src', '__tests__', '_setup.ts'))).toBe(true);
  });

  it("refuses the checkout's own store, its lock beside it, and anything under the checkout — not a temp dir", () => {
    expect(testCheckoutRefusal(path.join(realCheckout, '.reverie'))).toContain('inside the checkout under test');
    expect(testCheckoutRefusal(path.join(realCheckout, 'src', 'deep', '.reverie'))).toBeDefined();
    expect(testCheckoutRefusal(realCheckout)).toBeDefined();
    expect(testCheckoutRefusal(path.join(os.tmpdir(), 'reverie-guard-free', '.reverie'))).toBeUndefined();
    expect(testCheckoutRefusal(`${realCheckout}-sibling/.reverie`)).toBeUndefined();
  });
});

describe('a store write aimed at the checkout is refused (#274)', () => {
  let checkout: string;
  let storeDir: string;
  const saved = process.env[TEST_CHECKOUT_ENV];
  const makeStore = () => createDirectoryStore(() => storeDir, () => { fs.mkdirSync(storeDir, { recursive: true }); });

  beforeEach(() => {
    checkout = fs.mkdtempSync(path.join(os.tmpdir(), 'reverie-guard-checkout-'));
    storeDir = path.join(checkout, '.reverie');
    fs.mkdirSync(storeDir);
    fs.writeFileSync(path.join(storeDir, 'arch.x.json'), JSON.stringify({ value: 'committed' }));
    process.env[TEST_CHECKOUT_ENV] = checkout;
  });
  afterEach(() => {
    process.env[TEST_CHECKOUT_ENV] = saved;
    fs.rmSync(checkout, { recursive: true, force: true });
  });

  const untouched = () => {
    expect(fs.readdirSync(storeDir).sort()).toEqual(['arch.x.json']);
    expect(fs.existsSync(`${storeDir}.lock`)).toBe(false);
  };

  it('setOne, update, save and the lock a read takes', () => {
    const store = makeStore();
    expect(() => store.setOne('a.B', 'v', Date.now())).toThrow(/inside the checkout under test/);
    expect(() => store.update(current => ({ ...current, confirm: { 'commands.new': true } }))).toThrow(/inside the checkout under test/);
    expect(() => store.save({ entries: {}, aliases: {}, confirm: {} })).toThrow(/inside the checkout under test/);
    expect(() => store.inspect(() => 0)).toThrow(/inside the checkout under test/);
    untouched();
    // Reading without the lock is not a write.
    expect(store.load().entries).toEqual({ arch: { x: 'committed' } });
  });

  it('only under RVR_TEST=1', () => {
    const was = process.env.RVR_TEST;
    delete process.env.RVR_TEST;
    try {
      makeStore().setOne('a.b', 'v', Date.now());
    } finally {
      process.env.RVR_TEST = was;
    }
    expect(fs.existsSync(path.join(storeDir, 'a.b.json'))).toBe(true);
  });

  it('a spawned rvr inherits it: a project write from the checkout is refused', () => {
    assertDistHonorsDataDir();
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reverie-guard-data-'));
    try {
      // The project is found from the working directory, as in-process tests find the checkout's.
      const env: Record<string, string | undefined> = { ...process.env, RVR_DATA_DIR: dataDir };
      delete env.RVR_NO_PROJECT;
      delete env.RVR_PROJECT;
      const r = spawnSync('bun', [path.join(realCheckout, 'dist', 'index.js'), 'set', 'a.B', 'v'], {
        cwd: checkout,
        env,
        input: '',
        timeout: 15000,
      });
      expect(r.status).toBe(1);
      expect(r.stderr.toString()).toContain('inside the checkout under test');
      untouched();
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  }, 30000);
});

// Review of #274: writes beside the store that are not the store's own.
// `init --remove` deleted the checkout's `.reverie/`, `init` created one, and
// a replace import or a reset wrote `.reverie.backups/` before the store
// refused. Aimed at a stand-in checkout, as above.
describe('init and the pre-write backups refuse the checkout too (#274)', () => {
  let checkout: string;
  let storeDir: string;
  let dataDir: string;
  const saved = process.env[TEST_CHECKOUT_ENV];

  beforeAll(() => assertDistHonorsDataDir());
  beforeEach(() => {
    checkout = fs.mkdtempSync(path.join(os.tmpdir(), 'reverie-guard-checkout-'));
    storeDir = path.join(checkout, '.reverie');
    fs.mkdirSync(storeDir);
    fs.writeFileSync(path.join(storeDir, 'arch.x.json'), JSON.stringify({ value: 'committed' }));
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reverie-guard-data-'));
    process.env[TEST_CHECKOUT_ENV] = checkout;
  });
  afterEach(() => {
    process.env[TEST_CHECKOUT_ENV] = saved;
    fs.rmSync(checkout, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  /** rvr from `cwd`, finding its project from there; the child inherits the stand-in checkout. */
  const rvrIn = (cwd: string, ...args: string[]) => {
    const env: Record<string, string | undefined> = { ...process.env, RVR_DATA_DIR: dataDir };
    delete env.RVR_NO_PROJECT;
    delete env.RVR_PROJECT;
    const r = spawnSync('bun', [path.join(realCheckout, 'dist', 'index.js'), ...args], { cwd, env, input: '', timeout: 15000 });
    return { status: r.status, stderr: r.stderr.toString(), stdout: r.stdout.toString() };
  };
  const untouched = () => {
    expect(fs.readdirSync(storeDir).sort()).toEqual(['arch.x.json']);
    expect(fs.readdirSync(checkout).sort()).toEqual(['.reverie']);
  };

  it('init --remove keeps the store', () => {
    const r = rvrIn(checkout, 'init', '--remove');
    expect(r.status).not.toBe(0);
    expect(r.stderr + r.stdout).toContain('inside the checkout under test');
    untouched();
  }, 30000);

  it('init creates no store', () => {
    const sub = path.join(checkout, 'pkg');
    fs.mkdirSync(sub);
    const r = rvrIn(sub, 'init', '--no-scan', '--no-claude', '--no-agents');
    expect(r.status).not.toBe(0);
    expect(fs.readdirSync(sub)).toEqual([]);
  }, 30000);

  it('a replace import and a reset make no backup', () => {
    const file = path.join(dataDir, 'imp-all.json');
    fs.writeFileSync(file, JSON.stringify({ entries: { a: 'b' }, aliases: {}, confirm: {} }));
    const imported = rvrIn(checkout, 'data', 'import', 'all', file, '-f');
    expect(imported.status).not.toBe(0);
    expect(imported.stderr).toContain('inside the checkout under test');
    untouched();
    const reset = rvrIn(checkout, 'data', 'reset', 'all', '-f');
    expect(reset.status).not.toBe(0);
    untouched();
  }, 30000);
});
