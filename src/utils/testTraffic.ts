/**
 * Test-traffic marker (#130). When RVR_TEST is set, telemetry/audit rows are
 * tagged `test: true` rather than skipped — the log stays append-only
 * evidence, and stats/audit exclude tagged rows by default. Defense in depth
 * alongside RVR_DATA_DIR redirection: even if a harness regression lets test
 * traffic reach the real store, the rows stay identifiable.
 */
export function isTestRun(): boolean {
  const v = process.env.RVR_TEST;
  return v === '1' || v === 'true';
}
