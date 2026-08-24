export type QuotaPeriod = 'week' | 'month'

export function quotaPeriodBounds(period: QuotaPeriod, resetDay: number, now = new Date()) {
  const end = new Date(now)
  let start: Date
  if (period === 'week') {
    const day = Math.min(6, Math.max(0, Math.trunc(resetDay)))
    const daysSinceReset = (now.getUTCDay() - day + 7) % 7
    start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - daysSinceReset))
    end.setTime(start.getTime() + 7 * 86_400_000)
  } else {
    const day = Math.min(28, Math.max(1, Math.trunc(resetDay)))
    const currentReset = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), day))
    start = now >= currentReset ? currentReset : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, day))
    end.setTime(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, day))
  }
  return { start, end }
}
