// Test environment bootstrap — equivalent to vitest.config.ts's `env` block.
// Loaded via bunfig.toml's [test].preload before each test file.
import os from 'os';
import path from 'path';
import { afterEach } from 'bun:test';
import { resetOutput } from '../utils/output';

if (!process.env.RVR_DATA_DIR) {
  process.env.RVR_DATA_DIR = path.join(os.tmpdir(), 'reverie-bun');
}

// #130 defense in depth: even if RVR_DATA_DIR redirection regresses (the
// stale-dist leak class — see context.testDataLeaks in the store), rows the
// suite writes are tagged test:true and excluded from stats by default.
// Spawn suites inherit this via process.env spreads into child env.
process.env.RVR_TEST = '1';

// printError() in src/commands/helpers.ts sets process.exitCode = 1 to
// propagate failure to wrapping shell scripts. Several tests exercise
// error paths that call printError, leaving exitCode = 1 across tests.
// Bun's test runner inherits the final exitCode and exits 1 even when
// every assertion passed. Reset after each test.
afterEach(() => {
  if (process.exitCode !== undefined && process.exitCode !== 0) {
    process.exitCode = 0;
  }
  // Reset the #117 structured-output state so JSON mode / recorded result /
  // error never leak from one test into the next.
  resetOutput();
});
