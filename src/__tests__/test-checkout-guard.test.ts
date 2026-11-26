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
