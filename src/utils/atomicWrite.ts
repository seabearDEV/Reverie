import fs from 'fs';
import crypto from 'crypto';

/**
 * Write a file atomically by writing to a temporary file first,
 * then renaming into place. On POSIX systems, rename is atomic,
 * so the target file is never left in a partial/corrupt state.
 * Files are created with mode 0600 (owner read/write only).
 *
 * SECURITY (#159 write-side): a hostile cloned store ships a REAL `.reverie/`
 * dir (so the dir-leaf symlink guard passes) containing a pre-planted symlink
 * at the predictable tmp path (e.g. `_epoch.json.tmp` → `../../.zshrc`). The
 * old `filePath + '.tmp'` + default 'w' flag followed that link and truncated
 * the target on the victim's first write. Two defenses: an unpredictable tmp
 * suffix (an attacker cannot pre-plant a link at a name they can't guess) and
 * the 'wx' flag (O_CREAT|O_EXCL|O_WRONLY — O_EXCL refuses an existing path and
 * does not follow a symlink), matching ensureReadme's already-safe write.
 */
export function atomicWriteFileSync(filePath: string, content: string): void {
  const tmpPath = `${filePath}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmpPath, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    // Best-effort cleanup so a failed write (including an EEXIST from a
    // pre-planted tmp symlink) doesn't leave the temp file behind.
    try { fs.unlinkSync(tmpPath); } catch { /* nothing to clean up */ }
    throw err;
  }
}
