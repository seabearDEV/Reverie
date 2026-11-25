import fs from 'fs';

/**
 * Read all of stdin for a command that takes its value there.
 *
 * A regular file on fd 0 is read synchronously. That is what `< file`, a
 * here-string and — in zsh, and in bash before 5.1 — a heredoc put on fd 0.
 * Under Bun the stream path loses such input: once `process.stdin` exists
 * (any `process.stdin.isTTY` check creates it) a file-backed stream smaller
 * than 64KB runs to its end before an iterator attached on a later
 * event-loop turn sees anything, and the read returns zero bytes. Pipes do
 * not behave this way, so `echo v | rvr set k` worked while
 * `rvr set k <<'EOF'` reported "No input received from stdin" — every time,
 * for any entry of realistic size (measured on the 1.3.0 binary, Bun 1.3.14:
 * 65,535 bytes fails, 65,536 succeeds).
 *
 * Pipes, sockets and character devices keep the stream path: a synchronous
 * read of a non-blocking pipe can fail with EAGAIN.
 */
export async function readStdin(): Promise<Buffer> {
  let regularFile = false;
  try {
    regularFile = fs.fstatSync(0).isFile();
  } catch { /* fd 0 closed or not stat-able — fall through to the stream */ }
  if (regularFile) return fs.readFileSync(0);

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks);
}

/**
 * How long a metadata-only `set` waits for the first byte on stdin before it
 * gives up and applies its flag alone (#225). Long enough for a command on
 * the other end of a pipe to start writing; short enough that an agent whose
 * harness leaves stdin open and silent is not left hanging until its own
 * timeout. `RVR_STDIN_WAIT_MS` overrides it.
 */
export const DEFAULT_STDIN_FIRST_BYTE_WAIT_MS = 2000;

/**
 * The longest delay a timer takes: 2^31-1 ms, about 24.8 days. Past it Bun
 * (and Node) reset the delay to 1 ms, so the largest values — the ones chosen
 * to switch the deadline off — gave up at once and dropped a piped value,
 * while the warning named a wait that never happened.
 */
export const MAX_STDIN_FIRST_BYTE_WAIT_MS = 2_147_483_647;

/**
 * The wait in whole milliseconds. Unset, blank, negative or not a number: the
 * default. Anything larger than a timer can hold: the longest it can.
 */
export function stdinFirstByteWaitMs(): number {
  const raw = process.env.RVR_STDIN_WAIT_MS?.trim();
  if (raw === undefined || raw === '') return DEFAULT_STDIN_FIRST_BYTE_WAIT_MS;
  const parsed = Number(raw);
  if (Number.isNaN(parsed) || parsed < 0) return DEFAULT_STDIN_FIRST_BYTE_WAIT_MS;
  return Math.min(Math.floor(parsed), MAX_STDIN_FIRST_BYTE_WAIT_MS);
}

/**
 * Read all of stdin, but give up if nothing at all arrives within
 * `firstByteMs`. Returns null when it gave up, and the bytes otherwise —
 * empty when stdin was closed with nothing on it.
 *
 * The deadline is for the first byte only. Once anything has arrived the
 * read runs to end of input however long that takes, so a value is never
 * cut short: it is either taken whole or, when its producer had written
 * nothing by the deadline, not taken at all.
 *
 * For the one caller that can do without a value: `set <key>` carrying only
 * `-a`, `--confirm` or `--no-confirm`. A non-empty stdin is still the value
 * there (#221); a stdin that is open and silent used to block forever.
 */
export function readStdinWithin(firstByteMs: number): Promise<Buffer | null> {
  let regularFile = false;
  try {
    regularFile = fs.fstatSync(0).isFile();
  } catch { /* fall through to the stream */ }
  if (regularFile) return Promise.resolve(fs.readFileSync(0));

  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    const chunks: Buffer[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;

    const detach = (): void => {
      if (timer !== undefined) { clearTimeout(timer); timer = undefined; }
      stdin.off('data', onData);
      stdin.off('end', onEnd);
      stdin.off('error', onError);
    };
    function onData(chunk: Buffer | string): void {
      if (timer !== undefined) { clearTimeout(timer); timer = undefined; }
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    function onEnd(): void {
      detach();
      resolve(Buffer.concat(chunks));
    }
    function onError(err: Error): void {
      detach();
      reject(err);
    }

    timer = setTimeout(() => {
      detach();
      // Let go of stdin so the open pipe does not keep the process alive.
      stdin.pause();
      stdin.destroy();
      resolve(null);
    }, firstByteMs);

    stdin.on('data', onData);
    stdin.once('end', onEnd);
    stdin.once('error', onError);
  });
}
