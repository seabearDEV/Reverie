import path from 'path';
import { getDataDirectory, findProjectFile } from './paths';
import { isEncrypted } from './crypto';
import { getSessionId } from './session';
import { createJsonlLog } from './jsonl';
import { isTestRun } from './testTraffic';
import { getProjectId } from './projectId';

export interface AuditEntry {
  ts: number;
  session: string;
  src: 'mcp' | 'cli';
  tool: string;
  op: 'read' | 'write' | 'remove' | 'exec' | 'meta';
  key?: string | undefined;
  scope?: string | undefined;
  project?: string | undefined;
  // Canonical project identity (#141) — see TelemetryEntry.projectId
  projectId?: string | undefined;
  success: boolean;
  before?: string | undefined;
  after?: string | undefined;
  error?: string | undefined;
  params?: Record<string, unknown> | undefined;
  agent?: string | undefined;
  duration?: number | undefined;
  aliasResolved?: string | undefined;
  // Token-efficiency metrics
  responseSize?: number | undefined;
  requestSize?: number | undefined;
  hit?: boolean | undefined;
  tier?: string | undefined;
  entryCount?: number | undefined;
  redundant?: boolean | undefined;
  // Project-resolution guardrail signals (#99)
  refusedReason?: string | undefined;
  rescuedByExplicitGlobal?: boolean | undefined;
  // reverie_context size-budget shedding (#100)
  degraded?: boolean | undefined;
  shedNamespaces?: string[] | undefined;
  // reverie_set write-amp guard (#101)
  writeAmpWarning?: boolean | undefined;
  writeAmpCount?: number | undefined;
  // RVR_TEST-tagged row (#130) — excluded from queries by default
  test?: boolean | undefined;
  // Observability-tool call (#134) — excluded from queries by default
  selfRef?: boolean | undefined;
}

export interface AuditQueryOptions {
  key?: string | undefined;
  periodDays?: number | undefined;
  writesOnly?: boolean | undefined;
  src?: 'mcp' | 'cli' | undefined;
  project?: string | undefined;
  hitsOnly?: boolean | undefined;
  missesOnly?: boolean | undefined;
  redundantOnly?: boolean | undefined;
  limit?: number | undefined;
  includeTest?: boolean | undefined;
  includeSelfRef?: boolean | undefined;
}

export function getAuditPath(): string {
  return path.join(getDataDirectory(), 'audit.jsonl');
}

// Shared append-only JSONL machinery (incremental tail cache, 0o600
// appends, self-evicting pending-write set) lives in src/utils/jsonl.ts.
const auditLog = createJsonlLog<AuditEntry>(getAuditPath);

const MAX_VALUE_LENGTH = 500;

export function sanitizeValue(value: string | undefined, maxLen: number = MAX_VALUE_LENGTH): string | undefined {
  if (value === undefined) return undefined;
  if (isEncrypted(value)) return '[encrypted]';
  if (value.length > maxLen) return value.slice(0, maxLen) + '...[truncated]';
  return value;
}

export function sanitizeParams(params: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    if (k === 'password') {
      result[k] = '[redacted]';
    } else if (typeof v === 'string' && isEncrypted(v)) {
      result[k] = '[encrypted]';
    } else if (typeof v === 'string' && v.length > MAX_VALUE_LENGTH) {
      result[k] = v.slice(0, MAX_VALUE_LENGTH) + '...[truncated]';
    } else {
      result[k] = v;
    }
  }
  return result;
}

export function logAudit(partial: Omit<AuditEntry, 'ts' | 'session' | 'agent' | 'project'>, sync = false): Promise<void> {
  const projectFile = findProjectFile();
  const projectDir = projectFile ? path.dirname(projectFile) : undefined;
  const entry: AuditEntry = {
    ...partial,
    ts: Date.now(),
    session: getSessionId(),
    project: projectDir,
    ...(projectDir !== undefined && { projectId: getProjectId(projectDir) }),
    agent: process.env.RVR_AGENT_NAME ?? undefined,
    ...(isTestRun() && { test: true }),
  };
  return auditLog.append(entry, sync);
}

/** Await all pending async audit appends (test hook). */
export function flushAudit(): Promise<void> {
  return auditLog.flush();
}

/** Reset the in-memory audit cache. Used by tests that swap RVR_DATA_DIR. */
export function clearAuditLogCache(): void {
  auditLog.clearCache();
}

export function loadAuditLog(): AuditEntry[] {
  return auditLog.load();
}

/**
 * Return only audit entries appended since the last call to any cache-reading
 * function (loadAuditLog, queryAuditLog, or a previous tailAuditLog).
 * Used by follow mode to stream new entries without re-scanning the whole log.
 */
export function tailAuditLog(): AuditEntry[] {
  return auditLog.tail();
}

export function queryAuditLog(options: AuditQueryOptions = {}): AuditEntry[] {
  const cached = auditLog.view();

  const cutoff = options.periodDays && options.periodDays > 0
    ? Date.now() - options.periodDays * 86400000
    : 0;
  const limit = options.limit ?? 50;
  const keyPrefix = options.key ? options.key + '.' : undefined;

  const filtered = cached.filter(e =>
    (options.includeTest || e.test !== true) &&
    (options.includeSelfRef || e.selfRef !== true) &&
    (cutoff <= 0 || e.ts >= cutoff) &&
    (!options.key || e.key === options.key || !!e.key?.startsWith(keyPrefix!)) &&
    (!options.writesOnly || e.op === 'write') &&
    (!options.src || e.src === options.src) &&
    (!options.project || e.project === options.project) &&
    (!options.hitsOnly || e.hit === true) &&
    (!options.missesOnly || e.hit === false) &&
    (!options.redundantOnly || e.redundant === true)
  );

  // Newest first
  filtered.sort((a, b) => b.ts - a.ts);

  return filtered.slice(0, limit);
}
