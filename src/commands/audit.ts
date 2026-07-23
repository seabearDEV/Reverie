import fs from 'fs';
import path from 'path';
import { queryAuditLog, tailAuditLog, getAuditPath, AuditEntry } from '../utils/audit';
import { parsePeriodDays } from '../utils';
import { color } from '../formatting';
import { isJsonMode, setResult } from '../utils/output';

export interface AuditCommandOptions {
  period?: string;
  writes?: boolean;
  mcp?: boolean;
  cli?: boolean;
  json?: boolean;
  limit?: number;
  project?: string;
  hits?: boolean;
  misses?: boolean;
  redundant?: boolean;
  detailed?: boolean;
  follow?: boolean;
  includeTest?: boolean;
  includeSelfRef?: boolean;
}

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function formatTs(ts: number): { date: string; time: string } {
  const d = new Date(ts);
  const date = `${MONTHS[d.getMonth()]} ${String(d.getDate()).padStart(2, '0')}`;
  const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return { date, time };
}

function shortTool(tool: string): string {
  return tool.replace(/^codex_/, '');
}

function srcLabel(entry: AuditEntry): string {
  if (entry.src === 'mcp') {
    return entry.agent ? `mcp/${entry.agent}` : 'mcp';
  }
  return 'cli';
}

function projectLabel(entry: AuditEntry): string {
  if (!entry.project) return '';
  return path.basename(entry.project);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  return `${(bytes / 1024).toFixed(1)}K`;
}

function metricsLine(entry: AuditEntry): string {
  const tags: string[] = [];
  if (entry.duration !== undefined) tags.push(`${entry.duration}ms`);
  if (entry.aliasResolved) tags.push(`alias\u2192${entry.aliasResolved}`);
  if (entry.responseSize !== undefined) tags.push(`res=${formatBytes(entry.responseSize)}`);
  if (entry.requestSize !== undefined) tags.push(`req=${formatBytes(entry.requestSize)}`);
  if (entry.hit !== undefined) tags.push(entry.hit ? 'hit' : 'miss');
  if (entry.tier !== undefined) tags.push(`tier=${entry.tier}`);
  if (entry.entryCount !== undefined) tags.push(`n=${entry.entryCount}`);
  if (entry.redundant) tags.push('redundant');
  return tags.length > 0 ? tags.join('  ') : '';
}

function truncate(str: string, maxLen: number): string {
  if (maxLen <= 0 || str.length <= maxLen) return str;
  return str.slice(0, maxLen - 1) + '\u2026';
}

// ── Shared formatting ──────────────────────────────────────────────

interface FormatContext {
  lastDate: string;
  showProject: boolean;
  detailed: boolean;
  diffMax: number;
}

/**
 * Format a single audit entry into printable lines.
 * Mutates ctx.lastDate for date collapsing across consecutive entries.
 */
function formatAuditEntry(entry: AuditEntry, ctx: FormatContext): string[] {
  const { date, time } = formatTs(entry.ts);
  const hasDiff = entry.before !== undefined || entry.after !== undefined || entry.error;

  const dateCol = date === ctx.lastDate ? '      ' : color.white(date);
  ctx.lastDate = date;

  const timeCol = color.gray(time);
  const tool = shortTool(entry.tool);
  const keyStr = entry.key ? color.cyan(entry.key) : color.gray('(bulk)');
  const srcStr = color.gray(srcLabel(entry));
  const status = entry.success ? color.green('OK') : color.red('FAIL');
  const scope = entry.scope && entry.scope !== 'auto' ? `  ${color.gray('[' + entry.scope + ']')}` : '';
  const proj = ctx.showProject ? `  ${color.gray(projectLabel(entry) || 'global')}` : '';

  const lines: string[] = [];
  lines.push(`${dateCol} ${timeCol}  ${tool}  ${keyStr}  ${srcStr}  ${status}${scope}${proj}`);

  const pad = ' '.repeat(14); // "Mon DD " (7) + "HH:MM" (5) + "  " (2) = 14
  if (entry.before !== undefined) {
    lines.push(`${pad}${color.red('- ' + truncate(entry.before, ctx.diffMax))}`);
  }
  if (entry.after !== undefined) {
    lines.push(`${pad}${color.green('+ ' + truncate(entry.after, ctx.diffMax))}`);
  }
  if (entry.error) {
    lines.push(`${pad}${color.red('error: ' + truncate(entry.error, ctx.diffMax))}`);
  }
  const metrics = ctx.detailed ? metricsLine(entry) : '';
  if (metrics) {
    lines.push(`${pad}${color.gray(metrics)}`);
  }
  if (hasDiff || metrics) lines.push('');

  return lines;
}

// ── Snapshot mode ──────────────────────────────────────────────────

export function showAuditLog(key: string | undefined, options: AuditCommandOptions): void {
  const days = parsePeriodDays(options.period);
  const limit = options.limit ?? 50;

  const src = options.mcp ? 'mcp' as const : options.cli ? 'cli' as const : undefined;

  const entries = queryAuditLog({
    key,
    periodDays: days,
    writesOnly: options.writes,
    src,
    project: options.project,
    hitsOnly: options.hits,
    missesOnly: options.misses,
    redundantOnly: options.redundant,
    limit,
    includeTest: options.includeTest,
    includeSelfRef: options.includeSelfRef,
  });

  if (isJsonMode()) {
    setResult(entries);
    return;
  }

  if (entries.length === 0) {
    console.log(color.gray('No audit entries found.'));
    return;
  }

  const periodLabel = options.period === 'all' ? 'all time' : `last ${options.period ?? '30d'}`;
  console.log(color.bold(`\nAudit Log \u2014 ${periodLabel}, ${entries.length} entries\n`));

  const termWidth = process.stdout.columns || 80;
  const diffMax = termWidth - 14 - 2;

  const projectNames = new Set(entries.map(e => e.project ?? ''));
  const showProject = projectNames.size > 1 || (projectNames.size === 1 && !projectNames.has(''));

  const ctx: FormatContext = { lastDate: '', showProject, detailed: Boolean(options.detailed), diffMax };

  for (const entry of entries) {
    for (const line of formatAuditEntry(entry, ctx)) {
      console.log(line);
    }
  }

  // Trailing newline if last entry didn't already add one via diff/metrics
  const last = entries[entries.length - 1];
  const lastHasDetail = last.before !== undefined || last.after !== undefined || Boolean(last.error) || Boolean(options.detailed && metricsLine(last));
  if (!lastHasDetail) {
    console.log('');
  }
}

// ── Follow mode ────────────────────────────────────────────────────

function matchesFilter(entry: AuditEntry, options: AuditCommandOptions, key: string | undefined): boolean {
  const keyPrefix = key ? key + '.' : undefined;
  return (
    (options.includeTest === true || entry.test !== true) &&
    // Self-exclusion (#134): follow mode does not stream the observability
    // calls of other shells watching the same log unless asked to.
    (options.includeSelfRef === true || entry.selfRef !== true) &&
    (!key || entry.key === key || !!entry.key?.startsWith(keyPrefix!)) &&
    (!options.writes || entry.op === 'write') &&
    (!options.mcp || entry.src === 'mcp') &&
    (!options.cli || entry.src === 'cli') &&
    (!options.project || entry.project === options.project) &&
    (!options.hits || entry.hit === true) &&
    (!options.misses || entry.hit === false) &&
    (!options.redundant || entry.redundant === true)
  );
}

export function followAuditLog(key: string | undefined, options: AuditCommandOptions): Promise<void> {
  const auditPath = getAuditPath();
  const termWidth = process.stdout.columns || 80;
  const diffMax = termWidth - 14 - 2;
  const ctx: FormatContext = { lastDate: '', showProject: true, detailed: Boolean(options.detailed), diffMax };

  console.log(color.bold('\nFollowing audit log\u2026 (Ctrl+C to stop)\n'));

  // Drain any entries already in the cache so tailAuditLog starts clean
  tailAuditLog();

  // JSON mode is refused upstream (audit --follow can't satisfy the
  // single-envelope contract), so this only ever renders the human stream.
  const onFileChange = (): void => {
    const newEntries = tailAuditLog();
    for (const entry of newEntries) {
      if (!matchesFilter(entry, options, key)) continue;
      for (const line of formatAuditEntry(entry, ctx)) {
        console.log(line);
      }
    }
  };

  fs.watchFile(auditPath, { interval: 250 }, onFileChange);

  return new Promise<void>((resolve) => {
    const cleanup = (): void => {
      fs.unwatchFile(auditPath, onFileChange);
      console.log('');
      resolve();
    };
    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);
  });
}
