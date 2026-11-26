import fs from 'fs';
import path from 'path';
import os from 'os';
import { withFileLock, LockTimeoutError, STORE_LOCK_WAIT_MS } from '../utils/fileLock';

let tmpDir: string;
let testFile: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-lock-'));
  testFile = path.join(tmpDir, 'target.json');
  fs.writeFileSync(testFile, '{}');
});

afterEach(() => {
  // Clean up lock files too
  const lockPath = testFile + '.lock';
  try { fs.unlinkSync(lockPath); } catch { /* may not exist */ }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('withFileLock', () => {
  it('executes the function and returns its result', () => {
    const result = withFileLock(testFile, () => 42);
    expect(result).toBe(42);
  });

  it('removes the lock file after successful execution', () => {
    withFileLock(testFile, () => {});
    expect(fs.existsSync(testFile + '.lock')).toBe(false);
  });

  it('removes the lock file even when the function throws', () => {
    expect(() => withFileLock(testFile, () => { throw new Error('boom'); })).toThrow('boom');
    expect(fs.existsSync(testFile + '.lock')).toBe(false);
  });

  it('blocks when lock is held, retries, and succeeds after lock is released', () => {
    // Manually create a stale lock (mtime > 10s ago)
    const lockPath = testFile + '.lock';
    fs.writeFileSync(lockPath, '99999');
    // Set mtime to 20 seconds ago (stale)
    const past = new Date(Date.now() - 20000);
    fs.utimesSync(lockPath, past, past);

    // Should succeed because the stale lock gets broken
    const result = withFileLock(testFile, () => 'ok');
    expect(result).toBe('ok');
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('throws when lock acquisition fails (fail-closed default)', () => {
    // Create a non-stale lock (mtime = now) to force all retries to fail
    const lockPath = testFile + '.lock';
    fs.writeFileSync(lockPath, String(process.pid));
    // Keep mtime fresh so it won't be considered stale

    // Without RVR_DISABLE_LOCKING set, withFileLock fails closed
    const previousEnv = process.env.RVR_DISABLE_LOCKING;
    delete process.env.RVR_DISABLE_LOCKING;
    try {
      expect(() => withFileLock(testFile, () => 'should not run'))
        .toThrow(/Unable to acquire lock/);
    } finally {
      if (previousEnv !== undefined) process.env.RVR_DISABLE_LOCKING = previousEnv;
      fs.unlinkSync(lockPath);
    }
  });

  it('falls back to lockless execution when RVR_DISABLE_LOCKING=1', () => {
    // Same setup: a non-stale lock that all retries will fail to break
    const lockPath = testFile + '.lock';
    fs.writeFileSync(lockPath, String(process.pid));

    const previousEnv = process.env.RVR_DISABLE_LOCKING;
    process.env.RVR_DISABLE_LOCKING = '1';
    try {
      // With the env var set, the closure runs anyway (test escape hatch)
      const result = withFileLock(testFile, () => 'fallback');
      expect(result).toBe('fallback');
    } finally {
      if (previousEnv !== undefined) process.env.RVR_DISABLE_LOCKING = previousEnv;
      else delete process.env.RVR_DISABLE_LOCKING;
      fs.unlinkSync(lockPath);
    }
  });

  it('creates lock file with PID content', () => {
    let lockContent = '';
    withFileLock(testFile, () => {
      const lockPath = testFile + '.lock';
      lockContent = fs.readFileSync(lockPath, 'utf8');
    });
    expect(lockContent).toBe(String(process.pid));
  });

  it('handles non-existent target file path', () => {
    const nonExistent = path.join(tmpDir, 'does-not-exist.json');
    const result = withFileLock(nonExistent, () => 'ok');
    expect(result).toBe('ok');
    expect(fs.existsSync(nonExistent + '.lock')).toBe(false);
  });

  // #254: a store write waits up to STORE_LOCK_WAIT_MS for other writers'
  // transactions; everything else keeps the short default, so a held lock
  // costs session bookkeeping and the startup migration check ~31ms, not 1s.
  describe('how long a caller waits for a held lock (#254)', () => {
    const hold = () => fs.writeFileSync(testFile + '.lock', String(process.pid));
    const elapsed = (fn: () => void) => { const t = Date.now(); fn(); return Date.now() - t; };

    it('the default gives up after about 31ms, with a LockTimeoutError', () => {
      hold();
      let thrown: unknown;
      const ms = elapsed(() => { try { withFileLock(testFile, () => 'x'); } catch (err) { thrown = err; } });
      expect(thrown).toBeInstanceOf(LockTimeoutError);
      expect(ms).toBeLessThan(500);
    });

    it('a store write waits up to STORE_LOCK_WAIT_MS', () => {
      hold();
      let thrown: unknown;
      const ms = elapsed(() => { try { withFileLock(testFile, () => 'x', STORE_LOCK_WAIT_MS); } catch (err) { thrown = err; } });
      expect(thrown).toBeInstanceOf(LockTimeoutError);
      expect(ms).toBeGreaterThanOrEqual(STORE_LOCK_WAIT_MS - 50);
    });
  });
});

describe('a stale lock this process cannot remove (#259 review)', () => {
  // Its directory is not writable, so the unlink fails. The wait backs off
  // as for any held lock; it used to retry in a tight loop for the whole wait.
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  it.skipIf(isRoot)('backs off instead of spinning, then times out', () => {
    const lockPath = testFile + '.lock';
    fs.writeFileSync(lockPath, '99999');
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lockPath, old, old);
    fs.chmodSync(tmpDir, 0o555);
    const realOpen = fs.openSync.bind(fs);
    let attempts = 0;
    const spy = vi.spyOn(fs, 'openSync').mockImplementation(((p: fs.PathLike, ...rest: unknown[]) => {
      if (String(p) === lockPath) attempts++;
      return (realOpen as (...args: unknown[]) => number)(p, ...rest);
    }) as typeof fs.openSync);
    try {
      expect(() => withFileLock(testFile, () => 'ran', 300)).toThrow(LockTimeoutError);
    } finally {
      spy.mockRestore();
      fs.chmodSync(tmpDir, 0o755);
    }
    // About 300ms of 8–16ms sleeps: a few dozen attempts, not thousands.
    expect(attempts).toBeGreaterThan(1);
    expect(attempts).toBeLessThan(100);
  });
});
