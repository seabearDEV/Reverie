import fs from 'fs';
import { debug } from './debug';

const LOCK_STALE_MS = 10_000; // Consider lock stale after 10 seconds
// Reusable buffer for Atomics.wait()-based sleep (avoids per-call allocation)
const _sleepBuf = new Int32Array(new SharedArrayBuffer(4));

/**
 * Acquire an advisory file lock using a .lock file.
 * Retries with backoff if the lock is held by another process.
 * Automatically breaks stale locks (older than LOCK_STALE_MS).
 */
function acquireLock(filePath: string, maxRetries = 5): void {
  const lockPath = filePath + '.lock';

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      // O_CREAT | O_EXCL: fail if file already exists (atomic)
      const fd = fs.openSync(lockPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY);
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return;
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'code' in err && (err as { code: string }).code === 'EEXIST') {
        // Lock file exists — check if stale
        try {
          const stat = fs.statSync(lockPath);
          if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
            // Stale lock — remove and retry immediately.
            // TOCTOU note: another process may unlink+recreate between our
            // unlink and the next openSync, but that's fine — the O_CREAT|O_EXCL
            // re-acquire is atomic so we'll just loop again.
            try { fs.unlinkSync(lockPath); } catch { /* another process may have removed it */ }
            continue;
          }
        } catch {
          // Lock file disappeared — retry
          continue;
        }

        if (attempt < maxRetries) {
          // Sleep with exponential backoff (1ms, 2ms, 4ms, 8ms, 16ms)
          const waitMs = Math.pow(2, attempt);
          Atomics.wait(_sleepBuf, 0, 0, waitMs);
          continue;
        }

        throw new Error(`Unable to acquire lock on ${filePath} after ${maxRetries} retries.`);
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
export function withFileLock<T>(filePath: string, fn: () => T): T {
  let locked = false;
  try {
    acquireLock(filePath);
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
