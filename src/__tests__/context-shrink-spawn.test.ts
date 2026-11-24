// Spawn tests for #211 against the built dist/index.js (assumes `bun run
// build` has run — CI builds first). The unit suites size a projection;
// these check what the binary actually prints: every key still on the front
// page, narrowed rather than dropped, and the output within the budget.

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { assertDistHonorsDataDir } from './helpers/spawnGuard';

describe('context gist shrink — built binary (#211)', () => {
  const testDir = path.join(os.tmpdir(), 'reverie-shrink-' + Math.random().toString(36).slice(2));
  // Bun's child_process does not pass runtime process.env mutations to
  // children when `env` is omitted, so the environment is always explicit.
  const baseEnv = { ...process.env, RVR_DATA_DIR: testDir, RVR_NO_PROJECT: '1' };
  const run = (args: string, env: Record<string, string> = {}): string =>
    execSync(`bun dist/index.js ${args}`, { env: { ...baseEnv, ...env }, stdio: ['pipe', 'pipe', 'pipe'] }).toString();

  const N = 40;
  const BUDGET = 4400;
  const keyOf = (i: number): string => `topicNumber${String(i).padStart(3, '0')}`;

  beforeAll(() => {
    assertDistHonorsDataDir();
    fs.mkdirSync(testDir, { recursive: true });
    const context: Record<string, string> = {};
    for (let i = 0; i < N; i++) {
      context[keyOf(i)] = `Entry ${i} headline: ${'word '.repeat(50).trim()}.\nSecond paragraph ${'x'.repeat(400)}`;
    }
    const seed = path.join(testDir, 'seed.json');
    fs.writeFileSync(seed, JSON.stringify({ project: { name: 'reverie' }, context }));
    run(`data import entries ${JSON.stringify(seed)} --global --force`);
  });
  afterAll(() => { fs.rmSync(testDir, { recursive: true, force: true }); });

  it('prints every key within the budget, narrowed rather than dropped', () => {
    const out = run('context --plain --global', { RVR_BOOTSTRAP_MAX_BYTES: String(BUDGET) });
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(BUDGET);
    for (let i = 0; i < N; i++) expect(out).toContain(`context.${keyOf(i)}: `);
    expect(out).not.toContain('[trimmed:');
    expect(out).toContain('indexed, gists cut to 40 chars)');
  });

  it('reports the width in --json and on the CLI telemetry row', () => {
    const env = JSON.parse(run('--json context --global', { RVR_BOOTSTRAP_MAX_BYTES: String(BUDGET) })) as {
      result: { gistChars?: number; degraded?: boolean; shedNamespaces?: string[]; index: Record<string, { gist: string }> };
    };
    expect(env.result.gistChars).toBe(40);
    expect(env.result.degraded).toBe(true);
    expect(env.result.shedNamespaces).toEqual([]);
    expect(Object.keys(env.result.index)).toHaveLength(N);
    for (const ix of Object.values(env.result.index)) expect(ix.gist.length).toBeLessThanOrEqual(40);

    const rows = fs.readFileSync(path.join(testDir, 'telemetry.jsonl'), 'utf8').trim().split('\n')
      .map(l => JSON.parse(l) as { tool: string; gistChars?: number; degraded?: boolean });
    const last = rows.filter(r => r.tool === 'reverie_context').pop();
    expect(last).toMatchObject({ degraded: true, gistChars: 40 });
  });

  it('a store that fits is rendered at full width with no width note', () => {
    const out = run('context --plain --global', { RVR_BOOTSTRAP_MAX_BYTES: '50000' });
    expect(out).not.toContain('gists cut to');
    expect(out).not.toContain('keys only');
    expect(out).toContain(`(${N + 1} entries: 1 in full, ${N} indexed) — open an entry with`);
  });
});
