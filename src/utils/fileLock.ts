import fs from 'fs';
import { debug } from './debug';

const LOCK_STALE_MS = 10_000; // Consider lock stale after 10 seconds
/**
 * How long acquireLock waits for a lock another process holds before it gives
 * up (#254). A store write holds its lock across the read, the change and the
 * write, a few milliseconds, so concurrent writers queue for about that much
 * each. The old budget — five doubling retries, 31ms — failed about one in
 * sixty of twelve concurrent `rvr confirm set`s.
 */
/**
 * How long a caller waits for a busy lock before giving up. The default is
 * main's old budget (five backoff steps, about 31ms): session bookkeeping and
 * the startup migration check skip their work rather than stall a command.
 * Store writes pass STORE_LOCK_WAIT_MS (#254): a store transaction holds the
 * lock across read, change and write, and parallel writers queue behind it.
 */
const DEFAULT_LOCK_WAIT_MS = 31;
export const STORE_LOCK_WAIT_MS = 1_000;

/** Another process held the lock for the whole wait. */
export class LockTimeoutError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'LockTimeoutError';
  }
}
/** Longest single sleep between attempts: past it, the backoff stops doubling. */
const LOCK_BACKOFF_CAP_MS = 16;
// Reusable buffer for Atomics.wait()-based sleep (avoids per-call allocation)
const _sleepBuf = new Int32Array(new SharedArrayBuffer(4));

/**
 * Acquire an advisory file lock using a .lock file.
 * Retries with backoff while the lock is held by another process, for up to
 * LOCK_WAIT_MS, then throws. Automatically breaks stale locks (older than
 * LOCK_STALE_MS).
 */
function acquireLock(filePath: string, waitMs: number): void {
  const lockPath = filePath + '.lock';
  const deadline = Date.now() + waitMs;

  for (let attempt = 0; ; attempt++) {
    try {
      // O_CREAT | O_EXCL: fail if file already exists (atomic)
      const fd = fs.openSync(lockPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY);
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return;
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'code' in err && (err as { code: string }).code === 'EEXIST') {
        const remaining = deadline - Date.now();
        // Lock file exists — check if stale
        try {
          const stat = fs.statSync(lockPath);
          if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
            // Stale lock — remove and retry immediately.
            // TOCTOU note: another process may unlink+recreate between our
            // unlink and the next openSync, but that's fine — the O_CREAT|O_EXCL
            // re-acquire is atomic so we'll just loop again.
            let removed = false;
            try {
              fs.unlinkSync(lockPath);
              removed = true;
            } catch (unlinkErr) {
              // Gone already: another process removed it — retry at once.
              removed = !!unlinkErr && typeof unlinkErr === 'object' && 'code' in unlinkErr && unlinkErr.code === 'ENOENT';
            }
            if (removed && remaining > 0) continue;
            // Could not remove it (no permission on its directory): back off
            // like any held lock instead of retrying in a tight loop.
          }
        } catch {
          // Lock file disappeared — retry
          if (remaining > 0) continue;
        }

        if (remaining > 0) {
          // Sleep with exponential backoff (1ms, 2ms, 4ms, 8ms, then 16ms),
          // with jitter so waiters woken together do not retry in lockstep.
          const backoff = Math.min(2 ** attempt, LOCK_BACKOFF_CAP_MS);
          const waitMs = Math.min(remaining, backoff / 2 + Math.random() * (backoff / 2));
          Atomics.wait(_sleepBuf, 0, 0, waitMs);
          continue;
        }

        throw new LockTimeoutError(
          `Unable to acquire lock on ${filePath} after ${waitMs}ms: another process held it the whole time, so nothing was written. `
          + `Try again; a lock left by a process that crashed clears after ${LOCK_STALE_MS / 1000} seconds.`,
          { cause: err },
        );
      }
      throw err;
    }
  }
}

/**
 * Release an advisory file lock.
 */
function releaseLock(filePath: string): void {
  const lockPath = filePath + '.lock';
  try {
    fs.unlinkSync(lockPath);
  } catch {
    // Lock file already removed — ignore
  }
}

/**
 * Execute a function while holding a file lock.
 *
 * **Default (production) behavior: fail closed.** If lock acquisition fails
 * (after the bounded retry loop in `acquireLock`), the error propagates and
 * the closure does NOT run. This is the safe choice — running unlocked
 * exposes per-entry writes to clobbering between concurrent processes, since
 * the seqlock added in v1.10.x only protects readers from torn states, not
 * writers from racing each other.
 *
 * **Test escape hatch: `RVR_DISABLE_LOCKING=1`.** Set this env var to fall
 * back to running the closure unlocked when lock acquisition fails. This
 * preserves the pre-v1.11 silent-fallback behavior for tests that intentionally
 * exercise contended-lock scenarios. The env var is read fresh on every call,
 * so tests can flip it on and off without restarting the process.
 *
 * Production code should never set `RVR_DISABLE_LOCKING`. There are no
 * known production environments where lock acquisition is expected to fail.
 */
export function withFileLock<T>(filePath: string, fn: () => T, waitMs: number = DEFAULT_LOCK_WAIT_MS): T {
  let locked = false;
  try {
    acquireLock(filePath, waitMs);
    locked = true;
  } catch (err) {
    if (process.env.RVR_DISABLE_LOCKING === '1') {
      debug(`Lock acquisition failed for ${filePath}, RVR_DISABLE_LOCKING=1 set — proceeding without lock: ${String(err)}`);
    } else {
      throw err;
    }
  }
  try {
    return fn();
  } finally {
    if (locked) {
      releaseLock(filePath);
    }
  }
}
