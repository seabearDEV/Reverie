// Universal structured-output layer for the CLI (#117, WS1).
//
// In JSON mode every command emits exactly one versioned envelope on stdout.
// The CLI is single-threaded per process, so request-scoped state lives at
// module scope. withCliInstrumentation (the wrapper every data command runs
// through) is the single emit point: it sinks handler stdout (so a single
// envelope is the only thing on stdout) and emits the envelope via the
// original writer in its finally block. Contract is pinned by the committed
// design doc — see docs/design-117-cli-agent-parity.md.

/** Envelope SCHEMA version. Bumps only on a breaking envelope-shape change. */
export const ENVELOPE_VERSION = '1';

/**
 * Frozen error-code set. Codes reuse the MCP server's existing names where
 * they exist (PROJECT_UNRESOLVED) so the CLI and MCP error contracts match —
 * the whole point of #117. Adding a code is a minor change; removing or
 * renaming one is breaking and bumps ENVELOPE_VERSION. Surfaced via
 * `rvr manifest` and documented in the design doc's frozen-set table.
 */
export const ERROR_CODES = [
  'PROJECT_UNRESOLVED',
  'NOT_FOUND',
  'INVALID_INPUT',
  'REQUIRES_CONFIRMATION',
  'ENCRYPTED_NO_PASSWORD',
  'DECRYPT_FAILED',
  'COMMAND_FAILED',
  'INPUT_REQUIRED',
  'IO',
  'RUNTIME',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface EnvelopeError {
  code: ErrorCode;
  message: string;
  /** For REQUIRES_CONFIRMATION / COMMAND_FAILED etc.: the resolved command. */
  preview?: string;
}

export interface EnvelopeWarning {
  code: string;
  message: string;
  count?: number;
}

export interface ReverieEnvelope {
  reverie: string;
  ok: boolean;
  command: string;
  result?: unknown;
  warnings?: EnvelopeWarning[];
  error?: EnvelopeError;
}

interface OutputState {
  json: boolean;
  command: string;
  result: unknown;
  resultSet: boolean;
  warnings: EnvelopeWarning[];
  error: EnvelopeError | undefined;
  emitted: boolean;
}

function freshState(): OutputState {
  return {
    json: false,
    command: '',
    result: undefined,
    resultSet: false,
    warnings: [],
    error: undefined,
    emitted: false,
  };
}

let state: OutputState = freshState();

/**
 * Initialize output state for a command invocation. Called from the preAction
 * hook with the resolved JSON-mode decision and the leaf command name.
 */
export function configureOutput(opts: { json: boolean; command: string }): void {
  state = freshState();
  state.json = opts.json;
  state.command = opts.command;
}

/** Reset to defaults — test helper. */
export function resetOutput(): void {
  state = freshState();
}

export function isJsonMode(): boolean {
  return state.json;
}

/** Resolve JSON mode from a per-command flag plus the session-wide env var. */
export function resolveJsonMode(flag: boolean | undefined): boolean {
  return flag === true || process.env.RVR_OUTPUT === 'json';
}

/** Set the command-specific result payload (JSON mode only). */
export function setResult(value: unknown): void {
  state.result = value;
  state.resultSet = true;
}

/** Record a non-fatal warning. `code` defaults to a generic WARNING bucket. */
export function addWarning(message: string, code = 'WARNING', count?: number): void {
  if (!message) return;
  const w: EnvelopeWarning = { code, message };
  if (count !== undefined) w.count = count;
  state.warnings.push(w);
}

/**
 * Record a structured error and flag the process for a non-zero exit. The
 * envelope is emitted (ok:false) by the wrapper / finalize step. `preview`
 * carries the resolved command for REQUIRES_CONFIRMATION / COMMAND_FAILED.
 */
export function failJson(code: ErrorCode, message: string, preview?: string): void {
  const err: EnvelopeError = { code, message };
  if (preview !== undefined) err.preview = preview;
  state.error = err;
  process.exitCode = 1;
}

export function hasError(): boolean {
  return state.error !== undefined;
}

/**
 * Build the envelope from current state. `ok` is false if an error was
 * recorded OR the process exit code is non-zero (a command set exitCode
 * without going through failJson). Exported for the finalize fallback.
 */
export function buildEnvelope(): ReverieEnvelope {
  const ok = state.error === undefined && (process.exitCode ?? 0) === 0;
  const env: ReverieEnvelope = {
    reverie: ENVELOPE_VERSION,
    ok,
    command: state.command,
  };
  if (state.resultSet) env.result = state.result;
  if (state.warnings.length > 0) env.warnings = [...state.warnings];
  if (state.error) {
    env.error = state.error;
  } else if (!ok) {
    // exitCode was set without a structured error — synthesize one so the
    // contract (error present iff !ok) holds.
    env.error = { code: 'RUNTIME', message: 'Command failed.' };
  }
  return env;
}

export function alreadyEmitted(): boolean {
  return state.emitted;
}

/**
 * Emit exactly one envelope. `write` defaults to process.stdout.write but the
 * wrapper passes the *original* (pre-monkey-patch) writer so the envelope
 * reaches the real stdout while handler output stays sunk. Idempotent.
 */
export function emitEnvelope(write?: (s: string) => void): void {
  if (state.emitted) return;
  state.emitted = true;
  const out = buildEnvelope();
  const line = JSON.stringify(out, null, 2) + '\n';
  if (write) write(line);
  else process.stdout.write(line);
}
