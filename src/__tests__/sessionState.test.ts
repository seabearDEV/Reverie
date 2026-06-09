// #119 (WS3): RVR_SESSION-bridged CLI session state — write-amp guard and
// miss-path tracking persisted across one-shot CLI invocations.

import * as fs from 'fs';
import os from 'os';
import path from 'path';
import { clearDataDirectoryCache } from '../utils/paths';
import { loadSessionState, pruneStaleSessions, recordCliWrite, trackCliMissPath } from '../utils/sessionState';
import { resetSessionIdForTests, getSessionId, isSharedSession } from '../utils/session';
import { clearWriteAmpState } from '../utils/writeAmp';

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

  it('treats a corrupt session file as empty instead of crashing', () => {
    process.env.RVR_SESSION = 'sess4';
    resetSessionIdForTests();
    fs.mkdirSync(sessionsDir(), { recursive: true });
    fs.writeFileSync(path.join(sessionsDir(), 'sess4.json'), '{nope');
    expect(recordCliWrite('files.a')).toBeNull();
    const state = loadSessionState('sess4');
    expect(state.writes['files.a']).toHaveLength(1);
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
});
