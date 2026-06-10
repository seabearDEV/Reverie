const PERIOD_DAYS: Record<string, number> = { '7d': 7, '30d': 30, '90d': 90, 'all': 0 };

/** Convert a period string ('7d', '30d', '90d', 'all') to days (0 = all time). */
export function parsePeriodDays(period?: string): number {
  return PERIOD_DAYS[period ?? '30d'] ?? 30;
}
