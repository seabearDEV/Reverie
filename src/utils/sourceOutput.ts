// `rvr run --source` (#281). The shell wrapper that `rvr config completions
// install` adds captures this process's stdout and evals it in the user's
// shell, so stdout must hold the command and nothing else. Anything else
// printed there runs as shell code: a JSON envelope, a warning, a --debug line
// — and each of those can quote store file names, which a cloned repository
// chooses (`x$(touch PWN).json`).
//
// So for a --source run every write to stdout goes to stderr, except the one
// writeSourceCommand makes. No imports: this is reached from index.ts and
// commands/entries.ts, and many suites mock their neighbours with explicit
// factories.

type StdoutWriteArgs = Parameters<typeof process.stdout.write>;

/** Set while writeSourceCommand writes: that one write goes to the real stdout. */
let writingCommand = false;
let restore: (() => void) | undefined;

/**
 * Send stdout to stderr for the rest of this process — `process.stdout.write`
 * and the console methods that print to stdout, which under Bun do not go
 * through `process.stdout.write`. Idempotent. Entered before the run's
 * instrumentation wraps stdout, so the wrapper forwards to stderr too.
 */
export function enterSourceOutput(): void {
  if (restore) return;
  const out = process.stdout;
  const realWrite = out.write.bind(out);
  const toStderr = process.stderr.write.bind(process.stderr);
  const realError = console.error.bind(console);
  const saved = { log: console.log, info: console.info, debug: console.debug, dir: console.dir, table: console.table };
  out.write = ((...args: StdoutWriteArgs): boolean =>
    ((writingCommand ? realWrite : toStderr) as (...a: StdoutWriteArgs) => boolean)(...args)) as typeof out.write;
  const toError = (...args: unknown[]): void => { realError(...args); };
  console.log = toError;
  console.info = toError;
  console.debug = toError;
  console.dir = toError;
  console.table = toError;
  restore = () => {
    out.write = realWrite;
    Object.assign(console, saved);
    restore = undefined;
  };
}

/** Undo enterSourceOutput — for tests; the CLI never leaves source mode. */
export function leaveSourceOutput(): void {
  restore?.();
}

/**
 * Write the command for the wrapper to eval: the one write that reaches
 * stdout. Through `process.stdout.write`, so the run's instrumentation counts
 * it as the response, as it did before; the stdout writer installed above
 * passes this write, and only this one, to the real stdout.
 */
export function writeSourceCommand(text: string): void {
  writingCommand = true;
  try {
    process.stdout.write(text);
  } finally {
    writingCommand = false;
  }
}
