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
  'STORE_UNREADABLE',
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

// Per-invocation signals for telemetry/audit (#188): a command records shape
// and degradation facts here (tier, pinned/indexed counts, demoted/shed
// namespaces) and the instrumentation wrapper drains them into the row —
// the CLI analog of the MCP wrapper's AsyncLocalStorage guardrail channel.
export interface InvocationSignals {
  tier?: string | undefined;
  pinned?: number | undefined;
  indexed?: number | undefined;
  degraded?: boolean | undefined;
  shedNamespaces?: string[] | undefined;
  demotedNamespaces?: string[] | undefined;
  gistChars?: number | undefined;
}
let signals: InvocationSignals = {};

// The code the current call failed with (#203), for its telemetry and audit
// rows. printError and handleError record it in text mode, where the failure
// is otherwise only a line on stderr; failJson records it in JSON mode. The
// instrumentation wrapper takes it when the call ends, so in an invocation
// that runs several calls — a batch `set` — no call is handed another's
// code. (The envelope's own `error` is per invocation and is not cleared.)
let reportedErrorCode: ErrorCode | undefined;

export function recordSignals(partial: InvocationSignals): void {
  Object.assign(signals, partial);
}

/** Drain the recorded signals (empties the channel). */
export function takeSignals(): InvocationSignals {
  const drained = signals;
  signals = {};
  return drained;
}

/**
 * Initialize output state for a command invocation. Called from the preAction
 * hook with the resolved JSON-mode decision and the leaf command name.
 */
export function configureOutput(opts: { json: boolean; command: string }): void {
  state = freshState();
  signals = {};
  reportedErrorCode = undefined;
  state.json = opts.json;
  state.command = opts.command;
}

/** Reset to defaults — test helper. */
export function resetOutput(): void {
  state = freshState();
  signals = {};
  reportedErrorCode = undefined;
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

/**
 * Whether a result was explicitly recorded. Used by the instrumentation
 * wrapper (#120) to derive the envelope result from the handler's return
 * value only when the handler didn't set one itself.
 */
export function hasResult(): boolean {
  return state.resultSet;
}

/** Record a non-fatal warning. `code` defaults to a generic WARNING bucket. */
export function addWarning(message: string, code = 'WARNING', count?: number): void {
  if (!message) return;
  const w: EnvelopeWarning = { code, message };
  if (count !== undefined) w.count = count;
  state.warnings.push(w);
}

/**
 * Whether this exact warning is already recorded. A batch `set` runs one
 * instrumented call per pair into a single envelope, so a warning about the
 * store itself would otherwise be added once per pair.
 */
export function hasWarning(message: string, code = 'WARNING'): boolean {
  return state.warnings.some(w => w.code === code && w.message === message);
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
  reportedErrorCode = code;
  process.exitCode = 1;
}

/** Record the code of a failure reported outside the envelope (text mode). */
export function recordErrorCode(code: ErrorCode): void {
  reportedErrorCode = code;
}

/** The code reported since the last take, if any. Clears it. */
export function takeErrorCode(): ErrorCode | undefined {
  const code = reportedErrorCode;
  reportedErrorCode = undefined;
  return code;
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
 * `line` is an envelope already serialized by serializeEnvelope: the wrapper
 * measures it for the telemetry and audit rows (#192) and hands the same
 * string here, so what was measured is what is written.
 */
export function emitEnvelope(write?: (s: string) => void, line?: string): void {
  if (state.emitted) return;
  state.emitted = true;
  const out = line ?? serializeEnvelope();
  if (write) write(out);
  else process.stdout.write(out);
}

/** The envelope as emitEnvelope writes it, given the state as it stands. */
export function serializeEnvelope(): string {
  return JSON.stringify(buildEnvelope(), null, 2) + '\n';
}
