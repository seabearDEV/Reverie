import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * Fail-closed guard for suites that spawn the built dist/index.js: verify the
 * build actually honors RVR_DATA_DIR before any test writes run. The override
 * is fail-open — a dist that doesn't recognize the env var (e.g. a stale build
 * across an env-var rename) falls back silently to the real ~/.reverie store,
 * which is how the 2026-05-06 rebrand test run leaked 70 entries into the
 * global store (see context.testDataLeaks).
 */
export function assertDistHonorsDataDir(): void {
  const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reverie-spawn-guard-'));
  try {
    const out = execSync('bun dist/index.js info', {
      env: { ...process.env, RVR_DATA_DIR: probeDir, RVR_NO_PROJECT: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 10000,
    }).toString();
    if (!out.includes(probeDir)) {
      throw new Error(
        'dist/index.js ignored RVR_DATA_DIR — spawned test writes would land in the ' +
          'real global store. Stale build? Run `bun run build`.\n`info` reported:\n' +
          out,
      );
    }
  } finally {
    fs.rmSync(probeDir, { recursive: true, force: true });
  }
}
