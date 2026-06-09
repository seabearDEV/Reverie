import path from 'path';
import { formatWithOptions } from 'node:util';
import { Scope } from '../store';
import { getValue, getEntriesFlat } from '../storage';
import { loadAliases, resolveKey } from '../alias';
import { sanitizeValue, sanitizeParams, logAudit } from './audit';
import { logToolCall, classifyOp, TelemetryExtras, extractNamespace, appendMissPath } from './telemetry';
import { recordCliWrite, trackCliMissPath } from './sessionState';
import { formatWriteAmpWarning, WriteAmpResult } from './writeAmp';
import { findProjectFile } from '../store';
import { startResponseMeasure, addResponseBytes, endResponseMeasure } from './responseMeasure';
import { ProjectResolutionError } from '../projectResolution';
import { isJsonMode, failJson, emitEnvelope, addWarning, setResult, hasResult, hasError } from './output';

// ── Shared constants (used by both MCP and CLI wrappers) ─────────────

/** Tools that should not be audited (observability-only commands) */
export const SKIP_AUDIT = new Set(['reverie_stats', 'reverie_audit']);

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
    // Alias operations: capture the alias target by alias name
    if (tool === 'reverie_alias_set' || tool === 'reverie_alias_remove') {
      const aliases = loadAliases(scope);
      return aliases[key];
    }
    // Resolve alias before store lookup so audit reflects the actual mutated entry
    const resolvedKey = resolveKey(key, scope);
    const val = getValue(resolvedKey, scope);
    if (val === undefined) return undefined;
    return sanitizeValue(typeof val === 'object' ? JSON.stringify(val) : String(val));
  } catch { return undefined; }
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
  // Skip audit for observability-only tools
  if (SKIP_AUDIT.has(ctx.tool)) {
    return await Promise.resolve(fn());
  }

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
    // Pre-capture source value for copy
    if (ctx.tool === 'reverie_copy' && ctx.copySourceKey) {
      try {
        const resolved = resolveKey(ctx.copySourceKey, scope);
        const val = getValue(resolved, scope);
        copySourceValue = val !== undefined
          ? sanitizeValue(typeof val === 'object' ? JSON.stringify(val) : String(val))
          : undefined;
      } catch { /* ignore */ }
    }
  } else if (isWrite && BULK_OPS.has(ctx.tool)) {
    try {
      const count = Object.keys(getEntriesFlat(scope)).length;
      before = `${count} entries`;
    } catch { /* ignore */ }
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

  // Execute handler
  const prevExitCode = process.exitCode;
  let result: T | undefined;
  let success = true;
  let errorMsg: string | undefined;
  let refusedReason: string | undefined;
  try {
    result = await Promise.resolve(fn());
  } catch (err) {
    success = false;
    errorMsg = String(err);
    if (err instanceof ProjectResolutionError) {
      refusedReason = 'project_unresolved';
    }
    // In JSON mode an uncaught throw must still surface as a structured
    // envelope rather than crashing the process with a non-envelope stack
    // trace. Record it and fall through to the finally emit. (Most commands
    // catch internally via handleError; this covers direct-call handlers
    // like the inline alias/confirm actions.)
    if (jsonMode) {
      const code = err instanceof ProjectResolutionError ? 'PROJECT_UNRESOLVED' : 'RUNTIME';
      failJson(code, err instanceof Error ? err.message : String(err));
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

    if (success) {
      success = process.exitCode === prevExitCode;
    }

    const duration = Date.now() - startTime;

    // After-value derivation (same strategy as MCP — derive from params, not re-read)
    let after: string | undefined;
    if (isWrite && success && !BULK_OPS.has(ctx.tool)) {
      if (ctx.tool === 'reverie_set' || ctx.tool === 'reverie_config_set') {
        after = sanitizeValue(ctx.writeValue);
      } else if (ctx.tool === 'reverie_copy') {
        after = copySourceValue;
      } else if (ctx.tool === 'reverie_rename') {
        after = before; // Value preserved on rename
      } else if (ctx.tool === 'reverie_remove' || ctx.tool === 'reverie_alias_remove') {
        after = undefined; // Deleted
      } else if (ctx.tool === 'reverie_alias_set') {
        after = ctx.params?.path as string | undefined ?? ctx.params?.target as string | undefined;
      } else {
        // Fallback: re-read
        after = captureValue(ctx.tool, ctx.key, scope);
      }
    } else if (isWrite && BULK_OPS.has(ctx.tool) && success) {
      try {
        const count = Object.keys(getEntriesFlat(scope)).length;
        after = `${count} entries`;
      } catch { /* ignore */ }
    }

    // Compute metrics. responseSize is the actual stdout byte count
    // captured by the wrapper above (matches the MCP wrapper's "bytes
    // returned to caller" semantic). Falls back to undefined if no
    // measurement happened (shouldn't occur in practice — every code
    // path through this wrapper installs a measurement).
    const responseSize = measuredResponseSize;
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

    // Redundant write detection
    const isReadOnlyWrite = ctx.tool === 'reverie_rename' ||
      (ctx.tool === 'reverie_run' && ctx.params?.dry === true);
    const redundant = isWrite && !isReadOnlyWrite && before !== undefined && after !== undefined && before === after
      ? true
      : undefined;

    // Entry count for reads (from search results or generic)
    let entryCount: number | undefined;
    if (op === 'read' && result && typeof result === 'object' && ('dataCount' in (result as object) || 'aliasCount' in (result as object))) {
      const r = result as { dataCount?: number; aliasCount?: number };
      entryCount = (r.dataCount ?? 0) + (r.aliasCount ?? 0);
    }

    // Write-amp guard on CLI set (#119/#101). Disk-backed when RVR_SESSION
    // bridges invocations into one session; in-memory (never trips for a
    // one-shot process) otherwise. The write itself already succeeded —
    // the warning is advisory and must never fail the command, so the
    // whole block is best-effort.
    let writeAmp: WriteAmpResult | null = null;
    if (ctx.tool === 'reverie_set' && success && ctx.key) {
      try {
        writeAmp = recordCliWrite(ctx.key);
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

    // Telemetry
    const projectFile = findProjectFile();
    const resolvedScope: 'project' | 'global' | undefined = scope === 'auto'
      ? (projectFile ? 'project' : 'global')
      : scope;
    // #99: rescuedByExplicitGlobal — the call succeeded with explicit
    // scope:'global' but would have refused under scope:'auto' because
    // project resolution failed. Mirrors the MCP-side telemetry signal.
    const rescuedByExplicitGlobal = isWrite && scope === 'global' && !projectFile ? true : undefined;
    const telemetryExtras: TelemetryExtras = {
      duration,
      hit,
      redundant,
      responseSize,
      project: projectFile ? path.dirname(projectFile) : undefined,
      refusedReason,
      rescuedByExplicitGlobal,
      writeAmpWarning: writeAmp ? true : undefined,
      writeAmpCount: writeAmp?.count,
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
    }, true);

    // Miss-path tracking on CLI reads (#119). Only meaningful when
    // RVR_SESSION bridges invocations (trackCliMissPath no-ops otherwise —
    // a window that dies with a one-shot process would log pure noise).
    try {
      const closedPaths = trackCliMissPath({
        tool: ctx.tool,
        namespace: extractNamespace(ctx.key),
        key: ctx.key ?? '',
        op,
        hit,
        responseSize: responseSize ?? 0,
        agent: process.env.RVR_AGENT_NAME,
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
    if (jsonMode) {
      // #120: derive the envelope result from the handler's return value.
      // Populating `result` stops being per-site setResult discipline —
      // a handler that returns its payload gets it into the envelope.
      // Explicit setResult/failJson still win (handlers that need a result
      // alongside an error, or a result shaped differently from the value
      // they return to the wrapper for hit detection, e.g. searchEntries).
      if (success && !hasError() && result !== undefined && !hasResult()) {
        setResult(result);
      }
      emitEnvelope((s) => { (originalStdoutWrite as (...a: StdoutWriteArgs) => boolean)(s); });
    }
  }

  // In JSON mode a swallowed error returns undefined here (callers discard the
  // value — they pass `() => commands.xxx()` whose result is unused). The cast
  // keeps the Promise<T> contract; the non-JSON path always assigned `result`.
  return result as T;
}
