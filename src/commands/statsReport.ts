import type { TelemetryStats } from '../utils/telemetry';

/**
 * Text decorators applied to the stats report. The CLI passes wrappers
 * around its `color` helpers; the MCP server uses the identity palette
 * (plain text). Threshold logic (which metric is good/warn/bad) lives
 * here in the shared formatter, not in the palette.
 */
export interface StatsPalette {
  /** Section headers (CLI: bold). */
  header: (text: string) => string;
  /** Plain metric values (CLI: white). */
  value: (text: string) => string;
  /** De-emphasized lines (CLI: gray). */
  dim: (text: string) => string;
  /** Healthy metric (CLI: green). */
  good: (text: string) => string;
  /** Borderline metric (CLI: yellow). */
  warn: (text: string) => string;
  /** Unhealthy metric (CLI: red). */
  bad: (text: string) => string;
}

const identity = (text: string): string => text;

export const identityPalette: StatsPalette = {
  header: identity,
  value: identity,
  dim: identity,
  good: identity,
  warn: identity,
  bad: identity,
};

export interface StatsReportOptions {
  /** Include namespace activity, project breakdown, agent activity, and top tools. */
  detailed: boolean;
  /** Defaults to the identity palette (plain text). */
  palette?: StatsPalette;
}

/** Format token counts: 1500 -> "1.5K". */
const fmtNum = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n));

/** Format a trend delta with explicit sign: 12.3 -> "+12%". */
const fmtDelta = (v: number | undefined, suffix = '%'): string | undefined => {
  if (v === undefined) return undefined;
  const sign = v >= 0 ? '+' : '';
  return `${sign}${v.toFixed(0)}${suffix}`;
};

/**
 * Render the full stats report from a computeStats() result as an array of
 * lines (no leading/trailing blank lines, no trailing newlines per line).
 *
 * Canonical section order: header block -> namespace activity -> project
 * activity -> session metrics -> token savings -> agent activity -> top
 * tools -> trend. Detailed-only sections are skipped unless opts.detailed.
 *
 * Callers handle the zero-data case (stats.totalCalls === 0) themselves —
 * the two surfaces deliberately use different empty-state messages.
 */
export function formatStatsReport(stats: TelemetryStats, opts: StatsReportOptions): string[] {
  const { detailed } = opts;
  const p = opts.palette ?? identityPalette;
  const lines: string[] = [];

  // --- Header block ---
  lines.push(p.header(`Reverie Usage Stats (${stats.period === 'all' ? 'all time' : `last ${stats.period}`})`));
  lines.push('');
  lines.push(`  MCP sessions:    ${p.value(String(stats.mcpSessions))}`);
  lines.push(`  MCP calls:       ${p.value(String(stats.mcpCalls))}`);

  if (stats.mcpSessions > 0) {
    const bootstrapColor = stats.bootstrapRate >= 0.8 ? p.good : stats.bootstrapRate >= 0.5 ? p.warn : p.bad;
    lines.push(`    Bootstrap rate:  ${bootstrapColor(`${(stats.bootstrapRate * 100).toFixed(0)}%`)} of MCP sessions call reverie_context first`);

    const writeBackColor = stats.writeBackRate >= 0.5 ? p.good : stats.writeBackRate >= 0.25 ? p.warn : p.bad;
    lines.push(`    Write-back rate: ${writeBackColor(`${(stats.writeBackRate * 100).toFixed(0)}%`)} of MCP sessions store at least 1 entry`);
  }

  lines.push(`  CLI calls:       ${p.value(String(stats.cliCalls))}`);
  lines.push(`  Total calls:     ${p.value(String(stats.totalCalls))}`);
  lines.push(`  Read:write:      ${p.value(stats.readWriteRatio)} (${stats.reads} reads, ${stats.writes} writes, ${stats.removes} removes, ${stats.execs} execs)`);

  const { project, global: glob, unscoped } = stats.scopeBreakdown;
  if (project > 0 || glob > 0) {
    const parts: string[] = [];
    if (project > 0) parts.push(`${project} project`);
    if (glob > 0) parts.push(`${glob} global`);
    if (unscoped > 0) parts.push(`${unscoped} unscoped`);
    lines.push(`  Scope:           ${p.value(parts.join(', '))}`);
  }

  // --- Namespace activity (detailed) ---
  if (detailed && Object.keys(stats.namespaceCoverage).length > 0) {
    lines.push('');
    lines.push(p.header('Namespace activity:'));
    const sorted = Object.entries(stats.namespaceCoverage)
      .sort(([, a], [, b]) => (b.reads + b.writes) - (a.reads + a.writes));
    for (const [ns, data] of sorted) {
      const age = data.lastWrite ? `${Math.floor((Date.now() - data.lastWrite) / 86400000)}d ago` : 'never';
      const ageColor = data.lastWrite && (Date.now() - data.lastWrite) < 7 * 86400000 ? p.good : p.dim;
      lines.push(`  ${p.value(ns.padEnd(20))} ${String(data.reads).padStart(3)} reads  ${String(data.writes).padStart(3)} writes  last write: ${ageColor(age)}`);
    }
  }

  // --- Project activity (detailed) ---
  if (detailed) {
    const projects = Object.entries(stats.projectBreakdown);
    if (projects.length > 0) {
      lines.push('');
      lines.push(p.header('Project activity:'));
      const sortedProjects = projects.sort(([, a], [, b]) => b - a);
      for (const [proj, count] of sortedProjects) {
        const label = proj.split('/').slice(-2).join('/'); // last 2 path segments
        lines.push(`  ${p.value(label.padEnd(30))} ${count} calls`);
      }
    }
  }

  // --- Session metrics ---
  if (stats.avgSessionCalls !== undefined || stats.avgSessionDurationMs !== undefined) {
    lines.push('');
    lines.push(p.header('Session metrics:'));
    if (stats.avgSessionCalls !== undefined)
      lines.push(`  Avg calls/session: ${p.value(stats.avgSessionCalls.toFixed(1))}`);
    if (stats.avgSessionDurationMs !== undefined) {
      const secs = stats.avgSessionDurationMs / 1000;
      const label = secs < 60 ? `${secs.toFixed(1)}s` : `${(secs / 60).toFixed(1)}m`;
      lines.push(`  Avg session duration: ${p.value(label)}`);
    }
  }

  // --- Token savings ---
  const hasEfficiency = stats.hitRate !== undefined || stats.redundantRate !== undefined || stats.totalResponseBytes > 0 || stats.avgDurationMs !== undefined;
  if (hasEfficiency) {
    lines.push('');
    lines.push(p.header('Token savings:'));
    if (stats.hitRate !== undefined) {
      const hitColor = stats.hitRate >= 0.8 ? p.good : stats.hitRate >= 0.5 ? p.warn : p.bad;
      lines.push(`  Lookup hit rate:   ${hitColor(`${(stats.hitRate * 100).toFixed(0)}%`)} of reads found stored data (${stats.hits} hits, ${stats.misses} misses)`);
    }
    if (stats.redundantRate !== undefined && stats.writes > 0) {
      const redColor = stats.redundantRate <= 0.1 ? p.good : stats.redundantRate <= 0.3 ? p.warn : p.bad;
      lines.push(`  Duplicate writes:  ${redColor(`${(stats.redundantRate * 100).toFixed(0)}%`)} of writes were already up to date (${stats.redundantWrites} of ${stats.writes})`);
    }
    if (stats.totalResponseBytes > 0) {
      const kb = stats.totalResponseBytes / 1024;
      const bytesStr = kb >= 1 ? `${kb.toFixed(1)}KB` : `${stats.totalResponseBytes}B`;
      lines.push(`  Data served:       ${p.value(bytesStr)} returned from store${stats.avgResponseBytes !== undefined ? `, ${Math.round(stats.avgResponseBytes)}B avg` : ''}`);
    }
    if (stats.avgDurationMs !== undefined)
      lines.push(`  Avg latency:       ${p.value(`${Math.round(stats.avgDurationMs)}ms`)} per call`);
    if (stats.estimatedTotalTokensSaved > 0) {
      lines.push(`  Est. tokens saved: ${p.good(`~${fmtNum(stats.estimatedTotalTokensSaved)}`)} (exploration avoided by using stored knowledge)`);
      lines.push(`    Delivery cost:   ${p.value(`~${fmtNum(stats.deliveryCostTokens)}`)} tokens (context delivered to agent)`);
      const netColor = stats.netTokensSaved >= 0 ? p.good : p.bad;
      lines.push(`    Net savings:     ${netColor(`~${fmtNum(stats.netTokensSaved)}`)} tokens`);
      if (detailed) {
        lines.push('    By namespace:');
        const breakdown = Object.entries(stats.explorationBreakdown)
          .sort(([, a], [, b]) => b.tokensSaved - a.tokensSaved);
        for (const [ns, { hits, tokensSaved }] of breakdown) {
          const perHit = hits > 0 ? Math.round(tokensSaved / hits) : 0;
          const cal = stats.calibration[ns];
          const calTag = cal ? (cal.source === 'observed' ? ` [observed, n=${cal.samples}]` : ' [static]') : '';
          lines.push(`      ${p.dim(`${ns.padEnd(15)} ~${fmtNum(tokensSaved)} (${hits} lookup${hits !== 1 ? 's' : ''} × ${fmtNum(perHit)} each)${calTag}`)}`);
        }
        if (stats.estimatedRedundantWriteTokensSaved > 0) {
          lines.push(`    ${p.dim(`Duplicate writes avoided: ~${fmtNum(stats.estimatedRedundantWriteTokensSaved)} (${stats.redundantWrites} write${stats.redundantWrites !== 1 ? 's' : ''} already up to date)`)}`);
        }
        const calEntries = Object.values(stats.calibration);
        if (calEntries.length > 0) {
          const observed = calEntries.filter(c => c.source === 'observed').length;
          const total = calEntries.length;
          lines.push(`    ${p.dim(`Calibration: ${observed}/${total} namespaces observed, ${total - observed} static`)}`);
        }
      }
    } else if (stats.estimatedTokensSaved > 0) {
      lines.push(`  Est. tokens saved: ${p.good(`~${fmtNum(stats.estimatedTokensSaved)}`)} (cached data served to agents)`);
    }
  }

  // --- Agent activity (detailed) ---
  const agents = Object.entries(stats.agentBreakdown);
  if (detailed && agents.length > 0) {
    lines.push('');
    lines.push(p.header('Agent activity:'));
    for (const [agent, data] of agents.sort(([, a], [, b]) => b.calls - a.calls)) {
      lines.push(`  ${p.value(agent.padEnd(24))} ${data.calls} calls (${data.reads}R ${data.writes}W)`);
    }
  }

  // --- Top tools (detailed) ---
  if (detailed && stats.topTools.length > 0) {
    lines.push('');
    lines.push(p.header('Top tools:'));
    for (const { tool, count } of stats.topTools) {
      lines.push(`  ${p.value(tool.padEnd(24))} ${count} calls`);
    }
  }

  // --- Trend comparison ---
  if (stats.trend) {
    const t = stats.trend;
    const trendParts: string[] = [];
    const cd = fmtDelta(t.callsDelta);
    if (cd) trendParts.push(`calls ${cd}`);
    const sd = fmtDelta(t.sessionsDelta);
    if (sd) trendParts.push(`sessions ${sd}`);
    const hd = fmtDelta(t.hitRateDelta, 'pp');
    if (hd) trendParts.push(`hit rate ${hd}`);
    const dd = fmtDelta(t.avgDurationDelta);
    if (dd) trendParts.push(`latency ${dd}`);
    if (trendParts.length > 0) {
      lines.push('');
      lines.push(p.dim(`Trend (vs prev ${stats.period}): ${trendParts.join(', ')}`));
    }
  }

  return lines;
}
