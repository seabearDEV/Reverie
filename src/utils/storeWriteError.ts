/**
 * A store write the filesystem refused (#271): a directory where an entry
 * file belongs, a file made immutable, no permission, no space. The write
 * printed a raw Node message (`Failed to set entry:: EISDIR: … rename
 * '<temp file>' -> '<file>'`) or a Bun source excerpt. It is one line now,
 * naming the file and why, with the code IO on every surface, as a lock
 * timeout is since #261.
 *
 * The system error's `code` (EACCES, EISDIR, …), `path` and `syscall` stay
 * on the error: callers branch on them — the confirmation list falls back to
 * the project's list when the global one cannot be written (#256), a rename
 * refuses a key too long for a file name.
 *
 * No store imports: directoryStore.ts throws it, and storage.ts, the CLI
 * wrapper and the MCP server render it.
 */
import { LockTimeoutError } from './fileLock';
import { displayPath } from './unreadable';

/** Why, in words, for the codes a store write meets. Others use the system's own words. */
const REASONS: Record<string, string> = {
  EACCES: 'permission denied',
  EPERM: 'operation not permitted; the file may be immutable or locked',
  EISDIR: 'a directory is in its place',
  ENOTDIR: 'a part of its path is not a directory',
  ENOSPC: 'no space left on the device',
  EDQUOT: 'the disk quota is used up',
  EROFS: 'the file system is read-only',
  ENAMETOOLONG: 'the file name is too long for this file system',
  EMFILE: 'too many open files',
  ENFILE: 'too many open files',
  EIO: 'an input/output error',
  EBUSY: 'the file is busy',
};

/** The temp-file suffix atomicWriteFileSync adds: `<file>.<16 hex>.tmp`. */
const TEMP_SUFFIX = /\.[0-9a-f]{16}\.tmp$/;

type SystemError = Error & { code: string; syscall: string; path?: unknown; dest?: unknown };

/** An error from a system call: an `E…` code and the call that failed. */
export function isSystemError(err: unknown): err is SystemError {
  if (!(err instanceof Error)) return false;
  const { code, syscall } = err as Partial<SystemError>;
  return typeof code === 'string' && /^E[A-Z0-9]+$/.test(code) && typeof syscall === 'string';
}

function verbFor(syscall: string): string {
  if (syscall === 'unlink' || syscall === 'rmdir') return 'remove';
  if (syscall === 'mkdir') return 'create';
  if (['scandir', 'opendir', 'read', 'stat', 'lstat', 'fstat', 'readlink', 'access', 'realpath'].includes(syscall)) return 'read';
  return 'write';
}

export class StoreWriteError extends Error {
  /** The system error code: EACCES, EISDIR, ENOSPC, … */
  readonly code: string;
  /** The file the store could not write, never the temp file written on the way to it. */
  readonly path: string;
  readonly syscall: string;

  constructor(err: SystemError, nothingWritten: boolean) {
    // A rename names the file it was writing as `dest`; a failed temp-file
    // write names the temp file, which is the target plus a suffix.
    const file = typeof err.dest === 'string' ? err.dest
      : typeof err.path === 'string' ? err.path.replace(TEMP_SUFFIX, '')
      : '';
    const reason = REASONS[err.code] ?? err.message.replace(/^E[A-Z0-9]+: /, '').split(', ')[0];
    const what = file ? displayPath(file) : 'the store';
    super(`Cannot ${verbFor(err.syscall)} ${what}: ${reason} (${err.code}).${nothingWritten ? ' Nothing was written.' : ''}`, { cause: err });
    this.name = 'StoreWriteError';
    this.code = err.code;
    this.path = file;
    this.syscall = err.syscall;
  }
}

/**
 * `err` as a StoreWriteError when it is a system error, else `err` itself.
 * `nothingWritten`: the store is as it was — the message says so.
 */
export function toStoreWriteError(err: unknown, nothingWritten: boolean): unknown {
  if (err instanceof StoreWriteError || !isSystemError(err)) return err;
  return new StoreWriteError(err, nothingWritten);
}

/** A store write that failed for a reason outside the command: IO on every surface. */
export function isStoreIoError(err: unknown): err is LockTimeoutError | StoreWriteError {
  return err instanceof LockTimeoutError || err instanceof StoreWriteError;
}
