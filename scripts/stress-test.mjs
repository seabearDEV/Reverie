#!/usr/bin/env node
// MCP server stress test for v1.11.1 release validation.
//
// Spawns dist/mcp-server.js via stdio, fires N mixed tool calls in batches
// with periodic parallel sub-batches, interleaves CLI writes via dist/index.js
// to exercise concurrent-writer paths, measures per-call timings, and reports
// any anomalies (errors, slow calls, slowdown over time).
//
// Uses an isolated RVR_PROJECT + RVR_DATA_DIR pointing at a temp dir so
// the real .reverie/ store and audit log are untouched.
//
// Env knobs:
//   STRESS_ITERATIONS  number of main-loop iterations            (default 2000)
//   STRESS_BATCH_SIZE  parallel calls per batch                  (default 5)
//   STRESS_TIMEOUT     per-call timeout in ms                    (default 5000)
//   STRESS_SLOW_MS     calls slower than this are flagged        (default 2000)
//   STRESS_CLI_EVERY   spawn a CLI writer every N iterations     (default 50)

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const SERVER_ENTRY = join(REPO_ROOT, 'dist', 'mcp-server.js');
const CLI_ENTRY = join(REPO_ROOT, 'dist', 'index.js');

const ITERATIONS = parseInt(process.env.STRESS_ITERATIONS || '2000', 10);
const BATCH_SIZE = parseInt(process.env.STRESS_BATCH_SIZE || '5', 10);
const PER_CALL_TIMEOUT_MS = parseInt(process.env.STRESS_TIMEOUT || '5000', 10);
const SLOW_THRESHOLD_MS = parseInt(process.env.STRESS_SLOW_MS || '2000', 10);
const CLI_INTERLEAVE_EVERY = parseInt(process.env.STRESS_CLI_EVERY || '50', 10);
const PRE_POPULATE = 20;
const WARMUP = 20;
const NO_GROWTH = process.env.STRESS_NO_GROWTH === '1';
const NO_LOG_QUERY = process.env.STRESS_NO_LOG_QUERY === '1';

// --- isolated temp project setup ---------------------------------------------
const TEMP_DIR = mkdtempSync(join(tmpdir(), 'reverie-stress-'));
const PROJECT_DIR = join(TEMP_DIR, 'project');
const STORE_DIR = join(PROJECT_DIR, '.reverie');
mkdirSync(STORE_DIR, { recursive: true });

let cleanedUp = false;
function cleanup() {
  if (cleanedUp) return;
  cleanedUp = true;
  try { rmSync(TEMP_DIR, { recursive: true, force: true }); }
  catch (e) { console.error('[stress] cleanup failed:', e.message); }
}
process.on('exit', cleanup);
process.on('SIGINT',  () => { cleanup(); process.exit(130); });
process.on('SIGTERM', () => { cleanup(); process.exit(143); });

const isolatedEnv = {
  ...process.env,
  RVR_PROJECT: PROJECT_DIR,
  RVR_DATA_DIR: TEMP_DIR,
  RVR_AGENT_NAME: 'stress-test',
};

console.log(`[stress] temp project:  ${PROJECT_DIR}`);
console.log(`[stress] iterations:    ${ITERATIONS}`);
console.log(`[stress] batch size:    ${BATCH_SIZE} (every 10th iter)`);
console.log(`[stress] per-call to:   ${PER_CALL_TIMEOUT_MS}ms`);
console.log(`[stress] slow flag:     ${SLOW_THRESHOLD_MS}ms`);
console.log(`[stress] cli interleave: every ${CLI_INTERLEAVE_EVERY} iters`);
console.log('');

// --- spawn server + connect --------------------------------------------------
const transport = new StdioClientTransport({
  command: 'node',
  args: [SERVER_ENTRY],
  env: isolatedEnv,
  stderr: 'pipe',
});

const client = new Client(
  { name: 'reverie-stress-test', version: '1.0.0' },
  { capabilities: {} },
);

await client.connect(transport);
const tools = await client.listTools();
console.log(`[stress] connected — server reports ${tools.tools.length} tools`);

// --- helpers -----------------------------------------------------------------
function randInt(n) { return Math.floor(Math.random() * n); }

async function callWithTimeout(name, args) {
  const t0 = performance.now();
  let timer;
  const timeoutP = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`TIMEOUT (${PER_CALL_TIMEOUT_MS}ms)`)),
      PER_CALL_TIMEOUT_MS,
    );
  });
  try {
    const result = await Promise.race([
      client.callTool({ name, arguments: args }),
      timeoutP,
    ]);
    clearTimeout(timer);
    return {
      ok: !result.isError,
      durationMs: performance.now() - t0,
      name,
    };
  } catch (e) {
    clearTimeout(timer);
    return {
      ok: false,
      durationMs: performance.now() - t0,
      name,
      error: e.message,
    };
  }
}

function spawnCliWrite(idx) {
  return new Promise((resolveP) => {
    const child = spawn(
      'node',
      [CLI_ENTRY, 'set', `stress.cli.w${idx}`, `cli-${Date.now()}`],
      { env: { ...isolatedEnv, RVR_AGENT_NAME: 'stress-cli' }, stdio: 'ignore' },
    );
    child.on('exit',  (code) => resolveP({ code: code ?? -1, idx }));
    child.on('error', () => resolveP({ code: -1, idx }));
  });
}

// --- pre-populate ------------------------------------------------------------
console.log(`[stress] pre-populating ${PRE_POPULATE} entries...`);
for (let i = 0; i < PRE_POPULATE; i++) {
  await client.callTool({
    name: 'reverie_set',
    arguments: { key: `stress.entry.e${i}`, value: `seed-${i}` },
  });
}
await client.callTool({
  name: 'reverie_alias_set',
  arguments: { alias: 'stress-alpha', key: 'stress.entry.e0' },
});

// --- weighted op registry ----------------------------------------------------
const ops = [
  { w: 30, fn: () => callWithTimeout('reverie_get',       { key: `stress.entry.e${randInt(PRE_POPULATE)}` }) },
  { w: 15, fn: () => callWithTimeout('reverie_set',       { key: `stress.entry.e${randInt(PRE_POPULATE)}`, value: `v${Date.now()}-${randInt(10000)}` }) },
  { w: 10, fn: () => callWithTimeout('reverie_find',      { query: 'stress' }) },
  { w: NO_LOG_QUERY ? 0 : 10, fn: () => callWithTimeout('reverie_audit',     { limit: 50, key: 'stress' }) },
  { w:  5, fn: () => callWithTimeout('reverie_context',   { tier: 'standard' }) },
  { w: NO_LOG_QUERY ? 0 : 5, fn: () => callWithTimeout('reverie_stats',     { period: '7d', detailed: true }) },
  { w:  5, fn: () => callWithTimeout('reverie_stale',     { days: 30 }) },
  { w:  5, fn: () => callWithTimeout('reverie_alias_list', {}) },
  { w:  5, fn: () => callWithTimeout('reverie_export',    { type: 'entries' }) },
  { w:  5, fn: () => callWithTimeout('reverie_get',       {}) }, // list all
  { w: NO_GROWTH ? 0 : 3, fn: () => callWithTimeout('reverie_copy',      { source: `stress.entry.e${randInt(PRE_POPULATE)}`, dest: `stress.copy.c${Date.now()}${randInt(10000)}`, force: true }) },
  { w: NO_GROWTH ? 0 : 2, fn: () => callWithTimeout('reverie_alias_set', { alias: `stress-${randInt(1000)}`, key: 'stress.entry.e0' }) },
];
const totalW = ops.reduce((s, o) => s + o.w, 0);
function pickOp() {
  let r = Math.random() * totalW;
  for (const o of ops) {
    r -= o.w;
    if (r <= 0) return o;
  }
  return ops[0];
}

// --- main loop ---------------------------------------------------------------
const results = [];
const errors = [];
const slowCalls = [];
const cliWrites = [];

const startedAt = performance.now();
let lastProgressLog = startedAt;

console.log(`[stress] starting main loop (${ITERATIONS} iters)...\n`);
for (let i = 0; i < ITERATIONS; i++) {
  // Every 10th iter: parallel batch (this is the historical freeze trigger)
  const isParallelBatch = i > 0 && i % 10 === 0;

  if (isParallelBatch) {
    const batch = Array.from({ length: BATCH_SIZE }, () => pickOp().fn());
    const batchResults = await Promise.all(batch);
    for (const r of batchResults) {
      results.push(r);
      if (!r.ok) errors.push({ ...r, iter: i });
      if (r.durationMs > SLOW_THRESHOLD_MS) slowCalls.push({ ...r, iter: i, parallel: true });
    }
  } else {
    const r = await pickOp().fn();
    results.push(r);
    if (!r.ok) errors.push({ ...r, iter: i });
    if (r.durationMs > SLOW_THRESHOLD_MS) slowCalls.push({ ...r, iter: i, parallel: false });
  }

  // Interleave CLI writes (concurrent writer simulation) — uses overwrite-pattern
  // when NO_GROWTH is set to keep store size constant
  if (i > 0 && i % CLI_INTERLEAVE_EVERY === 0) {
    cliWrites.push(spawnCliWrite(NO_GROWTH ? (i % 5) : i));
  }

  // Progress
  const now = performance.now();
  if (now - lastProgressLog > 5000 || i === ITERATIONS - 1) {
    const elapsed = ((now - startedAt) / 1000).toFixed(1);
    console.log(
      `[stress] iter ${String(i + 1).padStart(5)}/${ITERATIONS}  ` +
      `${elapsed}s elapsed  errs=${errors.length}  slow=${slowCalls.length}`,
    );
    lastProgressLog = now;
  }
}

const cliResults = await Promise.all(cliWrites);
const cliFailed = cliResults.filter((r) => r.code !== 0).length;
const totalElapsedMs = performance.now() - startedAt;

// --- stats -------------------------------------------------------------------
const measured = results.slice(WARMUP); // exclude warmup
const durations = measured.map((r) => r.durationMs).sort((a, b) => a - b);
const pct = (p) => durations[Math.min(durations.length - 1, Math.floor(durations.length * p))];
const mean = durations.reduce((s, d) => s + d, 0) / durations.length;
const median = pct(0.50);
const p95 = pct(0.95);
const p99 = pct(0.99);
const max = durations[durations.length - 1];

// Slowdown detection: first 200 vs last 200 mean
const sliceSize = Math.min(200, Math.floor(measured.length / 4));
const firstSlice = measured.slice(0, sliceSize).map((r) => r.durationMs);
const lastSlice  = measured.slice(-sliceSize).map((r) => r.durationMs);
const firstMean  = firstSlice.reduce((s, d) => s + d, 0) / firstSlice.length;
const lastMean   = lastSlice.reduce((s, d) => s + d, 0) / lastSlice.length;
const slowdown   = lastMean / firstMean;

const perTool = {};
for (const r of measured) {
  const t = perTool[r.name] ??= { count: 0, totalMs: 0, errors: 0, max: 0 };
  t.count++;
  t.totalMs += r.durationMs;
  if (!r.ok) t.errors++;
  if (r.durationMs > t.max) t.max = r.durationMs;
}

// --- report ------------------------------------------------------------------
console.log('\n=== MCP Stress Test Report ===');
console.log(`Total calls:    ${results.length}  (${WARMUP} warmup excluded from latency stats)`);
console.log(`Duration:       ${(totalElapsedMs / 1000).toFixed(1)}s`);
console.log(`Throughput:     ${(results.length / (totalElapsedMs / 1000)).toFixed(1)} calls/s`);
console.log('');
console.log('Latency (post-warmup):');
console.log(`  mean:    ${mean.toFixed(1)}ms`);
console.log(`  median:  ${median.toFixed(1)}ms`);
console.log(`  p95:     ${p95.toFixed(1)}ms`);
console.log(`  p99:     ${p99.toFixed(1)}ms`);
console.log(`  max:     ${max.toFixed(1)}ms`);
console.log('');
console.log('Anomalies:');
console.log(`  Errors:           ${errors.length}`);
console.log(`  Calls > ${SLOW_THRESHOLD_MS}ms:    ${slowCalls.length}`);
console.log(`  Slowdown ratio:   ${slowdown.toFixed(2)}x  (last ${sliceSize} mean ÷ first ${sliceSize} mean)`);
console.log('');
console.log('Concurrent CLI writes:');
console.log(`  Total: ${cliResults.length}  Failed: ${cliFailed}`);
console.log('');
console.log('Per-tool breakdown:');
const sortedTools = Object.entries(perTool).sort((a, b) => b[1].count - a[1].count);
for (const [name, s] of sortedTools) {
  console.log(
    `  ${name.padEnd(20)} ${String(s.count).padStart(5)} calls   ` +
    `mean ${(s.totalMs / s.count).toFixed(1).padStart(7)}ms   ` +
    `max ${s.max.toFixed(0).padStart(5)}ms   errs ${s.errors}`,
  );
}

if (slowCalls.length > 0) {
  console.log('\nSlow calls (first 10):');
  for (const c of slowCalls.slice(0, 10)) {
    console.log(
      `  iter ${c.iter}  ${c.name}  ${c.durationMs.toFixed(0)}ms` +
      `${c.parallel ? '  (parallel)' : ''}` +
      `${c.error ? `  ${c.error}` : ''}`,
    );
  }
}

if (errors.length > 0) {
  console.log('\nErrors (first 10):');
  for (const e of errors.slice(0, 10)) {
    console.log(`  iter ${e.iter}  ${e.name}  ${e.error || '(returned isError)'}`);
  }
}

// --- verdict -----------------------------------------------------------------
console.log('');
const passed =
  errors.length === 0 &&
  slowCalls.length === 0 &&
  slowdown < 2.0;

console.log(`VERDICT: ${passed ? 'PASS' : 'REVIEW'}`);
if (!passed) {
  console.log('Reasons:');
  if (errors.length > 0)     console.log(`  - ${errors.length} errors`);
  if (slowCalls.length > 0)  console.log(`  - ${slowCalls.length} calls exceeded ${SLOW_THRESHOLD_MS}ms`);
  if (slowdown >= 2.0)       console.log(`  - slowdown ratio ${slowdown.toFixed(2)}x suggests cache/state leak`);
}

await client.close();
cleanup();
process.exit(passed ? 0 : 1);
