// #119 (WS3): on-disk per-session state bridging the MCP server's
// session-scoped guardrails to the per-invocation CLI. When RVR_SESSION is
// set, every CLI invocation with the same id reads/updates one state file —
// the write-amp window (#101) and miss-path tracking work across processes
// exactly as they do across calls inside one MCP server process. When
// RVR_SESSION is unset there is nothing to bridge: write-amp falls back to
// the in-memory per-process guard (which a one-shot CLI process never
// trips — today's behavior) and miss-path tracking is skipped (a window
// that dies with the process would log pure noise).

import * as fs from 'fs';
import path from 'path';
import { getDataDirectory } from './paths';
import { getSessionId, isSharedSession } from './session';
import { atomicWriteFileSync } from './atomicWrite';
import { withFileLock } from './fileLock';
import { recordWrite, pruneAndRecord, WriteAmpResult } from './writeAmp';
import { MissWindowTracker, MissPath, OpenMissWindow } from './telemetry';
import { debug } from './debug';

/** Session files untouched for this long are pruned opportunistically. */
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

export interface SessionStateFile {
  v: 1;
  updatedAt: number;
  /** key → in-window write timestamps (ms epoch), write-amp guard state. */
  writes: Record<string, number[]>;
  /** Open miss windows carried across invocations. */
  missWindows: OpenMissWindow[];
}

function emptyState(now: number): SessionStateFile {
  return { v: 1, updatedAt: now, writes: Object.create(null) as Record<string, number[]>, missWindows: [] };
}

function sessionsDir(): string {
  return path.join(getDataDirectory(), 'sessions');
}

function sessionFilePath(id: string): string {
  return path.join(sessionsDir(), `${id}.json`);
}

/** Load the session state, treating missing/corrupt files as empty (#119). */
export function loadSessionState(id: string, now = Date.now()): SessionStateFile {
  try {
    const raw = fs.readFileSync(sessionFilePath(id), 'utf8');
    const parsed = JSON.parse(raw) as Partial<SessionStateFile>;
    if (typeof parsed !== 'object' || parsed?.v !== 1) return emptyState(now);
    return {
      v: 1,
      updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : now,
      writes: parsed.writes && typeof parsed.writes === 'object' && !Array.isArray(parsed.writes)
        ? Object.assign(Object.create(null) as Record<string, number[]>, parsed.writes)
        : emptyState(now).writes,
      missWindows: Array.isArray(parsed.missWindows) ? parsed.missWindows : [],
    };
  } catch (err) {
    debug(`session state load failed for ${id}, starting empty: ${String(err)}`);
    return emptyState(now);
  }
}

function saveSessionState(id: string, state: SessionStateFile, now: number): void {
  fs.mkdirSync(sessionsDir(), { recursive: true, mode: 0o700 });
  state.updatedAt = now;
  atomicWriteFileSync(sessionFilePath(id), JSON.stringify(state));
}

/**
 * Read-modify-write the shared session file under its lock — two CLI
 * invocations sharing RVR_SESSION can run concurrently. Guardrail state is
 * best-effort: any failure is swallowed (a set must never crash because its
 * session bookkeeping did).
 */
function updateSessionState<T>(
  id: string,
  now: number,
  fn: (state: SessionStateFile) => T,
): T | undefined {
  try {
    fs.mkdirSync(sessionsDir(), { recursive: true, mode: 0o700 });
    return withFileLock(sessionFilePath(id), () => {
      const state = loadSessionState(id, now);
      const out = fn(state);
      saveSessionState(id, state, now);
      return out;
    });
  } catch (err) {
    debug(`session state update failed for ${id}: ${String(err)}`);
    return undefined;
  }
}

/**
 * TTL prune: delete session files whose mtime is older than 24h. Called
 * opportunistically from the write paths; the dir holds one small file per
 * active agent session, so a readdir sweep is cheap.
 */
export function pruneStaleSessions(now = Date.now()): void {
  try {
    for (const name of fs.readdirSync(sessionsDir())) {
      if (!name.endsWith('.json')) continue;
      const p = path.join(sessionsDir(), name);
      try {
        if (now - fs.statSync(p).mtimeMs > SESSION_TTL_MS) fs.unlinkSync(p);
      } catch { /* concurrent prune — ignore */ }
    }
  } catch { /* dir missing — nothing to prune */ }
}

/**
 * Write-amp guard for CLI `set` (#119). Shared session → disk-backed window;
 * otherwise the in-memory per-process guard (never trips for a one-shot CLI
 * process, preserving pre-#119 behavior).
 */
export function recordCliWrite(key: string, now = Date.now()): WriteAmpResult | null {
  if (!isSharedSession()) {
    return recordWrite(getSessionId(), key, now);
  }
  pruneStaleSessions(now);
  const result = updateSessionState(getSessionId(), now, (state) => {
    const { timestamps, result: amp } = pruneAndRecord(state.writes[key] ?? [], now);
    state.writes[key] = timestamps;
    return amp;
  });
  return result ?? null;
}

/**
 * Miss-path tracking for CLI reads (#119). Rehydrates the tracker from the
 * session file, feeds it this call, persists the surviving windows, and
 * returns any closed paths for the caller to append to miss-paths.jsonl.
 * No-op without a shared session.
 */
export function trackCliMissPath(call: {
  tool: string;
  namespace: string;
  key: string;
  op: string;
  hit: boolean | undefined;
  responseSize: number;
  agent?: string | undefined;
}, now = Date.now()): MissPath[] {
  if (!isSharedSession()) return [];
  const closed = updateSessionState(getSessionId(), now, (state) => {
    const tracker = new MissWindowTracker();
    tracker.restoreOpenWindows(state.missWindows);
    const paths = tracker.onToolCall({ session: getSessionId(), ...call });
    state.missWindows = tracker.exportOpenWindows();
    return paths;
  });
  return closed ?? [];
}
