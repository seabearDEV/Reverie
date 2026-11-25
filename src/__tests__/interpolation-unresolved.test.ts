// #202: a value holding a ${name} that does not resolve used to give four
// answers across six commands — `set` accepted it silently, plain `get`
// failed with exit 1, `get --json` returned it raw without a word, `context`
// showed it raw, and `lint` passed. Every read now returns the value as
// written and says so; `set` and `lint` say so too; `run` still refuses.
//
// Spawns the built dist/index.js (assumes `bun run build` has run) against a
// project store in a temp directory.

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { assertDistHonorsDataDir } from './helpers/spawnGuard';
import { unresolvedWarning } from '../utils/interpolate';

interface Envelope {
  ok: boolean;
  result?: Record<string, unknown>;
  error?: { code: string; message: string };
  warnings?: { code: string; message: string }[];
}

describe('unresolvedWarning', () => {
  it('names the entry and the reference, and shows the escape', () => {
    const message = unresolvedWarning('conventions.rfvar', { ref: 'EMPTY', why: 'is not a stored key' });
    expect(message).toBe("'conventions.rfvar' refers to ${EMPTY}, which is not a stored key. Its value is returned as written. "
      + 'If that is literal text, store it escaped: \\${EMPTY}.');
  });

  it('never says "not found": the MCP hit detector reads that as a miss', () => {
    for (const why of ['is not a stored key', 'is a group of entries, not a value', 'is encrypted']) {
      expect(unresolvedWarning('a.b', { ref: 'x', why }).toLowerCase()).not.toContain('not found');
    }
    expect(unresolvedWarning('a.b', { why: 'nests references too deeply to resolve' }).toLowerCase()).not.toContain('not found');
  });
});

describe('a value with a reference that does not resolve (#202)', () => {
  const cli = path.resolve('dist/index.js');
  const RAW = 'Use ${EMPTY} then Read Until';
  let dataDir: string;
  let projectDir: string;

  const rvr = (...args: string[]) => {
    const e: Record<string, string | undefined> = { ...process.env, RVR_DATA_DIR: dataDir };
    delete e.RVR_SESSION;
    delete e.RVR_NO_PROJECT;
    delete e.RVR_PROJECT;
    const r = spawnSync('bun', [cli, ...args], { cwd: projectDir, env: e as NodeJS.ProcessEnv, input: '' });
    return { stdout: r.stdout.toString(), stderr: r.stderr.toString(), status: r.status };
  };
  const json = (...args: string[]): Envelope => JSON.parse(rvr('--json', ...args).stdout) as Envelope;
  const unresolvedCodes = (env: Envelope) => (env.warnings ?? []).filter(w => w.code === 'INTERPOLATION_UNRESOLVED');

  beforeAll(() => { assertDistHonorsDataDir(); });

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reverie-interp-data-'));
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reverie-interp-proj-'));
    expect(rvr('init', '--no-scan', '--no-claude', '--no-agents').status).toBe(0);
    expect(rvr('set', 'conventions.rfvar', RAW).status).toBe(0);
  });
  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  // ── reads agree ──────────────────────────────────────────────────────

  it('get: returns the value as written, exits 0, and warns on stderr', () => {
    const r = rvr('get', 'conventions.rfvar');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(RAW);
    expect(r.stderr).toContain("warning: 'conventions.rfvar' refers to ${EMPTY}, which is not a stored key");
    expect(r.stderr).not.toContain('Interpolation failed');
  });

  it('get -p: stdout is exactly the value, so a caller capturing it gets nothing else', () => {
    const r = rvr('get', '-p', 'conventions.rfvar');
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(RAW + '\n');
    expect(r.stderr).toContain('warning:');
  });

  it('get --json: the same value, with a coded warning', () => {
    const env = json('get', 'conventions.rfvar');
    expect(env.ok).toBe(true);
    expect(env.result).toEqual({ 'conventions.rfvar': RAW });
    const warnings = unresolvedCodes(env);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toContain('${EMPTY}');
  });

  it('a subtree listing: the same value in text and JSON, one warning for the one entry', () => {
    expect(rvr('set', 'conventions.fine', 'plain text').status).toBe(0);
    const text = rvr('get', 'conventions', '-v', '-p');
    expect(text.status).toBe(0);
    expect(text.stdout).toContain(`conventions.rfvar: ${RAW}`);
    expect(text.stderr.split('\n').filter(l => l.startsWith('warning:'))).toHaveLength(1);
    const env = json('get', 'conventions');
    expect(env.ok).toBe(true);
    expect((env.result as Record<string, string>)['conventions.rfvar']).toBe(RAW);
    expect(unresolvedCodes(env)).toHaveLength(1);
  });

  it('context shows the value as written, as it always has', () => {
    expect(rvr('context', '-p', '--tier', 'full').stdout).toContain(`conventions.rfvar: ${RAW}`);
  });

  it('past ten unresolved entries in one listing, the rest are counted', () => {
    for (let i = 0; i < 12; i++) expect(rvr('set', `bulk.k${String(i).padStart(2, '0')}`, `value \${MISSING${i}}`).status).toBe(0);
    const r = rvr('get', 'bulk', '-v', '-p');
    const warnings = r.stderr.split('\n').filter(l => l.startsWith('warning:'));
    expect(warnings).toHaveLength(11);
    expect(warnings[10]).toContain('2 more entries hold a reference that does not resolve');
  });

  // ── set and lint say so ──────────────────────────────────────────────

  it('set: stores the value and warns, in text and JSON', () => {
    const text = rvr('set', 'conventions.other', 'see ${NOPE}');
    expect(text.status).toBe(0);
    expect(text.stdout).toContain("Entry 'conventions.other' set successfully.");
    expect(text.stderr).toContain("warning: 'conventions.other' refers to ${NOPE}");
    const env = json('set', 'conventions.third', 'see ${NOPE}');
    expect(env.ok).toBe(true);
    expect(unresolvedCodes(env)).toHaveLength(1);
  });

  it('lint: lists the entry on a default run and still exits 0', () => {
    const r = rvr('lint');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('1 entry holds a reference that does not resolve');
    expect(r.stdout).toContain("'conventions.rfvar' refers to ${EMPTY}");
    const env = json('lint');
    expect(env.ok).toBe(true);
    expect((env.result as { unresolvedReferences: { key: string }[] }).unresolvedReferences.map(u => u.key)).toEqual(['conventions.rfvar']);
  });

  // ── what does not change ─────────────────────────────────────────────

  it('a reference that resolves, and an escaped one, read as before with no warning', () => {
    expect(rvr('set', 'conventions.base', 'the base').status).toBe(0);
    const resolvable = rvr('set', 'conventions.uses', 'uses ${conventions.base}');
    expect(resolvable.stderr).toBe('');
    const got = rvr('get', '-p', 'conventions.uses');
    expect(got.stdout).toBe('uses the base\n');
    expect(got.stderr).toBe('');
    const escaped = rvr('set', 'conventions.literal', 'literal \\${VAR} text');
    expect(escaped.stderr).toBe('');
    const literal = rvr('get', '-p', 'conventions.literal');
    expect(literal.stdout).toBe('literal ${VAR} text\n');
    expect(literal.stderr).toBe('');
    expect(rvr('remove', 'conventions.rfvar', '-f').status).toBe(0);
    expect(rvr('lint').stdout).not.toContain('does not resolve');
  });

  it('a `:?` reference still fails a read: the author asked for that', () => {
    expect(rvr('set', 'conventions.strict', 'needs ${nope:?must be set}').status).toBe(0);
    const leaf = rvr('get', 'conventions.strict');
    expect(leaf.status).toBe(1);
    expect(leaf.stderr).toContain('must be set');
    // In a listing it is the same one-line error, not a stack trace.
    const listing = rvr('get', 'conventions', '-v', '-p');
    expect(listing.status).toBe(1);
    expect(listing.stderr).toContain('must be set');
    expect(listing.stderr).not.toContain('StrictInterpolationError');
    expect(listing.stderr.trim().split('\n')).toHaveLength(1);
  });

  it('run still refuses a command with an unresolved reference, and a $(key) in a read is never executed', () => {
    expect(rvr('set', 'commands.broken', 'echo ${EMPTY}').status).toBe(0);
    const run = rvr('run', 'commands.broken', '--yes');
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('Interpolation failed: "EMPTY" not found');

    const marker = path.join(projectDir, 'executed.marker');
    expect(rvr('set', 'commands.touch', `touch ${marker}`).status).toBe(0);
    expect(rvr('set', 'conventions.exec', 'before $(commands.touch) and ${EMPTY}').status).toBe(0);
    const read = rvr('get', '-p', 'conventions.exec');
    expect(read.stdout).toBe('before $(commands.touch) and ${EMPTY}\n');
    rvr('get', 'conventions', '-v');
    json('get', 'conventions.exec');
    rvr('lint');
    expect(fs.existsSync(marker)).toBe(false);
  });
});
