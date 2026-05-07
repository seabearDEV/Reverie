import path from 'path';

export function getBinaryName(): string {
  const arg1 = process.argv[1];
  // bun --compile: argv[0] is "bun", argv[1] is "/$bunfs/root/<build-time-outfile>".
  // Neither reflects the runtime invocation name. process.execPath IS the actual
  // path the user invoked (or the symlink target), so basename gives the right
  // command name (e.g. "rvr-beta" when invoked via `rvr-beta`).
  if (arg1?.startsWith('/$bunfs/')) {
    return path.basename(process.execPath);
  }
  // In normal Node.js (including npm link), argv[1] is a script file path (contains /)
  // In SEA mode, argv[1] is the first user argument (e.g. "get") or undefined
  if (arg1 && (arg1.includes('/') || arg1.includes('\\'))) {
    return path.basename(arg1);
  }
  // SEA binary: argv[0] is the binary itself (e.g. /usr/local/bin/rvr)
  return path.basename(process.argv[0] ?? 'rvr');
}
