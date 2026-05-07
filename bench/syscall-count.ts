/**
 * Syscall-count benchmark for Reverie performance improvements.
 *
 * Instruments fs.statSync, fs.readFileSync, fs.writeFileSync, fs.existsSync,
 * fs.renameSync, fs.openSync, fs.closeSync, fs.writeSync, and fs.unlinkSync
 * to count filesystem calls for each operation.
 *
 * Run:  npx tsx bench/syscall-count.ts
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

// ── Set up temp data directory BEFORE any reverie imports ─────────────
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reverie-bench-'));
process.env.CODEX_DATA_DIR = tmpDir;
// Force non-interactive mode to avoid TTY prompts
process.stdin.isTTY = false;
// Suppress console output from the library
const origLog = console.log;
const origError = console.error;
function hush() {
  console.log = () => {};
  console.error = () => {};
}
function unhush() {
  console.log = origLog;
  console.error = origError;
}

// ── Instrument fs functions ───────────────────────────────────────────

type TrackedFn =
  | 'statSync'
  | 'readFileSync'
  | 'writeFileSync'
  | 'existsSync'
  | 'renameSync'
  | 'openSync'
  | 'closeSync'
  | 'writeSync'
  | 'unlinkSync';

const TRACKED: TrackedFn[] = [
  'statSync',
  'readFileSync',
  'writeFileSync',
  'existsSync',
  'renameSync',
  'openSync',
  'closeSync',
  'writeSync',
  'unlinkSync',
];

const originals: Record<string, Function> = {};
const counts: Record<string, number> = {};
let traceLog: { fn: string; path: string; caller: string }[] = [];
let traceEnabled = false;

for (const name of TRACKED) {
  originals[name] = (fs as unknown as Record<string, Function>)[name];
  counts[name] = 0;
}

function getCallerInfo(): string {
  const stack = new Error().stack ?? '';
  const lines = stack.split('\n');
  // Skip Error, the proxy fn, installProbes wrapper — find the first reverie src/ frame
  for (let i = 3; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes('/src/') && !line.includes('node_modules')) {
      const match = line.match(/\/src\/(.+?):\d+/);
      if (match) return match[1];
    }
  }
  return 'unknown';
}

function installProbes() {
  for (const name of TRACKED) {
    (fs as unknown as Record<string, Function>)[name] = function (...args: unknown[]) {
      counts[name]++;
      if (traceEnabled) {
        const filePath = typeof args[0] === 'string' ? path.basename(args[0]) : '?';
        traceLog.push({ fn: name, path: filePath, caller: getCallerInfo() });
      }
      return (originals[name] as Function).apply(fs, args);
    };
  }
}

function removeProbes() {
  for (const name of TRACKED) {
    (fs as unknown as Record<string, Function>)[name] = originals[name];
  }
}

function resetCounts() {
  for (const name of TRACKED) counts[name] = 0;
  traceLog = [];
}

function snapshotCounts(): Record<string, number> {
  const snap: Record<string, number> = {};
  for (const name of TRACKED) snap[name] = counts[name];
  return snap;
}

function snapshotTrace(): typeof traceLog {
  return [...traceLog];
}

// ── Imports (after CODEX_DATA_DIR is set) ─────────────────────────────

import { clearStoreCaches, loadEntries, saveEntries } from '../src/store';
import { clearConfigCache, loadConfig, saveConfig } from '../src/config';
import { resetColorCache, isColorEnabled, color } from '../src/formatting';
import { getEntry, copyEntry, renameEntry } from '../src/commands/entries';
import { buildKeyToAliasMap, loadAliases, saveAliases } from '../src/alias';
import { CodexData, CodexValue } from '../src/types';
import { clearProjectFileCache } from '../src/utils/paths';

// ── Seed data ─────────────────────────────────────────────────────────

function seedData() {
  removeProbes();

  // Ensure config exists so loadConfig doesn't create it during tests
  saveConfig({ colors: true, theme: 'default' });
  clearConfigCache();

  // Build 50 entries under 5 namespaces
  const entries: CodexData = {};
  const namespaces = ['server', 'deploy', 'db', 'api', 'paths'];
  for (const ns of namespaces) {
    const subtree: Record<string, CodexValue> = {};
    for (let i = 0; i < 10; i++) {
      subtree[`key${i}`] = `value-${ns}-${i}`;
    }
    entries[ns] = subtree;
  }
  saveEntries(entries, 'global');

  // Build 10 aliases
  const aliases: Record<string, string> = {};
  for (let i = 0; i < 10; i++) {
    const ns = namespaces[i % namespaces.length];
    aliases[`a${i}`] = `${ns}.key${i}`;
  }
  saveAliases(aliases, 'global');

  // Clear all caches so each test starts clean
  clearStoreCaches();
  clearConfigCache();
  resetColorCache();
}

// ── Benchmark helpers ─────────────────────────────────────────────────

interface BenchResult {
  name: string;
  counts: Record<string, number>;
  totalFsCalls: number;
  trace: typeof traceLog;
}

function measure(name: string, fn: () => void): BenchResult {
  clearStoreCaches();
  clearConfigCache();
  resetColorCache();
  clearProjectFileCache();
  process.exitCode = undefined as unknown as number;

  traceEnabled = true;
  installProbes();
  resetCounts();
  hush();
  try {
    fn();
  } finally {
    unhush();
  }
  const snap = snapshotCounts();
  const trace = snapshotTrace();
  removeProbes();
  traceEnabled = false;

  const total = Object.values(snap).reduce((a, b) => a + b, 0);
  return { name, counts: snap, totalFsCalls: total, trace };
}

async function measureAsync(name: string, fn: () => Promise<void>): Promise<BenchResult> {
  clearStoreCaches();
  clearConfigCache();
  resetColorCache();
  clearProjectFileCache();
  process.exitCode = undefined as unknown as number;

  traceEnabled = true;
  installProbes();
  resetCounts();
  hush();
  try {
    await fn();
  } finally {
    unhush();
  }
  const snap = snapshotCounts();
  const trace = snapshotTrace();
  removeProbes();
  traceEnabled = false;

  const total = Object.values(snap).reduce((a, b) => a + b, 0);
  return { name, counts: snap, totalFsCalls: total, trace };
}

// ── Run benchmarks ────────────────────────────────────────────────────

async function main() {
  seedData();

  const results: BenchResult[] = [];

  // ─── 1. isColorEnabled() — cached vs. uncached ──────────────────────
  results.push(measure('isColorEnabled() x1 (cold)', () => {
    isColorEnabled();
  }));

  results.push(measure('isColorEnabled() x100 (after first call)', () => {
    for (let i = 0; i < 100; i++) isColorEnabled();
  }));

  // ─── 2. color.cyan() x50 (simulates display loop) ──────────────────
  results.push(measure('color.cyan() x50', () => {
    for (let i = 0; i < 50; i++) color.cyan(`test-${i}`);
  }));

  // ─── 3. getEntry — single key ──────────────────────────────────────
  results.push(await measureAsync('getEntry("server.key0")', async () => {
    await getEntry('server.key0', { raw: true });
  }));

  // ─── 4. getEntry — listing all (no key) ────────────────────────────
  results.push(await measureAsync('getEntry() — list all keys', async () => {
    await getEntry(undefined, { raw: true });
  }));

  // ─── 5. getEntry — listing all --json (skips aliasMap) ─────────────
  results.push(await measureAsync('getEntry() --json (deferred aliasMap)', async () => {
    await getEntry(undefined, { json: true });
  }));

  // ─── 6. copyEntry — single string value ────────────────────────────
  results.push(await measureAsync('copyEntry("server.key0" -> "server.key0_copy") — single', async () => {
    await copyEntry('server.key0', 'server.key0_copy', true);
  }));

  // ─── 7. copyEntry — subtree with 10 leaves (batched) ──────────────
  results.push(await measureAsync('copyEntry("server" -> "server_bak") — 10-leaf subtree', async () => {
    await copyEntry('server', 'server_bak', true);
  }));

  // ─── 8. renameEntry — single value + aliases re-point ──────────────
  // Seed a fresh entry for rename
  seedData();
  results.push(measure('renameEntry("api.key0" -> "api.key0_new") — single + alias repoint', () => {
    renameEntry('api.key0', 'api.key0_new', false, undefined, false);
  }));

  // ─── 9. renameEntry — subtree (10 leaves, all aliases repointed) ───
  seedData();
  results.push(measure('renameEntry("deploy" -> "deploy_v2") — 10-leaf subtree + alias repoint', () => {
    renameEntry('deploy', 'deploy_v2', false, undefined, false);
  }));

  // ─── 10. store.load() — cached (should be 1 stat, no read) ─────────
  // Prime the cache WITHOUT probes, then measure the warm path
  results.push((() => {
    clearStoreCaches();
    clearConfigCache();
    resetColorCache();
    clearProjectFileCache();
    removeProbes();
    loadEntries('global');  // prime cache
    // Now measure just the cache-hit path
    traceEnabled = true;
    installProbes();
    resetCounts();
    hush();
    loadEntries('global');
    unhush();
    const snap = snapshotCounts();
    const trace = snapshotTrace();
    removeProbes();
    traceEnabled = false;
    const total = Object.values(snap).reduce((a, b) => a + b, 0);
    return { name: 'loadEntries("global") — cache hit (mtime unchanged)', counts: snap, totalFsCalls: total, trace };
  })());

  // ─── 10b. store.load() — cold path breakdown ───────────────────────
  results.push(measure('loadEntries("global") — cold (includes migration check)', () => {
    loadEntries('global');
  }));

  // ─── 11. buildKeyToAliasMap ─────────────────────────────────────────
  results.push(measure('buildKeyToAliasMap() — cold', () => {
    buildKeyToAliasMap();
  }));

  // ── Print results ───────────────────────────────────────────────────
  unhush();

  const COL_NAME = 58;
  const COL_NUM = 8;

  // Determine which fs functions had any non-zero counts
  const activeFns = TRACKED.filter(fn =>
    results.some(r => r.counts[fn] > 0)
  );

  // Header
  const header =
    'Benchmark'.padEnd(COL_NAME) +
    activeFns.map(fn => fn.replace('Sync', '').padStart(COL_NUM)).join('') +
    'TOTAL'.padStart(COL_NUM);

  console.log('\n' + '='.repeat(header.length));
  console.log('Reverie Syscall Count Benchmark (post-optimization)');
  console.log('='.repeat(header.length));
  console.log(`Data: ${tmpDir}`);
  console.log(`Entries: 50 (5 namespaces x 10 keys), Aliases: 10\n`);
  console.log(header);
  console.log('-'.repeat(header.length));

  for (const r of results) {
    const line =
      r.name.padEnd(COL_NAME) +
      activeFns.map(fn => String(r.counts[fn]).padStart(COL_NUM)).join('') +
      String(r.totalFsCalls).padStart(COL_NUM);
    console.log(line);
  }

  console.log('-'.repeat(header.length));

  // ── Detailed trace for key operations ────────────────────────────────
  console.log('\n' + '='.repeat(header.length));
  console.log('Detailed fs call traces (showing what calls what)');
  console.log('='.repeat(header.length));

  const traceTargets = [
    'getEntry("server.key0")',
    'getEntry() — list all keys',
    'getEntry() --json (deferred aliasMap)',
    'copyEntry("server.key0" -> "server.key0_copy") — single',
    'copyEntry("server" -> "server_bak") — 10-leaf subtree',
    'loadEntries("global") — cache hit (mtime unchanged)',
    'loadEntries("global") — cold (includes migration check)',
  ];

  for (const r of results) {
    if (!traceTargets.includes(r.name)) continue;
    console.log(`\n  ${r.name} (${r.totalFsCalls} total):`);
    for (const t of r.trace) {
      console.log(`    ${t.fn.replace('Sync', '').padEnd(12)} ${t.path.padEnd(24)} <- ${t.caller}`);
    }
  }

  // ── Expected "before" counts for comparison ─────────────────────────
  console.log(`
BEFORE vs AFTER comparison (estimated from code analysis):

Optimization 1 — isColorEnabled() caching:
  Before: isColorEnabled() x100 = ~200 fs calls (statSync + existsSync per call via loadConfig)
  After:  ${results[1].totalFsCalls} fs calls (config loaded once, cached in-process)

Optimization 2 — copyEntry batching:
  Before: copyEntry 10-leaf subtree = ~60 fs calls (10x load+parse+save cycle)
  After:  ${results[7].totalFsCalls} fs calls (load once, mutate, save once)

Optimization 3 — renameEntry alias batching:
  Before: renameEntry 10-leaf + aliases = ~100+ fs calls (per-alias removeAlias+setAlias)
  After:  ${results[9].totalFsCalls} fs calls (batch mutate + single save)

Optimization 4 — store.load() single stat:
  Before: load() cold = existsSync + statSync + readFileSync (3+ calls)
  After:  load() cold = statSync + readFileSync (2 calls, no existsSync)

Optimization 5 — buildKeyToAliasMap deferred for --json:
  getEntry() list all:   ${results[4].totalFsCalls} fs calls (builds alias map)
  getEntry() --json:     ${results[5].totalFsCalls} fs calls (alias map skipped)
`);

  // Cleanup
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exitCode = 0;
}

main().catch((err) => {
  unhush();
  console.error('Benchmark failed:', err);
  // Best-effort cleanup
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(1);
});
