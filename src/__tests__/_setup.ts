// Test environment bootstrap — equivalent to vitest.config.ts's `env` block.
// Loaded via bunfig.toml's [test].preload before each test file.
import os from 'os';
import path from 'path';

if (!process.env.RVR_DATA_DIR) {
  process.env.RVR_DATA_DIR = path.join(os.tmpdir(), 'reverie-bun');
}
