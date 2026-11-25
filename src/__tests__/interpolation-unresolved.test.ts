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

interface Envelope {
  ok: boolean;
  result?: Record<string, unknown>;
  error?: { code: string; message: string };
  warnings?: { code: string; message: string }[];
}

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

  it('a reference to an entry whose file cannot be read: the same fallback, with the real reason', () => {
    // This was reported as "nests references too deeply": the fallback caught
    // every error and gave it that label.
    expect(rvr('set', 'conventions.target', 'the target').status).toBe(0);
    expect(rvr('set', 'conventions.uses', 'uses ${conventions.target}').status).toBe(0);
    fs.writeFileSync(path.join(projectDir, '.reverie', 'conventions.target.json'), '<<<<<<< ours\n=======\n>>>>>>> theirs\n');

    const r = rvr('get', '-p', 'conventions.uses');
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('uses ${conventions.target}\n');
    expect(r.stderr).toContain("warning: 'conventions.uses' refers to entry 'conventions.target', whose store file cannot be read");
    expect(r.stderr).not.toContain('too deeply');

    const codes = (json('get', 'conventions.uses').warnings ?? []).map(w => w.code);
    expect(codes).toContain('INTERPOLATION_UNRESOLVED');
    expect(codes).toContain('STORE_UNREADABLE');
  });

  it('a failure in another entry names the reference that leads there, and does not advise escaping it here', () => {
    expect(rvr('set', 'conventions.inner', 'inner uses ${MISSING2}').status).toBe(0);
    expect(rvr('set', 'conventions.outer', 'see ${conventions.inner} here').status).toBe(0);
    const r = rvr('get', '-p', 'conventions.outer');
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('see ${conventions.inner} here\n');
    expect(r.stderr).toContain("warning: 'conventions.outer' refers to ${conventions.inner}, which leads to ${MISSING2}, and that is not a stored key.");
    expect(r.stderr).not.toContain('store it escaped');
  });

  it('get --source returns the stored text without a warning, in text and in JSON', () => {
    // JSON mode ignored --source: it resolved the value, and so it warned.
    expect(rvr('set', 'conventions.base', 'the base').status).toBe(0);
    expect(rvr('set', 'conventions.uses', 'uses ${conventions.base}').status).toBe(0);
    const text = rvr('get', '-s', '-p', 'conventions.rfvar');
    expect(text.stdout).toBe(RAW + '\n');
    expect(text.stderr).toBe('');
    const leaf = json('get', '-s', 'conventions.rfvar');
    expect(leaf.result).toEqual({ 'conventions.rfvar': RAW });
    expect(leaf.warnings ?? []).toEqual([]);
    expect(json('get', '-s', 'conventions.uses').result).toEqual({ 'conventions.uses': 'uses ${conventions.base}' });
    const subtree = json('get', '-s', 'conventions');
    expect((subtree.result as Record<string, string>)['conventions.uses']).toBe('uses ${conventions.base}');
    expect(subtree.warnings ?? []).toEqual([]);
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

  it('a batch set is checked once, after its last pair: a pair may refer to a later one', () => {
    const forward = rvr('set', 'files.f1=uses ${files.f2}', 'files.f2=later');
    expect(forward.status).toBe(0);
    expect(forward.stderr).toBe('');
    expect(rvr('get', '-p', 'files.f1').stdout).toBe('uses later\n');

    const text = rvr('set', 'files.g1=uses ${files.g2}', 'files.g2=see ${NOPE}');
    expect(text.status).toBe(0);
    const warnings = text.stderr.split('\n').filter(l => l.startsWith('warning:'));
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain("'files.g1' refers to ${files.g2}, which leads to ${NOPE}");
    expect(warnings[1]).toContain("'files.g2' refers to ${NOPE}, which is not a stored key");

    // JSON: one envelope for the batch, and the warning is in it.
    const env = json('set', 'files.h1=uses ${files.h2}', 'files.h2=see ${NOPE}');
    expect(env.ok).toBe(true);
    expect(unresolvedCodes(env)).toHaveLength(2);
  });

  it('lint -G is not failed by a project file it was not asked about', () => {
    // A reference is looked up project-first, which scans the project store.
    // Lint listed unreadable files after resolving references, so a global
    // entry holding one made `lint -G` report — and fail on — a project file.
    expect(rvr('set', 'conventions.target', 'the target').status).toBe(0);
    expect(rvr('set', '-G', 'deps.gref', 'global with ${GNOPE} reference').status).toBe(0);
    fs.writeFileSync(path.join(projectDir, '.reverie', 'conventions.target.json'), '<<<<<<< ours\n=======\n>>>>>>> theirs\n');
    const r = rvr('lint', '-G');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("'deps.gref' refers to ${GNOPE}");
    expect(r.stdout).not.toContain('cannot be read');
    expect(rvr('lint').status).toBe(1);
  });

  it('lint --seed-quality does not list as a landmine what a read returns as written', () => {
    // Long enough, and specific enough, to pass the other two heuristics.
    const body = (ref: string) => `The deploy step in src/utils/interpolate.ts reads ${ref} before it starts the release build.`;
    expect(rvr('set', 'arch.target', 'the target').status).toBe(0);
    expect(rvr('set', 'arch.unreadable', body('${arch.target}')).status).toBe(0);
    for (let i = 0; i < 12; i++) expect(rvr('set', `arch.chain${i}`, body(`\${arch.chain${i + 1}}`)).status).toBe(0);
    expect(rvr('set', 'arch.chain12', body('nothing')).status).toBe(0);
    expect(rvr('set', 'arch.guarded', body('${MISSING} and ${nope:?must be set}')).status).toBe(0);
    fs.writeFileSync(path.join(projectDir, '.reverie', 'arch.target.json'), '<<<<<<< ours\n=======\n>>>>>>> theirs\n');

    const result = json('lint', '--seed-quality').result as {
      seedQuality: { key: string; code: string }[];
      unresolvedReferences: { key: string }[];
    };
    const landmines = result.seedQuality.filter(i => i.code === 'interp-landmine').map(i => i.key);
    const unresolved = result.unresolvedReferences.map(u => u.key);
    // A read of arch.guarded fails (the `:?`): a landmine, and only that.
    expect(landmines).toEqual(['arch.guarded']);
    expect(unresolved).toContain('arch.unreadable');
    expect(unresolved).toContain('arch.chain0');
    expect(unresolved).not.toContain('arch.guarded');
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
    // …also behind a reference that does not resolve. The fallback stopped at
    // the first one, returned the value and exited 0.
    expect(rvr('set', 'deps.masked', 'first ${MISSING} then ${nope:?guard after}').status).toBe(0);
    const masked = rvr('get', '-p', 'deps.masked');
    expect(masked.status).toBe(1);
    expect(masked.stdout).toBe('');
    expect(masked.stderr).toContain('guard after');
    // In a listing it is the same one-line error, not a stack trace.
    const listing = rvr('get', 'conventions', '-v', '-p');
    expect(listing.status).toBe(1);
    expect(listing.stderr).toContain('must be set');
    expect(listing.stderr).not.toContain('StrictInterpolationError');
    expect(listing.stderr.trim().split('\n')).toHaveLength(1);
  });

  it('run still refuses a command with an unresolved reference', () => {
    expect(rvr('set', 'commands.broken', 'echo ${EMPTY}').status).toBe(0);
    const run = rvr('run', 'commands.broken', '--yes');
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('Interpolation failed: "EMPTY" not found');
  });

  it('a $(key) is never executed by a read, a listing, lint or set', () => {
    const marker = path.join(projectDir, 'executed.marker');
    expect(rvr('set', 'commands.touch', `touch ${marker}`).status).toBe(0);
    // Sanity: the marker is what `run` creates, so its absence below means something.
    expect(rvr('run', 'commands.touch', '--yes').status).toBe(0);
    expect(fs.existsSync(marker)).toBe(true);
    fs.rmSync(marker);

    // Alone — the first version of this test only had the mixed value, where
    // the unresolved reference threw before the exec phase was ever reached —
    // and after a reference that does not resolve, which a read now scans past.
    const values = { 'conventions.exec': 'before $(commands.touch) after', 'conventions.mixed': 'before ${EMPTY} and $(commands.touch)' };
    for (const [key, value] of Object.entries(values)) {
      expect(rvr('set', key, value).status).toBe(0);
      expect(rvr('get', '-p', key).stdout).toBe(value + '\n');
      json('get', key);
    }
    rvr('get', 'conventions', '-v');
    json('get', 'conventions');
    rvr('lint');
    rvr('lint', '--seed-quality');
    rvr('set', 'conventions.batch1=$(commands.touch)', 'conventions.batch2=${EMPTY} $(commands.touch)');
    expect(fs.existsSync(marker)).toBe(false);
  });
});
