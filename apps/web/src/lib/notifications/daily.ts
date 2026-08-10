export type WeeklySummaryCounts = {
  applied: number
  interviews: number
  offers: number
  rejections: number
  newJobs: number
}

export function utcWeekKey(value: Date): string {
  const date = new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()))
  const day = date.getUTCDay() || 7
  date.setUTCDate(date.getUTCDate() + 4 - day)
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1))
  const week = Math.ceil((((date.getTime() - yearStart.getTime()) / 86_400_000) + 1) / 7)
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}

export function isWeeklySummaryDay(value: Date): boolean {
  return value.getUTCDay() === 1
}

export function dailyNotificationId(kind: 'weekly' | 'follow-up', userId: string, key: string): string {
  return `daily:${kind}:${userId}:${key}`
}

export function formatWeeklySummary(counts: WeeklySummaryCounts): { title: string; body: string } {
  return {
    title: 'Your ApplyMate weekly summary',
    body: `${counts.applied} applications, ${counts.interviews} interview${counts.interviews === 1 ? '' : 's'}, ${counts.offers} offer${counts.offers === 1 ? '' : 's'}, ${counts.rejections} rejection${counts.rejections === 1 ? '' : 's'}, ${counts.newJobs} new jobs.`,
  }
}

export function weekStartUtc(value: Date): Date {
  const result = new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()))
  const day = result.getUTCDay() || 7
  result.setUTCDate(result.getUTCDate() - day + 1)
  return result
}
