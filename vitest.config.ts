import os from 'os';
import path from 'path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    env: { RVR_DATA_DIR: path.join(os.tmpdir(), 'reverie-vitest') },
    root: './src',
    include: ['**/__tests__/**/*.ts', '**/*.{test,spec}.ts'],
    exclude: ['**/__tests__/helpers/**'],
    coverage: {
      provider: 'v8',
      reportsDirectory: '../coverage',
      include: ['**/*.ts'],
      exclude: ['**/*.d.ts', '**/__tests__/**'],
    },
  },
});
