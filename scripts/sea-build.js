#!/usr/bin/env node

/**
 * Build a single-file executable for the current (or specified) target via
 * `bun build --compile`. Replaces the prior Node SEA + esbuild + postject
 * pipeline introduced in v1.0.0-beta.2 (per project.bunMigrationScope).
 *
 * Usage: node scripts/sea-build.js [output-name] [--target <bun-target>]
 *   output-name  defaults to rvr-{platform-name}-{arch} (e.g. rvr-macos-arm64)
 *   --target     bun build --compile target (e.g. bun-darwin-x64). Defaults
 *                to inferring from output-name, then current platform.
 *
 * The legacy --node-binary flag is accepted for CI back-compat but ignored;
 * the target is now derived from output-name (rvr-macos-x64 → bun-darwin-x64).
 * Drop --node-binary from .github/workflows/release.yml in the CI commit.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

const platform = os.platform(); // darwin | linux | win32
const arch = os.arch();         // arm64 | x64

// Map our naming convention to bun's target naming.
const PLATFORM_TO_BUN = { darwin: 'darwin', linux: 'linux', win32: 'windows' };
const NAME_TO_BUN     = { macos: 'darwin', win: 'windows', linux: 'linux' };

// Parse args.
let outputName = null;
let target = null;
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--target') {
    target = args[++i];
    if (!target) { console.error('Error: --target requires an argument'); process.exit(1); }
  } else if (args[i] === '--node-binary') {
    console.warn('Warning: --node-binary is ignored under bun build. Target is inferred from output-name.');
    i++; // consume the path argument
  } else if (!outputName) {
    outputName = args[i];
  }
}

const platformName = platform === 'darwin' ? 'macos' : platform === 'win32' ? 'win' : platform;
outputName = outputName || `rvr-${platformName}-${arch}`;
if (platform === 'win32' && !outputName.endsWith('.exe')) outputName += '.exe';

// Infer bun target from output-name if not explicitly set: rvr-{name}-{arch} → bun-{bunPlatform}-{arch}.
if (!target) {
  const m = outputName.match(/^rvr-([a-z]+)-(arm64|x64)(?:\.exe)?$/);
  if (m && NAME_TO_BUN[m[1]]) {
    target = `bun-${NAME_TO_BUN[m[1]]}-${m[2]}`;
  } else {
    target = `bun-${PLATFORM_TO_BUN[platform]}-${arch}`;
  }
}

const BINARY = path.join(DIST, outputName);

// Locate bun. PATH first, then ~/.bun/bin/bun for installer-only setups.
function findBun() {
  try { return execFileSync('which', ['bun'], { encoding: 'utf8' }).trim(); } catch {}
  const fallback = path.join(os.homedir(), '.bun/bin/bun');
  if (fs.existsSync(fallback)) return fallback;
  console.error('Error: bun not found. Install via https://bun.sh or `brew install bun`.');
  process.exit(1);
}
const BUN = findBun();

fs.mkdirSync(DIST, { recursive: true });

console.log(`\n=== bun build --compile (target: ${target}) ===`);
execFileSync(BUN, [
  'build',
  path.join(ROOT, 'src/index.ts'),
  '--compile',
  `--target=${target}`,
  `--outfile=${BINARY}`,
], { stdio: 'inherit', cwd: ROOT });

// Codesign on macOS so Gatekeeper doesn't block the unsigned binary.
// Only when the host is darwin AND the target is darwin (codesign isn't
// available on non-darwin hosts; cross-compiled darwin binaries get signed
// after lipo on the macOS runner per the CI workflow).
if (platform === 'darwin' && target.includes('darwin')) {
  console.log(`\n=== codesign --sign - ${outputName} ===`);
  execFileSync('codesign', ['--sign', '-', BINARY], { stdio: 'inherit', cwd: ROOT });
}

console.log(`\nDone! Binary: ${BINARY}`);
