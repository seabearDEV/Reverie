import path from 'path';
import { formatWithOptions } from 'node:util';
import { Scope } from '../store';
import { getValue, getEntriesFlat } from '../storage';
import { aliasTargetListed, resolveTypedName } from '../alias';
import { sanitizeValue, sanitizeParams, logAudit } from './audit';
import { logToolCall, classifyOp, TelemetryEntry, TelemetryExtras, extractNamespace, keyIsEntryKey, appendMissPath } from './telemetry';
import { recordCliWrite, trackCliMissPath } from './sessionState';
import { formatWriteAmpWarning, takeValueStored, writeAmpStore, WriteAmpResult } from './writeAmp';
import { findProjectFile } from '../store';
import { startResponseMeasure, addResponseBytes, endResponseMeasure } from './responseMeasure';
import { resolveAgentIdentity } from './agentIdentity';
import { ProjectResolutionError } from '../projectResolution';
import { isStoreIoError } from './storeWriteError';
import { KeyCollisionError } from './keyCollision';
import { loadConfig } from '../config';
import { color } from '../formatting';
import { StoreUnreadableError, listUnreadableFiles, markUnreadableShown, takeWriteRefused, unreadableWarning, unreadableWarningBlock, withoutShown } from './unreadable';
import { isJsonMode, failJson, emitEnvelope, addWarning, hasWarning, setResult, hasResult, hasError, takeSignals, takeErrorCode, serializeEnvelope, alreadyEmitted } from './output';

// ── Shared constants (used by both MCP and CLI wrappers) ─────────────

/**
 * Observability tools whose rows are tagged selfRef:true (#134). Formerly
 * SKIP_AUDIT — these calls were not logged at all, which made stats/audit
 * usage unverifiable from the record ("never run" and "invisible" looked
 * identical) and left the 'meta' op class permanently unfired. They are now
 * fully instrumented; computeStats and queryAuditLog exclude selfRef rows by
 * default so aggregates never count the act of looking at them.
 */
export const SELF_REF_TOOLS = new Set(['reverie_stats', 'reverie_audit']);

/** Tools that operate on the entire store (before/after = entry count) */
export const BULK_OPS = new Set(['reverie_import', 'reverie_reset']);

// ── Shared helpers ───────────────────────────────────────────────────

/**
 * Capture the current value of a key for before/after audit comparison.
 * Handles alias ops (captures alias target) and regular entries.
 * Shared between MCP and CLI wrappers.
 */
export function captureValue(tool: string, key: string | undefined, scope: Scope): string | undefined {
  if (!key || BULK_OPS.has(tool)) return undefined;
  try {
    // A config tool's key is a setting: its value before is the setting's
    // effective value, not a store entry that happens to share the name (#273).
    if (tool === 'reverie_config_set' || tool === 'reverie_config_unset') {
      const config = loadConfig() as unknown as Record<string, string | number | boolean>;
      return Object.hasOwn(config, key) ? String(config[key]) : undefined;
    }
    // Alias operations: capture the alias target by alias name
    if (tool === 'reverie_alias_set' || tool === 'reverie_alias_remove') {
      return aliasTargetListed(key, scope);
    }
    // Resolve alias before store lookup so audit reflects the actual mutated entry
    const resolvedKey = resolveTypedName(key, scope).key;
    const val = getValue(resolvedKey, scope);
    if (val === undefined) return undefined;
    return sanitizeValue(typeof val === 'object' ? JSON.stringify(val) : String(val));
  } catch { return undefined; }
}

/**
 * Pre-capture the source value for reverie_copy's after diff (avoids a race
 * with concurrent writes). Shared between MCP and CLI wrappers.
 */
export function captureCopySource(sourceKey: string | undefined, scope: Scope): string | undefined {
  if (!sourceKey) return undefined;
  try {
    const resolved = resolveTypedName(sourceKey, scope).key;
    const val = getValue(resolved, scope);
    return val !== undefined
      ? sanitizeValue(typeof val === 'object' ? JSON.stringify(val) : String(val))
      : undefined;
  } catch { return undefined; }
}

/** Before/after capture for BULK_OPS — whole-store ops log an entry count. */
export function captureBulkCount(scope: Scope): string | undefined {
  try {
    return `${Object.keys(getEntriesFlat(scope)).length} entries`;
  } catch { return undefined; }
}

export interface AfterValueInputs {
  /** Explicit after-value for set/config_set (pre-sanitize). */
  writeValue?: string | undefined;
  before?: string | undefined;
  copySourceValue?: string | undefined;
  /** Target path for alias_set. */
  aliasPath?: string | undefined;
  key?: string | undefined;
  scope: Scope;
}

/**
 * Derive the after-value for a non-bulk write from params/before rather than
 * re-reading the store (concurrent requests can race and corrupt the read).
 * The per-tool semantics here have diverged between wrappers before (#94) —
 * keep this the single home.
 */
export function deriveAfterValue(tool: string, inputs: AfterValueInputs): string | undefined {
  if (tool === 'reverie_set' || tool === 'reverie_config_set') return sanitizeValue(inputs.writeValue);
  if (tool === 'reverie_copy') return inputs.copySourceValue;
  if (tool === 'reverie_rename') return inputs.before; // Rename preserves the value
  if (tool === 'reverie_remove' || tool === 'reverie_alias_remove' || tool === 'reverie_config_unset') return undefined; // Deleted
  if (tool === 'reverie_alias_set') return inputs.aliasPath;
  // Fallback: re-read (only for unexpected tool names)
  return captureValue(tool, inputs.key, inputs.scope);
}

/**
 * Redundant = value didn't change on a true mutation. Excluded:
 *   - rename (key move, not value change)
 *   - run --dry (read-only) and import --preview (read-only)
 *   - exec ops (reverie_run): the stored command never changes during a run,
 *     so before === after is trivially true and would mis-tag every run as a
 *     "redundant write" — but runs aren't writes at all
 *   - removes never fire because after is undefined
 */
export function isRedundantWrite(
  tool: string,
  op: TelemetryEntry['op'],
  params: Record<string, unknown> | undefined,
  before: string | undefined,
  after: string | undefined,
): true | undefined {
  const isReadOnlyWrite = tool === 'reverie_rename' ||
    (tool === 'reverie_run' && params?.dry === true) ||
    (tool === 'reverie_import' && params?.preview === true);
  return op === 'write' && !isReadOnlyWrite && before !== undefined && after !== undefined && before === after
    ? true
    : undefined;
}

// ── CLI Instrumentation Wrapper ──────────────────────────────────────

export interface CliToolContext {
  tool: string;                           // e.g. 'reverie_set', 'reverie_get'
  key?: string | undefined;               // alias-resolved key
  rawKey?: string | undefined;            // original key before alias resolution
  scope?: 'project' | 'global' | undefined;  // undefined means 'auto'
  params?: Record<string, unknown> | undefined;
  writeValue?: string | undefined;        // explicit after-value for set operations
  copySourceKey?: string | undefined;     // for reverie_copy: source key to pre-capture
  /** JSON mode: leave the envelope to a later call of this invocation. A
   *  batch `set` runs one call per pair and writes one envelope, after the
   *  last, so its `ok` and `error` cover every pair. A deferring call's row
   *  records no response bytes: it wrote none. */
  deferEnvelope?: boolean | undefined;
}

/**
 * Centralized CLI instrumentation wrapper.
 * Mirrors the MCP server's tool wrapper (mcp-server.ts:150-290).
 * Automatically captures before/after values, computes metrics, and logs
 * telemetry + audit for every CLI command.
 */
export async function withCliInstrumentation<T>(
  ctx: CliToolContext,
  fn: () => T | Promise<T>,
): Promise<T> {
  const selfRef = SELF_REF_TOOLS.has(ctx.tool) ? true : undefined;
  const startTime = Date.now();
  const op = classifyOp(ctx.tool);
  const isWrite = op === 'write' || op === 'exec' || op === 'remove';
  const scope: Scope = ctx.scope ?? 'auto';
  // JSON mode (#117 WS1): the wrapper is the single envelope emit point. It
  // sinks handler stdout (so a single envelope is the only thing on stdout)
  // and emits the envelope via the original writer in the finally block.
  const jsonMode = isJsonMode();

  // Alias resolution tracking. reverie_copy is special-cased: its context
  // carries rawKey=source (user input) and copySourceKey=resolvedSource, so
  // the generic rawKey-vs-key check (which compares source to dest) would
  // always be trivially true — always setting aliasResolved to dest,
  // regardless of whether source was actually an alias. #94.
  let aliasResolved: string | undefined;
  if (ctx.tool === 'reverie_copy') {
    if (ctx.rawKey && ctx.copySourceKey && ctx.rawKey !== ctx.copySourceKey) {
      aliasResolved = ctx.copySourceKey;
    }
  } else if (ctx.rawKey && ctx.key && ctx.rawKey !== ctx.key) {
    aliasResolved = ctx.key;
  }

  // Before-value capture (for writes)
  let before: string | undefined;
  let copySourceValue: string | undefined;
  if (isWrite && !BULK_OPS.has(ctx.tool)) {
    before = captureValue(ctx.tool, ctx.key, scope);
    if (ctx.tool === 'reverie_copy') {
      copySourceValue = captureCopySource(ctx.copySourceKey, scope);
    }
  } else if (isWrite && BULK_OPS.has(ctx.tool)) {
    before = captureBulkCount(scope);
  }

  // Begin measuring stdout output for responseSize. We monkey-patch
  // process.stdout.write so that every byte the handler writes to stdout
  // — whether through console.log, direct stdout writes, or buffered
  // through withPager — gets counted into a single process-scoped counter.
  // The counter is read in the finally block and used as `responseSize`,
  // matching the MCP wrapper's "bytes returned to caller" semantic.
  startResponseMeasure();
  // Bind the original to preserve `this` so we don't need an unbound-method
  // exception. We then forward the variadic call signature via apply, which
  // sidesteps the overloaded-signature problem in TypeScript's stdout.write
  // type (string-or-buffer + optional encoding + optional callback).
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  type StdoutWriteArgs = Parameters<typeof process.stdout.write>;
  process.stdout.write = function (...args: StdoutWriteArgs): boolean {
    const chunk = args[0];
    if (typeof chunk === 'string') {
      addResponseBytes(Buffer.byteLength(chunk, 'utf8'));
    } else if (chunk instanceof Uint8Array) {
      addResponseBytes(chunk.byteLength);
    }
    if (jsonMode) {
      // Swallow handler stdout so the final envelope is the only thing
      // written. Still invoke any write callback so callers awaiting drain
      // don't hang. stderr is untouched — diagnostics flow normally.
      const cb = args.find((a) => typeof a === 'function') as (() => void) | undefined;
      if (cb) cb();
      return true;
    }
    return (originalStdoutWrite as (...a: StdoutWriteArgs) => boolean)(...args);
  } as typeof process.stdout.write;

  // Bun: console.log/error don't pass through process.stdout.write — they
  // hit Bun's native fast-write path. Wrap them too so byte counting works
  // there. Under Node, this branch is dead code (typeof Bun === 'undefined').
  const isBun = typeof (globalThis as Record<string, unknown>).Bun !== 'undefined';
  const originalConsoleLog = console.log;
  const originalConsoleError = console.error;
  if (isBun) {
    const formatArgs = (args: unknown[]): string => {
      try {
        return formatWithOptions({ colors: false }, ...args) + '\n';
      } catch {
        return args.map((arg) => {
          try {
            return String(arg);
          } catch {
            return '[unformattable]';
          }
        }).join(' ') + '\n';
      }
    };
    console.log = function (...args: unknown[]): void {
      addResponseBytes(Buffer.byteLength(formatArgs(args), 'utf8'));
      // Under Bun, console.log bypasses process.stdout.write, so swallow it
      // here in JSON mode (mirrors the stdout sink above).
      if (!jsonMode) originalConsoleLog.apply(console, args);
    };
    console.error = function (...args: unknown[]): void {
      addResponseBytes(Buffer.byteLength(formatArgs(args), 'utf8'));
      // console.error goes to stderr — always forward, even in JSON mode.
      originalConsoleError.apply(console, args);
    };
  }

  // Execute handler. The call is judged on its own exit code (#203), not on
  // whether the exit code changed: an earlier call in this process — a
  // previous pair of a batch `set` — may have left it non-zero already, and
  // a second failure then changes nothing. So a non-zero code is set aside
  // while the handler runs and put back after it, unless this call failed
  // too. (Zeroed, not cleared: Bun keeps the old value when exitCode is
  // assigned undefined.)
  const prevExitCode = process.exitCode;
  const failedBefore = (prevExitCode ?? 0) !== 0;
  if (failedBefore) process.exitCode = 0;
  let result: T | undefined;
  let success = true;
  let errorMsg: string | undefined;
  let refusedReason: string | undefined;
  let thrownCode: string | undefined;
  try {
    result = await Promise.resolve(fn());
  } catch (err) {
    success = false;
    errorMsg = String(err);
    thrownCode = err instanceof ProjectResolutionError ? 'PROJECT_UNRESOLVED'
      : err instanceof StoreUnreadableError ? 'STORE_UNREADABLE'
      : isStoreIoError(err) ? 'IO'
      : err instanceof KeyCollisionError ? err.code
      : 'RUNTIME';
    if (err instanceof ProjectResolutionError) {
      refusedReason = 'project_unresolved';
    } else if (err instanceof StoreUnreadableError) {
      // #215: a write refused because its target does not parse. A read of
      // such a file is an error, not a refusal.
      if (err.attempted === 'write') refusedReason = 'store_unreadable';
      markUnreadableShown(err.files);
    }
    // In JSON mode an uncaught throw must still surface as a structured
    // envelope rather than crashing the process with a non-envelope stack
    // trace. Record it and fall through to the finally emit. (Most commands
    // catch internally via handleError; this covers direct-call handlers
    // like the inline alias/confirm actions.)
    if (jsonMode) {
      const code = err instanceof ProjectResolutionError ? 'PROJECT_UNRESOLVED'
        : err instanceof StoreUnreadableError ? 'STORE_UNREADABLE'
        : isStoreIoError(err) ? 'IO'
        : err instanceof KeyCollisionError ? err.code
        : 'RUNTIME';
      failJson(code, err instanceof Error ? err.message : String(err));
    } else if (err instanceof StoreUnreadableError || err instanceof ProjectResolutionError || isStoreIoError(err) || err instanceof KeyCollisionError) {
      // An expected, self-explaining failure: its message, not a stack trace
      // (#249: confirm and alias set/remove reach here outside a project;
      // #261: a store lock another process held for the whole wait; #271: a
      // store file the filesystem would not write; #279: an alias named
      // after an entry, from alias set/rename).
      originalConsoleError.call(console, `${color.red('✗ ')}${err.message}`);
      process.exitCode = 1;
    } else {
      throw err;
    }
  } finally {
    // Always restore stdout.write before reading the measurement, so any
    // logging from the wrapper itself (or the audit/telemetry write paths
    // below) doesn't pollute the count or get measured as response.
    process.stdout.write = originalStdoutWrite;
    if (isBun) {
      console.log = originalConsoleLog;
      console.error = originalConsoleError;
    }
    const measuredResponseSize = endResponseMeasure();

    // Failed if it threw, or left a non-zero exit code. A handler that
    // assigns the exit code 0 — `run` in JSON mode passes on its command's —
    // has not failed. An earlier failure still fails the process: its code
    // comes back unless this call set one of its own. Restored here, before
    // the envelope is built, because the envelope's `ok` reads the exit code.
    const ownExitCode = process.exitCode ?? 0;
    if (success) success = ownExitCode === 0;
    if (failedBefore && ownExitCode === 0) process.exitCode = prevExitCode;
    // #215: most commands render a refused write through handleError, so the
    // catch above never sees it. Read (and always clear) the note it left.
    if (takeWriteRefused() && refusedReason === undefined) refusedReason = 'store_unreadable';

    const duration = Date.now() - startTime;

    // After-value derivation: shared with the MCP wrapper via deriveAfterValue.
    let after: string | undefined;
    if (isWrite && success && !BULK_OPS.has(ctx.tool)) {
      after = deriveAfterValue(ctx.tool, {
        writeValue: ctx.writeValue,
        before,
        copySourceValue,
        aliasPath: (ctx.params?.path as string | undefined) ?? (ctx.params?.target as string | undefined),
        key: ctx.key,
        scope,
      });
    } else if (isWrite && BULK_OPS.has(ctx.tool) && success) {
      after = captureBulkCount(scope);
    }

    // The code the failure was reported with (#203): what the handler passed
    // to printError / failJson, else the class of what it threw, else RUNTIME
    // for an exit code set with no report — the same fallback the envelope
    // uses. Always taken, so a code never outlives its call. A text-mode
    // failure path that sets the exit code itself must call recordErrorCode
    // with the code its JSON branch reports, or the two modes disagree.
    const reportedCode = takeErrorCode();
    const errorCode = success ? undefined : (reportedCode ?? thrownCode ?? 'RUNTIME');

    const requestSize = ctx.params ? Buffer.byteLength(JSON.stringify(ctx.params), 'utf8') : undefined;

    // Hit detection for reads
    let hit: boolean | undefined;
    if (op === 'read') {
      // If the handler returned a search result shape, use it
      if (result && typeof result === 'object' && ('dataCount' in (result as object) || 'aliasCount' in (result as object))) {
        const r = result as { dataCount?: number; aliasCount?: number };
        const entryCount = (r.dataCount ?? 0) + (r.aliasCount ?? 0);
        hit = entryCount > 0;
      } else {
        hit = success;
      }
    }

    const redundant = isRedundantWrite(ctx.tool, op, ctx.params, before, after);

    // Entry count for reads (from search results or generic)
    let entryCount: number | undefined;
    if (op === 'read' && result && typeof result === 'object' && ('dataCount' in (result as object) || 'aliasCount' in (result as object))) {
      const r = result as { dataCount?: number; aliasCount?: number };
      entryCount = (r.dataCount ?? 0) + (r.aliasCount ?? 0);
    }

    // Unreadable store files (#215). Whatever this command's own reads
    // turned up — no extra scan — is reported: warnings[] in JSON mode,
    // stderr otherwise, minus any file the command's own output or its
    // error already named.
    try {
      const unreadable = listUnreadableFiles();
      const unshown = withoutShown(unreadable);
      if (jsonMode) {
        // warnings[] is the machine channel: every file, whatever the result
        // or error already says — once per envelope, however many calls a
        // batch runs into it.
        for (const file of unreadable) {
          const message = unreadableWarning(file);
          if (!hasWarning(message, 'STORE_UNREADABLE')) addWarning(message, 'STORE_UNREADABLE');
        }
      } else {
        for (const line of unreadableWarningBlock(unshown)) console.error(line);
      }
    } catch { /* reporting must not break the command */ }

    // Write-amp guard on CLI set (#119/#101). Disk-backed when a shared
    // session (RVR_SESSION, or one detected from the harness — #207) bridges
    // invocations; in-memory (never trips for a one-shot process) otherwise. The write itself already succeeded —
    // the warning is advisory and must never fail the command, so the
    // whole block is best-effort.
    // Only a stored value counts. The handler marks it (markValueStored), so
    // a metadata-only `set`, a declined overwrite and an unchanged `edit` do
    // not take a slot. Taken on every invocation so a mark never outlives it.
    const valueStored = takeValueStored();
    let writeAmp: WriteAmpResult | null = null;
    if (ctx.tool === 'reverie_set' && success && ctx.key && valueStored) {
      try {
        // Counted per store: the same key in another project, or in the
        // global store, is another entry.
        writeAmp = recordCliWrite(ctx.key, Date.now(), writeAmpStore(scope, findProjectFile()));
      } catch { /* guardrail bookkeeping must not break a set */ }
      if (writeAmp) {
        const message = formatWriteAmpWarning(writeAmp);
        if (jsonMode) {
          addWarning(message, 'WRITE_AMP', writeAmp.count);
        } else {
          // Human mode: stderr, so scripts capturing stdout stay clean.
          console.error(`warning: ${message}`);
        }
      }
    }

    // #120: derive the envelope result from the handler's return value.
    // Populating `result` stops being per-site setResult discipline —
    // a handler that returns its payload gets it into the envelope.
    // Explicit setResult/failJson still win (handlers that need a result
    // alongside an error, or a result shaped differently from the value
    // they return to the wrapper for hit detection, e.g. searchEntries).
    // Done before the rows are written so the envelope can be measured.
    if (jsonMode && success && !hasError() && result !== undefined && !hasResult()) {
      setResult(result);
    }

    // Bytes returned to the caller, the MCP wrapper's semantic. In text mode
    // that is what the handler printed: its stdout, and under Bun also what
    // it wrote through console.error, which the measurement above counts. In
    // JSON mode the handler's stdout is swallowed and the caller receives the
    // envelope, which is written below, after the rows — so it is serialized
    // here, once, and that string is what gets written (#192). Every warning
    // has been added by this point.
    let envelopeLine: string | undefined;
    let responseSize = measuredResponseSize;
    if (jsonMode && ctx.deferEnvelope) {
      responseSize = 0;
    } else if (jsonMode && !alreadyEmitted()) {
      try {
        envelopeLine = serializeEnvelope();
        responseSize = Buffer.byteLength(envelopeLine, 'utf8');
      } catch {
        // A result that cannot be serialized. The rows are still written;
        // the emit below raises the error, as it did before this was measured.
      }
    }

    // Telemetry
    const projectFile = findProjectFile();
    const resolvedScope: 'project' | 'global' | undefined = scope === 'auto'
      ? (projectFile ? 'project' : 'global')
      : scope;
    // #99: rescuedByExplicitGlobal — the call succeeded with explicit
    // scope:'global' but would have refused under scope:'auto' because
    // project resolution failed. Mirrors the MCP-side telemetry signal.
    const rescuedByExplicitGlobal = isWrite && scope === 'global' && !projectFile ? true : undefined;
    // Shape/degradation signals recorded by the command (#188): the same
    // fields the MCP wrapper gets through its guardrail channel.
    const signals = takeSignals();
    const telemetryExtras: TelemetryExtras = {
      duration,
      hit,
      redundant,
      responseSize,
      success,
      ...(errorCode !== undefined && { errorCode }),
      project: projectFile ? path.dirname(projectFile) : undefined,
      refusedReason,
      rescuedByExplicitGlobal,
      writeAmpWarning: writeAmp ? true : undefined,
      writeAmpCount: writeAmp?.count,
      selfRef,
      ...signals,
    };
    void logToolCall(ctx.tool, ctx.key, 'cli', resolvedScope, telemetryExtras, true);

    // Audit
    void logAudit({
      src: 'cli',
      tool: ctx.tool,
      op,
      key: ctx.key,
      scope: scope === 'auto' ? 'auto' : scope,
      success,
      before: isWrite ? before : undefined,
      after: isWrite ? after : undefined,
      error: errorMsg,
      ...(errorCode !== undefined && { errorCode }),
      duration,
      aliasResolved,
      responseSize,
      requestSize,
      hit,
      entryCount,
      redundant,
      params: ctx.params ? sanitizeParams(ctx.params) : undefined,
      refusedReason,
      rescuedByExplicitGlobal,
      writeAmpWarning: writeAmp ? true : undefined,
      writeAmpCount: writeAmp?.count,
      selfRef,
      ...signals,
    }, true);

    // Miss-path tracking on CLI reads (#119). Only meaningful when a shared
    // session bridges invocations (trackCliMissPath no-ops otherwise —
    // a window that dies with a one-shot process would log pure noise).
    // A config call is not a lookup (#206): its key is a setting name, so it
    // opens no miss window and closes none.
    try {
      const closedPaths = !keyIsEntryKey(ctx.tool) ? [] : trackCliMissPath({
        tool: ctx.tool,
        namespace: extractNamespace(ctx.key),
        key: ctx.key ?? '',
        op,
        hit,
        responseSize: responseSize ?? 0,
        agent: resolveAgentIdentity().agent,
        agentDetected: resolveAgentIdentity().agentDetected,
      });
      for (const mp of closedPaths) {
        void appendMissPath(mp);
      }
    } catch { /* observability must not break the command */ }

    // Emit the single structured envelope (#117 WS1). stdout.write has been
    // restored above, so we hand emitEnvelope the original writer to be sure
    // the envelope reaches the real stdout regardless of patch state. ok and
    // any error are derived inside buildEnvelope from exitCode + recorded
    // failure. Idempotent: a no-op if something already emitted.
    if (jsonMode && !ctx.deferEnvelope) {
      emitEnvelope((s) => { (originalStdoutWrite as (...a: StdoutWriteArgs) => boolean)(s); }, envelopeLine);
    }
  }

  // In JSON mode a swallowed error returns undefined here (callers discard the
  // value — they pass `() => commands.xxx()` whose result is unused). The cast
  // keeps the Promise<T> contract; the non-JSON path always assigned `result`.
  return result as T;
}
