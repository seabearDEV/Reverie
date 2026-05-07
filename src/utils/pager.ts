import { spawn } from 'child_process';
import { addResponseBytes } from './responseMeasure';

/**
 * Buffers all stdout output produced by `fn`, then either writes it directly
 * (short output) or pipes it through a pager (long output).
 *
 * Pager resolution: RVR_PAGER env → PAGER env → "less -FRX"
 * Skips paging entirely when stdout is not a TTY (piped output).
 */
export async function withPager(fn: () => void | Promise<void>): Promise<void> {
  // If not a TTY, just run directly — no buffering needed
  if (!process.stdout.isTTY) {
    await fn();
    return;
  }

  const chunks: (string | Uint8Array)[] = [];
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const originalWrite = process.stdout.write;

  // Monkey-patch stdout.write to capture output
  process.stdout.write = function (
    chunk: string | Uint8Array,
    encodingOrCallback?: BufferEncoding | ((err?: Error) => void),
    callback?: (err?: Error) => void
  ): boolean {
    chunks.push(chunk);
    // Call the appropriate callback to avoid stalling callers that wait on it
    const cb = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;
    if (cb) cb();
    return true;
  } as typeof process.stdout.write;

  try {
    await fn();
  } finally {
    // Always restore original write
    process.stdout.write = originalWrite;
  }

  const buffer = chunks
    .map(c => (typeof c === 'string' ? c : Buffer.from(c).toString()))
    .join('');

  // Count newlines to decide whether to page
  let lineCount = 0;
  for (const ch of buffer) {
    if (ch === '\n') lineCount++;
  }

  const rows = process.stdout.rows || 24;

  if (lineCount <= rows - 5) {
    originalWrite.call(process.stdout, buffer);
    return;
  }

  // Spawn pager
  const pagerCmd = process.env.RVR_PAGER ?? process.env.PAGER ?? 'less -FRX';
  const parts = pagerCmd.split(/\s+/);
  const pagerBin = parts[0];
  const pagerArgs = parts.slice(1);

  return new Promise<void>((resolve) => {
    const child = spawn(pagerBin, pagerArgs, {
      stdio: ['pipe', process.stdout, process.stderr],
    });

    let spawnFailed = false;

    child.on('error', () => {
      // Pager spawn failed; fall back to direct output. `originalWrite` is
      // the CLI instrumentation hook, which calls `addResponseBytes`
      // automatically — so no explicit count is needed here.
      spawnFailed = true;
      originalWrite.call(process.stdout, buffer);
      resolve();
    });

    child.on('close', () => {
      // Pager ran to completion. Bytes went through an OS pipe (not
      // stdout.write), so the instrumentation hook never saw them — count
      // explicitly. Skip when a spawn error already fired; in that case
      // `originalWrite` (the hook) counted the bytes on the fallback path.
      if (!spawnFailed) {
        addResponseBytes(Buffer.byteLength(buffer, 'utf8'));
      }
      resolve();
    });

    child.stdin.on('error', () => {
      // Ignore broken pipe — pager may exit early
    });

    child.stdin.end(buffer);
  });
}
