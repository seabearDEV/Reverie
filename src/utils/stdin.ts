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
