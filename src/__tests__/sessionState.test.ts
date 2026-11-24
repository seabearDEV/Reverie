// #119 (WS3): RVR_SESSION-bridged CLI session state — write-amp guard and
// miss-path tracking persisted across one-shot CLI invocations.

import * as fs from 'fs';
import os from 'os';
import path from 'path';
import { clearDataDirectoryCache } from '../utils/paths';
import { loadSessionState, pruneStaleSessions, recordCliWrite, trackCliMissPath } from '../utils/sessionState';
import { resetSessionIdForTests, getSessionId, isSharedSession, isSessionDetected, deriveSession } from '../utils/session';
import { clearWriteAmpState } from '../utils/writeAmp';
import { HANDOFF_KEY } from '../utils/handoff';

let dataDir: string;
const originalDataDir = process.env.RVR_DATA_DIR;
const originalSession = process.env.RVR_SESSION;

const sessionsDir = () => path.join(dataDir, 'sessions');

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reverie-session-state-'));
  process.env.RVR_DATA_DIR = dataDir;
  delete process.env.RVR_SESSION;
  clearDataDirectoryCache();
  clearWriteAmpState();
  resetSessionIdForTests();
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
  if (originalDataDir !== undefined) process.env.RVR_DATA_DIR = originalDataDir;
  else delete process.env.RVR_DATA_DIR;
  if (originalSession !== undefined) process.env.RVR_SESSION = originalSession;
  else delete process.env.RVR_SESSION;
  clearDataDirectoryCache();
  resetSessionIdForTests();
});

describe('RVR_SESSION session id (#119)', () => {
  it('falls back to a random per-process id when unset', () => {
    expect(isSharedSession()).toBe(false);
    expect(getSessionId()).toMatch(/^[0-9a-f]{8}$/);
  });

  it('adopts RVR_SESSION when set', () => {
    process.env.RVR_SESSION = 'agent-alpha';
    resetSessionIdForTests();
    expect(isSharedSession()).toBe(true);
    expect(getSessionId()).toBe('agent-alpha');
  });

  it('sanitizes filesystem-hostile ids', () => {
    process.env.RVR_SESSION = '../evil id/№';
    resetSessionIdForTests();
    expect(getSessionId()).toMatch(/^[A-Za-z0-9._-]+$/);
    expect(getSessionId()).not.toContain('/');
    // No leading dot: the session file must never be a dotfile, or it
    // hides from plain `ls` of the sessions dir.
    expect(getSessionId().startsWith('.')).toBe(false);
  });

  it('falls back to a random id when sanitization empties the value', () => {
    process.env.RVR_SESSION = '...';
    resetSessionIdForTests();
    expect(getSessionId()).toMatch(/^[0-9a-f]{8}$/);
    // #207: id and shared are decided together — an unusable value is not a
    // shared session (it used to report shared with a per-process id).
    expect(isSharedSession()).toBe(false);
  });
});

describe('recordCliWrite (#119/#101)', () => {
  it('does not create a session file without RVR_SESSION', () => {
    recordCliWrite('files.a');
    recordCliWrite('files.a');
    expect(fs.existsSync(sessionsDir())).toBe(false);
  });

  it('trips the threshold on the 3rd in-window write of a shared session', () => {
    process.env.RVR_SESSION = 'sess1';
    resetSessionIdForTests();
    const t0 = Date.now();
    expect(recordCliWrite('files.a', t0)).toBeNull();
    expect(recordCliWrite('files.a', t0 + 1000)).toBeNull();
    const amp = recordCliWrite('files.a', t0 + 2000);
    expect(amp).not.toBeNull();
    expect(amp!.count).toBe(3);
    expect(fs.existsSync(path.join(sessionsDir(), 'sess1.json'))).toBe(true);
  });

  it('does not trip across different keys', () => {
    process.env.RVR_SESSION = 'sess2';
    resetSessionIdForTests();
    const t0 = Date.now();
    expect(recordCliWrite('files.a', t0)).toBeNull();
    expect(recordCliWrite('files.b', t0 + 1000)).toBeNull();
    expect(recordCliWrite('files.c', t0 + 2000)).toBeNull();
  });

  it('forgets writes that slid out of the 30-min window', () => {
    process.env.RVR_SESSION = 'sess3';
    resetSessionIdForTests();
    const t0 = Date.now();
    expect(recordCliWrite('files.a', t0)).toBeNull();
    expect(recordCliWrite('files.a', t0 + 1000)).toBeNull();
    // Third write 31 minutes later: first two are out of window.
    expect(recordCliWrite('files.a', t0 + 31 * 60 * 1000)).toBeNull();
  });

  it('the handoff is exempt in a shared session: no warning, nothing recorded, no state file', () => {
    // The shared-session path does its own window math against the state
    // file, so the exemption in recordWrite alone would not reach it.
    process.env.RVR_SESSION = 'sess-handoff';
    resetSessionIdForTests();
    const t0 = Date.now();
    for (let i = 0; i < 5; i++) expect(recordCliWrite(HANDOFF_KEY, t0 + i * 1000)).toBeNull();
    expect(fs.existsSync(path.join(sessionsDir(), 'sess-handoff.json'))).toBe(false);

    // An ordinary key in the same session still trips, and the handoff is
    // absent from the persisted window.
    expect(recordCliWrite('files.a', t0 + 6000)).toBeNull();
    expect(recordCliWrite(HANDOFF_KEY, t0 + 6500)).toBeNull();
    expect(recordCliWrite('files.a', t0 + 7000)).toBeNull();
    expect(recordCliWrite('files.a', t0 + 8000)?.count).toBe(3);
    expect(Object.keys(loadSessionState('sess-handoff').writes)).toEqual(['files.a']);
  });

  it('the handoff is exempt without a shared session too', () => {
    const t0 = Date.now();
    for (let i = 0; i < 5; i++) expect(recordCliWrite(HANDOFF_KEY, t0 + i * 1000)).toBeNull();
  });

  it('treats a corrupt session file as empty instead of crashing', () => {
    process.env.RVR_SESSION = 'sess4';
    resetSessionIdForTests();
    fs.mkdirSync(sessionsDir(), { recursive: true });
    fs.writeFileSync(path.join(sessionsDir(), 'sess4.json'), '{nope');
    expect(recordCliWrite('files.a')).toBeNull();
    const state = loadSessionState('sess4');
    expect(state.writes['files.a']).toHaveLength(1);
  });

  it('drops non-number timestamps from a structurally-valid file', () => {
    // Corrupt leaves must not silently suppress the amp warning: NaN math
    // would filter them as "expired" without any visible failure.
    fs.mkdirSync(sessionsDir(), { recursive: true });
    const t0 = Date.now();
    fs.writeFileSync(path.join(sessionsDir(), 'sessX.json'), JSON.stringify({
      v: 1, updatedAt: t0,
      writes: { 'files.a': [null, 'abc', {}, t0], 'files.b': 'not-an-array' },
      missWindows: [],
    }));
    const state = loadSessionState('sessX', t0);
    expect(state.writes['files.a']).toEqual([t0]);
    expect(state.writes['files.b']).toBeUndefined();
  });
});

describe('trackCliMissPath (#119)', () => {
  it('is a no-op without RVR_SESSION', () => {
    const closed = trackCliMissPath({
      tool: 'reverie_get', namespace: 'arch', key: 'arch.api', op: 'read', hit: false, responseSize: 10,
    });
    expect(closed).toEqual([]);
    expect(fs.existsSync(sessionsDir())).toBe(false);
  });

  it('persists an open window on a read miss and closes it as writeback on set', () => {
    process.env.RVR_SESSION = 'sess5';
    resetSessionIdForTests();
    // Read miss opens a window (one CLI invocation)...
    expect(trackCliMissPath({
      tool: 'reverie_get', namespace: 'arch', key: 'arch.api', op: 'read', hit: false, responseSize: 10,
    })).toEqual([]);
    expect(loadSessionState('sess5').missWindows).toHaveLength(1);
    // ...a later invocation writes the same namespace back.
    const closed = trackCliMissPath({
      tool: 'reverie_set', namespace: 'arch', key: 'arch.api', op: 'write', hit: undefined, responseSize: 20,
    });
    expect(closed).toHaveLength(1);
    expect(closed[0].resolution).toBe('writeback');
    expect(closed[0].namespace).toBe('arch');
    expect(loadSessionState('sess5').missWindows).toHaveLength(0);
  });

  it('closes open windows as moved_on when a later read hits', () => {
    process.env.RVR_SESSION = 'sess6';
    resetSessionIdForTests();
    trackCliMissPath({
      tool: 'reverie_get', namespace: 'arch', key: 'arch.api', op: 'read', hit: false, responseSize: 10,
    });
    const closed = trackCliMissPath({
      tool: 'reverie_get', namespace: 'files', key: 'files.store', op: 'read', hit: true, responseSize: 30,
    });
    expect(closed).toHaveLength(1);
    expect(closed[0].resolution).toBe('moved_on');
  });
});

describe('pruneStaleSessions (#119)', () => {
  it('removes files older than the TTL and keeps fresh ones', () => {
    fs.mkdirSync(sessionsDir(), { recursive: true });
    const oldFile = path.join(sessionsDir(), 'old.json');
    const freshFile = path.join(sessionsDir(), 'fresh.json');
    fs.writeFileSync(oldFile, '{}');
    fs.writeFileSync(freshFile, '{}');
    const old = (Date.now() - 25 * 60 * 60 * 1000) / 1000;
    fs.utimesSync(oldFile, old, old);
    pruneStaleSessions();
    expect(fs.existsSync(oldFile)).toBe(false);
    expect(fs.existsSync(freshFile)).toBe(true);
  });

  it('skips a stale file whose lock is held by a concurrent writer', () => {
    // A prune racing an in-flight updateSessionState must not unlink the
    // file out from under the lock holder — the holder's tmp+rename save
    // would silently resurrect it and the prune's delete would be undone.
    fs.mkdirSync(sessionsDir(), { recursive: true });
    const lockedFile = path.join(sessionsDir(), 'locked.json');
    fs.writeFileSync(lockedFile, '{}');
    const old = (Date.now() - 25 * 60 * 60 * 1000) / 1000;
    fs.utimesSync(lockedFile, old, old);
    fs.writeFileSync(`${lockedFile}.lock`, String(process.pid)); // fresh lock = held
    try {
      pruneStaleSessions();
      expect(fs.existsSync(lockedFile)).toBe(true);
    } finally {
      fs.unlinkSync(`${lockedFile}.lock`);
    }
  });
});

// ── #207: fall back to the harness's own session id ───────────────────

const HARNESS_ID = '0b7c2f0e-1111-4222-8333-444455556666';

describe('deriveSession (#207)', () => {
  it('explicit RVR_SESSION wins over a detected harness session', () => {
    const s = deriveSession({ RVR_SESSION: 'mine', CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: HARNESS_ID });
    expect(s).toEqual({ id: 'mine', shared: true, detected: undefined });
  });

  it('adopts the Claude Code session id when the fingerprint matches', () => {
    expect(deriveSession({ CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: HARNESS_ID }))
      .toEqual({ id: HARNESS_ID, shared: true, detected: true });
    expect(deriveSession({ CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_CODE_SESSION_ID: HARNESS_ID }).id).toBe(HARNESS_ID);
  });

  it('still detects on a fleet machine where RVR_AGENT_NAME is set', () => {
    const s = deriveSession({ RVR_AGENT_NAME: 'fable', CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: HARNESS_ID });
    expect(s).toEqual({ id: HARNESS_ID, shared: true, detected: true });
  });

  it('ignores the session variable without its harness fingerprint', () => {
    const s = deriveSession({ CLAUDE_CODE_SESSION_ID: HARNESS_ID });
    expect(s.shared).toBe(false);
    expect(s.detected).toBeUndefined();
    expect(s.id).toMatch(/^[0-9a-f]{8}$/);
  });

  it('is per-process under a harness with no known session variable', () => {
    const s = deriveSession({ CODEX_SANDBOX: 'seatbelt', CLAUDE_CODE_SESSION_ID: HARNESS_ID });
    expect(s.shared).toBe(false);
    expect(s.id).toMatch(/^[0-9a-f]{8}$/);
  });

  it('sanitizes a detected id exactly like an explicit one', () => {
    const s = deriveSession({ CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: '../evil id/№' });
    expect(s.detected).toBe(true);
    expect(s.id).toMatch(/^[A-Za-z0-9._-]+$/);
    expect(s.id.startsWith('.')).toBe(false);
  });

  it('a harness value that sanitizes to empty is per-process and not shared', () => {
    for (const bad of ['', '   ', '...']) {
      const s = deriveSession({ CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: bad });
      expect(s.shared).toBe(false);
      expect(s.detected).toBeUndefined();
      expect(s.id).toMatch(/^[0-9a-f]{8}$/);
    }
  });

  it('an unusable RVR_SESSION falls through to the detected session', () => {
    const s = deriveSession({ RVR_SESSION: '...', CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: HARNESS_ID });
    expect(s).toEqual({ id: HARNESS_ID, shared: true, detected: true });
  });

  it('a clean environment is per-process', () => {
    const s = deriveSession({ PATH: '/usr/bin' });
    expect(s.shared).toBe(false);
    expect(s.id).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe('a detected harness session drives the CLI guardrails (#207)', () => {
  const saved: Record<string, string | undefined> = {};
  const VARS = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID'];

  beforeEach(() => {
    for (const v of VARS) saved[v] = process.env[v];
    process.env.CLAUDECODE = '1';
    process.env.CLAUDE_CODE_SESSION_ID = HARNESS_ID;
    resetSessionIdForTests();
  });

  afterEach(() => {
    for (const v of VARS) {
      if (saved[v] === undefined) delete process.env[v];
      else process.env[v] = saved[v];
    }
    resetSessionIdForTests();
  });

  it('id, shared and detected agree', () => {
    expect(getSessionId()).toBe(HARNESS_ID);
    expect(isSharedSession()).toBe(true);
    expect(isSessionDetected()).toBe(true);
  });

  it('trips the write-amp threshold on the 3rd write, in a state file named by the harness id', () => {
    const t0 = Date.now();
    expect(recordCliWrite('project.inFlight', t0)).toBeNull();
    expect(recordCliWrite('project.inFlight', t0 + 1000)).toBeNull();
    expect(recordCliWrite('project.inFlight', t0 + 2000)?.count).toBe(3);
    expect(fs.existsSync(path.join(sessionsDir(), `${HARNESS_ID}.json`))).toBe(true);
  });

  it('the handoff does not trip under a detected session', () => {
    const t0 = Date.now();
    for (let i = 0; i < 5; i++) expect(recordCliWrite(HANDOFF_KEY, t0 + i * 1000)).toBeNull();
    expect(fs.existsSync(path.join(sessionsDir(), `${HARNESS_ID}.json`))).toBe(false);
  });

  it('miss-path tracking is live: a read miss leaves an open window', () => {
    trackCliMissPath({ tool: 'reverie_get', namespace: 'arch', key: 'arch.nope', op: 'read', hit: false, responseSize: 0 });
    expect(loadSessionState(HARNESS_ID).missWindows).toHaveLength(1);
  });

  it('a session that only reads still sweeps expired state files, on its first touch', () => {
    // Every detected session writes a state file on its first read, so the
    // TTL sweep cannot depend on some session eventually calling `set`.
    fs.mkdirSync(sessionsDir(), { recursive: true });
    const expired = path.join(sessionsDir(), 'expired-session.json');
    fs.writeFileSync(expired, '{}');
    const old = (Date.now() - 25 * 60 * 60 * 1000) / 1000;
    fs.utimesSync(expired, old, old);

    trackCliMissPath({ tool: 'reverie_get', namespace: 'arch', key: 'arch.store', op: 'read', hit: true, responseSize: 10 });
    expect(fs.existsSync(expired)).toBe(false);
    expect(fs.existsSync(path.join(sessionsDir(), `${HARNESS_ID}.json`))).toBe(true);
  });

  it('later reads in the same session do not sweep again', () => {
    trackCliMissPath({ tool: 'reverie_get', namespace: 'arch', key: 'arch.store', op: 'read', hit: true, responseSize: 10 });
    const expired = path.join(sessionsDir(), 'expired-later.json');
    fs.writeFileSync(expired, '{}');
    const old = (Date.now() - 25 * 60 * 60 * 1000) / 1000;
    fs.utimesSync(expired, old, old);

    trackCliMissPath({ tool: 'reverie_get', namespace: 'arch', key: 'arch.store', op: 'read', hit: true, responseSize: 10 });
    expect(fs.existsSync(expired)).toBe(true);
    // …until the next write, which sweeps as it always has.
    recordCliWrite('files.x');
    expect(fs.existsSync(expired)).toBe(false);
  });

  it('explicit RVR_SESSION still wins and is not reported as detected', () => {
    process.env.RVR_SESSION = 'explicit-wins';
    resetSessionIdForTests();
    expect(getSessionId()).toBe('explicit-wins');
    expect(isSessionDetected()).toBe(false);
  });

  it('without the harness variable the session is per-process again', () => {
    delete process.env.CLAUDE_CODE_SESSION_ID;
    resetSessionIdForTests();
    expect(isSharedSession()).toBe(false);
    expect(recordCliWrite('files.x')).toBeNull();
    expect(fs.existsSync(sessionsDir())).toBe(false);
  });
});
