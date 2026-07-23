import path from 'path';
import { getDataDirectory, findProjectFile } from './paths';
import { getSessionId } from './session';
import { createJsonlLog } from './jsonl';
import { isTestRun } from './testTraffic';
import { getProjectId } from './projectId';
import { resolveAgentIdentity } from './agentIdentity';

export interface TelemetryEntry {
  ts: number;
  tool: string;
  session: string;
  op: 'read' | 'write' | 'remove' | 'exec' | 'meta';
  ns: string;
  src?: 'mcp' | 'cli';
  scope?: 'project' | 'global' | undefined;
  project?: string | undefined;
  /** Canonical project identity (#141): git origin URL normalized to
   *  host/owner/repo, falling back to the project path. Grouping key for
   *  projectBreakdown; `project` stays the raw path for filtering. */
  projectId?: string | undefined;
  duration?: number | undefined;
  hit?: boolean | undefined;
  redundant?: boolean | undefined;
  responseSize?: number | undefined;
  agent?: string | undefined;
  /** True when agent came from env fingerprinting rather than an explicit
   *  RVR_AGENT_NAME (#138) — a confidence signal, not an identity change. */
  agentDetected?: boolean | undefined;
  /** Whether the operation succeeded. Optional for backward compat with
   *  pre-v1.11.x telemetry that didn't carry this field. */
  success?: boolean | undefined;
  /** Refusal reason on failed writes (#99). Currently the only value is
   *  'project_unresolved' for ProjectResolutionError refusals; future codes
   *  can be added here as additional guardrails land. */
  refusedReason?: string | undefined;
  /** True when an explicit `scope: 'global'` succeeded on a call that would
   *  have refused under `scope: 'auto'` because project resolution failed.
   *  Lets us measure how often the explicit-scope escape hatch is used (#99). */
  rescuedByExplicitGlobal?: boolean | undefined;
  /** reverie_context only: true when the response was trimmed to fit the
   *  bootstrap_max_response_bytes budget (#100). */
  degraded?: boolean | undefined;
  /** reverie_context only: priority labels of namespaces shed when degraded
   *  fired (#100). E.g. `["files.*", "arch.*"]`. */
  shedNamespaces?: string[] | undefined;
  /** reverie_set only: true when the same key was written ≥3 times in this
   *  session within a 30-min window (#101). */
  writeAmpWarning?: boolean | undefined;
  /** reverie_set only: count of in-window writes when writeAmpWarning fired (#101). */
  writeAmpCount?: number | undefined;
  /** True when the row was produced under RVR_TEST (#130). Excluded from
   *  stats by default; pre-tag historical test rows remain untagged. */
  test?: boolean | undefined;
  /** True for observability-tool calls (reverie_stats/reverie_audit, #134).
   *  Logged so the record is complete, excluded from aggregates so they
   *  never count the act of looking at them. */
  selfRef?: boolean | undefined;
}

// Re-export for backward compatibility — anything that previously imported
// getSessionId from telemetry continues to work, but the canonical source is
// now src/utils/session.ts (shared with audit).
export { getSessionId } from './session';

export function getTelemetryPath(): string {
  return path.join(getDataDirectory(), 'telemetry.jsonl');
}

// ── Miss-path tracking ──────────────────────────────────────────────

export interface MissPath {
  ts: number;
  session: string;
  namespace: string;
  key: string;
  toolCalls: number;
  explorationBytes: number;
  resolution: 'writeback' | 'moved_on' | 'timeout';
  resolvedAt: number;
  agent?: string | undefined;
}

export function getMissPathsPath(): string {
  return path.join(getDataDirectory(), 'miss-paths.jsonl');
}

// Shared append-only JSONL machinery (incremental tail cache, 0o600
// appends) lives in src/utils/jsonl.ts — same factory backs audit.jsonl.
const missPathLog = createJsonlLog<MissPath>(getMissPathsPath);

export function appendMissPath(record: MissPath, sync = false): Promise<void> {
  return missPathLog.append(record, sync);
}

export function loadMissPaths(): MissPath[] {
  return missPathLog.load();
}

// ── Miss-window tracker (pure state machine, no I/O) ────────────────

export interface OpenMissWindow {
  ts: number;
  session: string;
  namespace: string;
  key: string;
  toolCalls: number;
  explorationBytes: number;
  agent?: string | undefined;
}

const MISS_WINDOW_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export class MissWindowTracker {
  private windows = new Map<string, OpenMissWindow>();

  /**
   * Called after every tool call on either surface — directly by the MCP
   * wrapper, per CLI invocation via sessionState's trackCliMissPath (#119).
   * Returns closed MissPath records (if any). A single call can close
   * multiple windows (e.g. timeout sweep + writeback).
   */
  onToolCall(params: {
    session: string;
    tool: string;
    namespace: string;
    key: string;
    op: string;
    hit: boolean | undefined;
    responseSize: number;
    agent?: string | undefined;
  }): MissPath[] {
    const now = Date.now();
    const closed: MissPath[] = [];

    // 1. Timeout sweep: close windows older than 5 minutes
    for (const [wk, w] of this.windows) {
      if (now - w.ts > MISS_WINDOW_TIMEOUT_MS) {
        closed.push(this.closeWindow(wk, 'timeout', now));
      }
    }

    // 2. Close as moved_on: a hit on any namespace means the agent found what it needed
    if (params.hit === true) {
      for (const [wk, w] of this.windows) {
        if (w.session === params.session) {
          closed.push(this.closeWindow(wk, 'moved_on', now));
        }
      }
    }

    // 3. Close as writeback: reverie_set to same session+namespace
    if (params.tool === 'reverie_set') {
      const wk = `${params.session}:${params.namespace}`;
      if (this.windows.has(wk)) {
        closed.push(this.closeWindow(wk, 'writeback', now));
      }
    }

    // 4. Accumulate: for all remaining open windows in this session, tally the call
    for (const [, w] of this.windows) {
      if (w.session === params.session) {
        w.toolCalls++;
        w.explorationBytes += params.responseSize;
      }
    }

    // 5. Open new window: read miss with no existing window for this session+namespace
    if (params.op === 'read' && params.hit === false) {
      const wk = `${params.session}:${params.namespace}`;
      if (!this.windows.has(wk)) {
        this.windows.set(wk, {
          ts: now,
          session: params.session,
          namespace: params.namespace,
          key: params.key,
          toolCalls: 0,
          explorationBytes: 0,
          agent: params.agent,
        });
      }
    }

    return closed;
  }

  /**
   * Serialize open windows for the on-disk session state file (#119) so a
   * per-invocation CLI process can carry windows across invocations.
   */
  exportOpenWindows(): OpenMissWindow[] {
    return [...this.windows.values()].map(w => ({ ...w }));
  }

  /** Rehydrate windows persisted by a previous CLI invocation (#119). */
  restoreOpenWindows(windows: OpenMissWindow[]): void {
    for (const w of windows) {
      this.windows.set(`${w.session}:${w.namespace}`, { ...w });
    }
  }

  /** Flush all open windows as timeouts (call on shutdown). */
  flushAll(): MissPath[] {
    const now = Date.now();
    const closed: MissPath[] = [];
    for (const wk of [...this.windows.keys()]) {
      closed.push(this.closeWindow(wk, 'timeout', now));
    }
    return closed;
  }

  /** Number of currently open windows (for testing). */
  get openCount(): number {
    return this.windows.size;
  }

  private closeWindow(windowKey: string, resolution: MissPath['resolution'], now: number): MissPath {
    const w = this.windows.get(windowKey)!;
    this.windows.delete(windowKey);
    return {
      ts: w.ts,
      session: w.session,
      namespace: w.namespace,
      key: w.key,
      toolCalls: w.toolCalls,
      explorationBytes: w.explorationBytes,
      resolution,
      resolvedAt: now,
      agent: w.agent,
    };
  }
}

// ── Namespace extraction ────────────────────────────────────────────

/**
 * Extract the top-level namespace from a dot-notation key.
 * "arch.mcp" → "arch", undefined/empty → "*"
 */
export function extractNamespace(key?: string): string {
  if (!key) return '*';
  const dot = key.indexOf('.');
  return dot === -1 ? key : key.slice(0, dot);
}

/**
 * Estimated tokens an agent would spend exploring the codebase to find
 * the same information stored under each namespace. Conservative values.
 */
export const EXPLORATION_COST: Record<string, number> = {
  files: 2000,        // glob + grep + read (~3 tool calls)
  arch: 3000,         // multiple reads + reasoning (~5 calls)
  context: 3000,      // multiple reads + reasoning
  commands: 1000,     // grep + read package.json (~2 calls)
  conventions: 1500,  // reading multiple files for patterns
  project: 500,       // reading README/package.json
  deps: 800,          // reading package.json + docs
};
const DEFAULT_EXPLORATION_COST = 1000;
const BOOTSTRAP_PER_ENTRY_COST = 200;
const REDUNDANT_WRITE_COST = 150;
const MIN_OBSERVED_SAMPLES = 5;

export interface ExplorationCostResult {
  cost: number;
  source: 'observed' | 'static';
  samples: number;
}

/**
 * Get exploration cost for a namespace, preferring observed miss-path data.
 * Falls back to static EXPLORATION_COST when fewer than 5 writeback samples exist.
 */
export function getExplorationCost(namespace: string, missPaths?: MissPath[]): ExplorationCostResult {
  const relevant = (missPaths ?? []).filter(
    mp => mp.resolution === 'writeback' && mp.namespace === namespace,
  );
  if (relevant.length >= MIN_OBSERVED_SAMPLES) {
    const costs = relevant.map(mp => mp.explorationBytes / 4).sort((a, b) => a - b);
    const median = costs[Math.floor(costs.length / 2)];
    return { cost: Math.round(median), source: 'observed', samples: relevant.length };
  }
  return {
    cost: EXPLORATION_COST[namespace] ?? DEFAULT_EXPLORATION_COST,
    source: 'static',
    samples: relevant.length,
  };
}

/**
 * Classify an MCP tool call as read, write, exec, or meta.
 */
export function classifyOp(tool: string): TelemetryEntry['op'] {
  switch (tool) {
    case 'reverie_set':
    case 'reverie_copy':
    case 'reverie_rename':
    case 'reverie_import':
    case 'reverie_alias_set':
    case 'reverie_config_set':
    case 'reverie_confirm_set':
      return 'write';
    case 'reverie_remove':
    case 'reverie_alias_remove':
    case 'reverie_confirm_remove':
    case 'reverie_reset':
      return 'remove';
    case 'reverie_run':
      return 'exec';
    case 'reverie_context':
    case 'reverie_get':
    case 'reverie_find':
    case 'reverie_export':
    case 'reverie_alias_list':
    case 'reverie_config_get':
    case 'reverie_stale':
    case 'reverie_lint':
    case 'reverie_topology':
    case 'reverie_confirm_list':
      return 'read';
    case 'reverie_init':
      return 'write';
    default:
      return 'meta';
  }
}

/**
 * Log an MCP tool call to the telemetry JSONL file.
 * Returns a promise for testing; callers that want fire-and-forget can ignore it.
 * Errors are silently ignored — telemetry must never break the MCP server.
 */
export interface TelemetryExtras {
  project?: string | undefined;
  duration?: number | undefined;
  hit?: boolean | undefined;
  redundant?: boolean | undefined;
  responseSize?: number | undefined;
  success?: boolean | undefined;
  refusedReason?: string | undefined;
  rescuedByExplicitGlobal?: boolean | undefined;
  degraded?: boolean | undefined;
  shedNamespaces?: string[] | undefined;
  writeAmpWarning?: boolean | undefined;
  writeAmpCount?: number | undefined;
  selfRef?: boolean | undefined;
}

export function logToolCall(tool: string, key?: string, source: 'mcp' | 'cli' = 'mcp', scope?: 'project' | 'global', extras?: TelemetryExtras, sync = false): Promise<void> {
  // Self-resolve project if not provided (same as logAudit does)
  let project = extras?.project;
  if (project === undefined) {
    try {
      const pf = findProjectFile();
      project = pf ? path.dirname(pf) : undefined;
    } catch { /* best-effort */ }
  }
  const identity = resolveAgentIdentity();
  const entry: TelemetryEntry = {
    ts: Date.now(),
    tool,
    session: getSessionId(),
    op: classifyOp(tool),
    ns: extractNamespace(key),
    src: source,
    scope,
    agent: identity.agent,
    ...(identity.agentDetected && { agentDetected: true }),
    ...(isTestRun() && { test: true }),
    ...extras,
    project,
    ...(project !== undefined && { projectId: getProjectId(project) }),
  };
  return telemetryLog.append(entry, sync);
}

// Incremental tail cache shared with audit.jsonl — see src/utils/jsonl.ts.
const telemetryLog = createJsonlLog<TelemetryEntry>(getTelemetryPath);

/**
 * Read and parse the telemetry log. Returns entries in file order
 * (oldest-first, since new entries are appended to the log).
 */
export function loadTelemetry(): TelemetryEntry[] {
  return telemetryLog.load();
}

export interface TelemetryStats {
  period: string;
  totalCalls: number;
  mcpSessions: number;
  mcpCalls: number;
  cliCalls: number;
  bootstrapRate: number;
  writeBackRate: number;
  reads: number;
  writes: number;
  removes: number;
  execs: number;
  readWriteRatio: string;
  // Bulk-write segmentation (#142): burst runs (≥5 writes ≤1s apart) are a
  // distinct usage mode — bulk store population — not write indiscipline.
  bulkWrites: number;
  organicWrites: number;
  organicReadWriteRatio: string;
  namespaceCoverage: Record<string, { reads: number; writes: number; lastWrite: number | undefined }>;
  topTools: { tool: string; count: number }[];
  scopeBreakdown: { project: number; global: number; unscoped: number };
  // New metrics
  hitRate: number | undefined;
  hits: number;
  misses: number;
  redundantRate: number | undefined;
  redundantWrites: number;
  avgSessionCalls: number | undefined;
  avgSessionDurationMs: number | undefined;
  totalResponseBytes: number;
  avgResponseBytes: number | undefined;
  avgDurationMs: number | undefined;
  projectBreakdown: Record<string, number>;
  // Token savings
  estimatedTokensSaved: number;
  estimatedTokensSavedBootstrap: number;
  // Exploration-weighted token savings
  estimatedExplorationTokensSaved: number;
  estimatedRedundantWriteTokensSaved: number;
  estimatedTotalTokensSaved: number;
  explorationBreakdown: Record<string, { hits: number; tokensSaved: number }>;
  // Net savings (delivery cost subtracted)
  deliveryCostTokens: number;
  netTokensSaved: number;
  // Calibration: observed vs static cost source per namespace
  calibration: Record<string, ExplorationCostResult>;
  // Agent breakdown
  agentBreakdown: Record<string, { calls: number; reads: number; writes: number }>;
  // Trend comparison (vs previous period)
  trend: TelemetryTrend | undefined;
}

export interface TelemetryTrend {
  callsDelta: number | undefined;       // percentage change
  sessionsDelta: number | undefined;
  hitRateDelta: number | undefined;     // absolute change in percentage points
  avgDurationDelta: number | undefined; // percentage change
}

/** Compute percentage change: (current - previous) / previous * 100 */
function pctChange(current: number, previous: number): number | undefined {
  if (previous === 0) return current > 0 ? 100 : undefined;
  return ((current - previous) / previous) * 100;
}

/**
 * Compute trending stats from telemetry entries.
 * @param periodDays - Number of days to analyze (0 = all time)
 * @param includeTest - Include RVR_TEST-tagged rows (#130). Default false:
 *   stats reflect real agent activity. Applies to the trend window too.
 */
export function computeStats(periodDays = 0, includeTest = false): TelemetryStats {
  const raw = loadTelemetry();
  // selfRef rows (#134) are never aggregated — stats about using stats would
  // recursively inflate every run. The raw log keeps them for watchers.
  const all = raw.filter(e => e.selfRef !== true && (includeTest || e.test !== true));
  const cutoff = periodDays > 0 ? Date.now() - periodDays * 86400000 : 0;
  const entries = cutoff > 0 ? all.filter(e => e.ts >= cutoff) : all;

  // Separate MCP and CLI entries (entries without src field are legacy MCP)
  const mcpEntries = entries.filter(e => e.src !== 'cli');
  const cliEntries = entries.filter(e => e.src === 'cli');

  // MCP session metrics (bootstrap rate, write-back rate only apply to MCP)
  const mcpSessionData = new Map<string, TelemetryEntry[]>();
  for (const e of mcpEntries) {
    if (!mcpSessionData.has(e.session)) mcpSessionData.set(e.session, []);
    mcpSessionData.get(e.session)!.push(e);
  }

  let bootstrapped = 0;
  for (const [, calls] of mcpSessionData) {
    const sorted = [...calls].sort((a, b) => a.ts - b.ts);
    if (sorted[0]?.tool === 'reverie_context') bootstrapped++;
  }

  let wroteBack = 0;
  for (const [, calls] of mcpSessionData) {
    if (calls.some(c => c.op === 'write')) wroteBack++;
  }

  const reads = entries.filter(e => e.op === 'read').length;
  const writes = entries.filter(e => e.op === 'write').length;
  const removes = entries.filter(e => e.op === 'remove').length;
  const execs = entries.filter(e => e.op === 'exec').length;

  // Bulk-write segmentation (#142). Detection is time-based over ALL writes
  // rather than per-session: un-bridged CLI bulk runs carry a different
  // session id per call (one session per process), so session grouping would
  // miss exactly the runs this exists to find. Two agents organically
  // interleaving writes <1s apart on one machine is rare enough to accept.
  const BULK_GAP_MS = 1000;
  const BULK_MIN_RUN = 5;
  const writeRows = entries.filter(e => e.op === 'write').sort((a, b) => a.ts - b.ts);
  let bulkWrites = 0;
  let runStart = 0;
  for (let i = 1; i <= writeRows.length; i++) {
    if (i === writeRows.length || writeRows[i].ts - writeRows[i - 1].ts > BULK_GAP_MS) {
      const runLen = i - runStart;
      if (runLen >= BULK_MIN_RUN) bulkWrites += runLen;
      runStart = i;
    }
  }
  const organicWrites = writes - bulkWrites;

  // Namespace coverage
  // Filter noise from the namespace dashboard:
  //   - failed operations (e.g. rejected validator writes like `_aliases`,
  //     `flog/`, `__proto__`) should not show up as "namespace activity"
  //   - reverie_find keys are search terms (regex, substring) — they're not
  //     namespaces, but extractNamespace would happily slice them on `.`
  //     and produce phantom namespaces like `^arch\` or `flog/`
  //   - reverie_alias_set / reverie_alias_remove keys are alias names, not entry
  //     namespaces. Counting them produced 1-write "namespaces" like
  //     `flog_test_alias` or `chk` in the dashboard.
  // Older telemetry entries without `success` are kept for backward compat.
  // Null-prototype: telemetry `ns` values are user-controlled (and historical
  // logs may contain `__proto__` / `constructor` / `prototype` from rejected
  // writes recorded before the success-filter was added). A plain `{}` would
  // resolve `nsCoverage['__proto__']` to Object.prototype, skip the init
  // branch, then mutate Object.prototype itself when we increment counters —
  // poisoning every object in the process and silently breaking the MCP SDK's
  // request dispatch on the next call. Same applies to the other dict-shaped
  // accumulators below.
  const nsCoverage = Object.create(null) as Record<string, { reads: number; writes: number; lastWrite: number | undefined }>;
  for (const e of entries) {
    if (e.ns === '*') continue;
    if (e.success === false) continue;
    if (e.tool === 'reverie_find') continue;
    if (e.tool === 'reverie_alias_set' || e.tool === 'reverie_alias_remove') continue;
    if (!nsCoverage[e.ns]) nsCoverage[e.ns] = { reads: 0, writes: 0, lastWrite: undefined };
    if (e.op === 'read') nsCoverage[e.ns].reads++;
    if (e.op === 'write') {
      nsCoverage[e.ns].writes++;
      const prev = nsCoverage[e.ns].lastWrite;
      if (prev === undefined || e.ts > prev) nsCoverage[e.ns].lastWrite = e.ts;
    }
  }

  // Top tools
  const toolCounts = new Map<string, number>();
  for (const e of entries) {
    toolCounts.set(e.tool, (toolCounts.get(e.tool) ?? 0) + 1);
  }
  const topTools = [...toolCounts.entries()]
    .map(([tool, count]) => ({ tool, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  // Scope breakdown
  const scopeBreakdown = { project: 0, global: 0, unscoped: 0 };
  for (const e of entries) {
    if (e.scope === 'project') scopeBreakdown.project++;
    else if (e.scope === 'global') scopeBreakdown.global++;
    else scopeBreakdown.unscoped++;
  }

  // Project breakdown — null-prototype, see nsCoverage rationale above.
  // Grouped by canonical projectId (#141) so path variants of the same repo
  // count as one project; pre-#141 rows have no projectId and group by path.
  const projectBreakdown = Object.create(null) as Record<string, number>;
  for (const e of entries) {
    const id = e.projectId ?? e.project;
    if (id) {
      projectBreakdown[id] = (projectBreakdown[id] ?? 0) + 1;
    }
  }

  // Hit/miss rate (reads with hit field set)
  const readsWithHit = entries.filter(e => e.op === 'read' && e.hit !== undefined);
  const hits = readsWithHit.filter(e => e.hit === true).length;
  const misses = readsWithHit.filter(e => e.hit === false).length;
  const hitRate = readsWithHit.length > 0 ? hits / readsWithHit.length : undefined;

  // Redundant write rate
  const writesWithRedundant = entries.filter(e => e.op === 'write' && e.redundant !== undefined);
  const redundantWrites = writesWithRedundant.filter(e => e.redundant === true).length;
  const redundantRate = writes > 0 ? redundantWrites / writes : undefined;

  // Avg session calls
  const avgSessionCalls = mcpSessionData.size > 0 ? mcpEntries.length / mcpSessionData.size : undefined;

  // Avg session duration (ms between first and last call per session)
  const sessionDurations: number[] = [];
  for (const [, calls] of mcpSessionData) {
    if (calls.length < 2) continue;
    const sorted = [...calls].sort((a, b) => a.ts - b.ts);
    sessionDurations.push(sorted[sorted.length - 1].ts - sorted[0].ts);
  }
  const avgSessionDurationMs = sessionDurations.length > 0
    ? sessionDurations.reduce((a, b) => a + b, 0) / sessionDurations.length
    : undefined;

  // Token-efficiency: total and avg response bytes
  const responseSizes = entries.filter(e => e.responseSize !== undefined).map(e => e.responseSize!);
  const totalResponseBytes = responseSizes.reduce((a, b) => a + b, 0);
  const avgResponseBytes = responseSizes.length > 0 ? totalResponseBytes / responseSizes.length : undefined;

  // Avg duration
  const durations = entries.filter(e => e.duration !== undefined).map(e => e.duration!);
  const avgDurationMs = durations.length > 0
    ? durations.reduce((a, b) => a + b, 0) / durations.length
    : undefined;

  const mcpSessions = mcpSessionData.size;
  const period = periodDays > 0 ? `${periodDays}d` : 'all';

  // Token savings estimate: response bytes from cache hits / ~4 bytes per token
  const estimatedTokensSaved = Math.round(
    entries
      .filter(e => e.op === 'read' && e.hit === true && e.responseSize !== undefined)
      .reduce((sum, e) => sum + e.responseSize!, 0) / 4
  );
  const estimatedTokensSavedBootstrap = Math.round(
    entries
      .filter(e => e.tool === 'reverie_context' && e.hit === true && e.responseSize !== undefined)
      .reduce((sum, e) => sum + e.responseSize!, 0) / 4
  );

  // Exploration-weighted token savings (namespace-aware, calibrated when possible)
  // Null-prototype, see nsCoverage rationale above.
  const explorationBreakdown = Object.create(null) as Record<string, { hits: number; tokensSaved: number }>;
  const calibration = Object.create(null) as Record<string, ExplorationCostResult>;
  let estimatedExplorationTokensSaved = 0;

  // Load miss-path data once for calibration
  const missPathCache = loadMissPaths();

  const readHits = entries.filter(e => e.op === 'read' && e.hit === true);
  for (const e of readHits) {
    if (e.tool === 'reverie_context') {
      // Bootstrap: approximate entry count from response size, each avoids ~1 lookup
      const deliveryCost = (e.responseSize ?? 0) / 4;
      const approxEntries = Math.round((e.responseSize ?? 0) / 80);
      const explorationCost = Math.max(deliveryCost, approxEntries * BOOTSTRAP_PER_ENTRY_COST);
      const rounded = Math.round(explorationCost);
      const bsKey = 'bootstrap';
      if (!explorationBreakdown[bsKey]) explorationBreakdown[bsKey] = { hits: 0, tokensSaved: 0 };
      explorationBreakdown[bsKey].hits++;
      explorationBreakdown[bsKey].tokensSaved += rounded;
      estimatedExplorationTokensSaved += rounded;
    } else {
      const ns = e.ns === '*' ? 'other' : e.ns;
      // Memoized per namespace — getExplorationCost filters + sorts the whole
      // miss-path array, so calling it per read-hit row is quadratic.
      const costResult = calibration[ns] ??= getExplorationCost(ns, missPathCache);
      if (!explorationBreakdown[ns]) explorationBreakdown[ns] = { hits: 0, tokensSaved: 0 };
      explorationBreakdown[ns].hits++;
      explorationBreakdown[ns].tokensSaved += costResult.cost;
      estimatedExplorationTokensSaved += costResult.cost;
    }
  }

  const estimatedRedundantWriteTokensSaved = redundantWrites * REDUNDANT_WRITE_COST;
  const estimatedTotalTokensSaved = estimatedExplorationTokensSaved + estimatedRedundantWriteTokensSaved;

  // Net savings: gross exploration avoided minus delivery cost (tokens consumed by cache hits)
  const deliveryCostTokens = estimatedTokensSaved; // raw bytes served ÷ 4
  const netTokensSaved = estimatedTotalTokensSaved - deliveryCostTokens;

  // Agent breakdown — null-prototype, see nsCoverage rationale above.
  const agentBreakdown = Object.create(null) as Record<string, { calls: number; reads: number; writes: number }>;
  for (const e of entries) {
    const agent = e.agent;
    if (!agent) continue;
    if (!agentBreakdown[agent]) agentBreakdown[agent] = { calls: 0, reads: 0, writes: 0 };
    agentBreakdown[agent].calls++;
    if (e.op === 'read') agentBreakdown[agent].reads++;
    if (e.op === 'write') agentBreakdown[agent].writes++;
  }

  // Trend comparison: compute stats for the previous period of the same length
  let trend: TelemetryTrend | undefined;
  if (periodDays > 0 && cutoff > 0) {
    const prevCutoff = cutoff - periodDays * 86400000;
    const prevEntries = all.filter(e => e.ts >= prevCutoff && e.ts < cutoff);
    if (prevEntries.length > 0) {
      const prevMcpEntries = prevEntries.filter(e => e.src !== 'cli');
      const prevSessions = new Set(prevMcpEntries.map(e => e.session)).size;
      const prevReadsWithHit = prevEntries.filter(e => e.op === 'read' && e.hit !== undefined);
      const prevHits = prevReadsWithHit.filter(e => e.hit === true).length;
      const prevHitRate = prevReadsWithHit.length > 0 ? prevHits / prevReadsWithHit.length : undefined;
      const prevDurations = prevEntries.filter(e => e.duration !== undefined).map(e => e.duration!);
      const prevAvgDuration = prevDurations.length > 0
        ? prevDurations.reduce((a, b) => a + b, 0) / prevDurations.length
        : undefined;

      trend = {
        callsDelta: pctChange(entries.length, prevEntries.length),
        sessionsDelta: pctChange(mcpSessions, prevSessions),
        hitRateDelta: hitRate !== undefined && prevHitRate !== undefined
          ? (hitRate - prevHitRate) * 100  // absolute pp change
          : undefined,
        avgDurationDelta: avgDurationMs !== undefined && prevAvgDuration !== undefined
          ? pctChange(avgDurationMs, prevAvgDuration)
          : undefined,
      };
    }
  }

  return {
    period,
    totalCalls: entries.length,
    mcpSessions,
    mcpCalls: mcpEntries.length,
    cliCalls: cliEntries.length,
    bootstrapRate: mcpSessions > 0 ? bootstrapped / mcpSessions : 0,
    writeBackRate: mcpSessions > 0 ? wroteBack / mcpSessions : 0,
    reads,
    writes,
    removes,
    execs,
    readWriteRatio: writes > 0 ? `${(reads / writes).toFixed(1)}:1` : reads > 0 ? '∞:1' : '0:0',
    bulkWrites,
    organicWrites,
    organicReadWriteRatio: organicWrites > 0 ? `${(reads / organicWrites).toFixed(1)}:1` : reads > 0 ? '∞:1' : '0:0',
    namespaceCoverage: nsCoverage,
    topTools,
    scopeBreakdown,
    hitRate,
    hits,
    misses,
    redundantRate,
    redundantWrites,
    avgSessionCalls,
    avgSessionDurationMs,
    totalResponseBytes,
    avgResponseBytes,
    avgDurationMs,
    projectBreakdown,
    estimatedTokensSaved,
    estimatedTokensSavedBootstrap,
    estimatedExplorationTokensSaved,
    estimatedRedundantWriteTokensSaved,
    estimatedTotalTokensSaved,
    explorationBreakdown,
    deliveryCostTokens,
    netTokensSaved,
    calibration,
    agentBreakdown,
    trend,
  };
}
