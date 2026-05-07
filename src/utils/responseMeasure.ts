/**
 * Process-scoped byte counter for measuring CLI response output size.
 *
 * The CLI instrumentation wrapper (`withCliInstrumentation`) calls
 * {@link startResponseMeasure} before invoking a handler and
 * {@link endResponseMeasure} in its `finally` block. While measurement is
 * active, every call to {@link addResponseBytes} contributes to the running
 * total. The wrapper monkey-patches `process.stdout.write` to call
 * `addResponseBytes` for every byte that flows through, and `withPager`
 * (which intercepts `process.stdout.write` itself for buffering) calls
 * `addResponseBytes` directly when it flushes to the spawned pager process.
 *
 * Why a state machine instead of always-on counting:
 *
 *   - When measurement is OFF (counter is `null`), `addResponseBytes` is a
 *     cheap no-op. Other code paths (`withPager`, etc.) can call it
 *     unconditionally without coordinating with the wrapper.
 *   - The wrapper has explicit start/end semantics, so the lifetime of a
 *     measurement is bounded to a single tool invocation — no leaking
 *     counts across calls.
 *   - JavaScript is single-threaded, so a process-level counter is safe.
 *     If we ever move to a worker-thread model, this needs to become
 *     async-local-storage scoped instead.
 *
 * Why this matters: prior to v1.11.x, the CLI wrapper computed
 * `responseSize` from the `after` value, which was only set for writes —
 * so every CLI **read** silently logged `responseSize: undefined`, which in
 * turn meant `reverie_stats` undercounted the delivery cost of CLI traffic.
 * MCP reads were measured correctly via `extractResponseText(result)`. This
 * module unifies the semantic so both CLI and MCP measure "bytes the user
 * actually received" the same way.
 */

let bytes: number | null = null;

/** Begin a measurement. Subsequent {@link addResponseBytes} calls accumulate. */
export function startResponseMeasure(): void {
  bytes = 0;
}

/**
 * Add `n` bytes to the active measurement. No-op when no measurement is
 * active — safe to call from arbitrary write paths (e.g. `withPager`'s
 * paged-output flush) without checking whether the wrapper installed one.
 */
export function addResponseBytes(n: number): void {
  if (bytes !== null) bytes += n;
}

/**
 * End the active measurement and return the accumulated byte count, or
 * `undefined` if no measurement was active. Resets state so the next
 * call to {@link startResponseMeasure} starts fresh.
 */
export function endResponseMeasure(): number | undefined {
  if (bytes === null) return undefined;
  const result = bytes;
  bytes = null;
  return result;
}
