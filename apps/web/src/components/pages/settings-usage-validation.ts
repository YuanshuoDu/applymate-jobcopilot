import type { PersonalUsage, PersonalUsageDays, UsageTotals } from '@/lib/personal-usage'

export interface PersonalActivity { id: string; text: string; createdAt: string }
export interface PersonalActivityResponse { ownerId: string; items: PersonalActivity[] }

const DAY_MS = 86_400_000

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function dateOnly(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const time = Date.parse(`${value}T00:00:00.000Z`)
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value
}

function instant(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return false
  return dateOnly(value.slice(0, 10)) && Number(value.slice(11, 13)) < 24 && Number.isFinite(Date.parse(value))
}

function totals(value: unknown): value is UsageTotals {
  if (!object(value)) return false
  const { calls, inputTokens, outputTokens, totalTokens } = value
  return [calls, inputTokens, outputTokens, totalTokens].every(item => typeof item === 'number' && Number.isSafeInteger(item) && item >= 0)
    && typeof inputTokens === 'number' && typeof outputTokens === 'number' && typeof totalTokens === 'number'
    && Number.isSafeInteger(inputTokens + outputTokens) && totalTokens === inputTokens + outputTokens
}

function matchesSummary(rows: UsageTotals[], summary: UsageTotals): boolean {
  const sum = rows.reduce((result, row) => ({
    calls: result.calls + row.calls,
    inputTokens: result.inputTokens + row.inputTokens,
    outputTokens: result.outputTokens + row.outputTokens,
    totalTokens: result.totalTokens + row.totalTokens,
  }), { calls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 })
  return totals(sum) && sum.calls === summary.calls && sum.inputTokens === summary.inputTokens
    && sum.outputTokens === summary.outputTokens && sum.totalTokens === summary.totalTokens
}

/** Treat malformed or inconsistent telemetry as unavailable, never as zero. */
export function validPersonalUsage(value: unknown, days: PersonalUsageDays, ownerId: string): value is PersonalUsage & { ownerId: string } {
  if (!object(value) || value.ownerId !== ownerId || value.days !== days || value.timezone !== 'UTC' || !instant(value.from) || !instant(value.to)
    || !totals(value.summary) || !Array.isArray(value.daily) || value.daily.length !== days || !Array.isArray(value.models)) return false

  const from = Date.parse(value.from), to = Date.parse(value.to)
  const today = new Date(to)
  const todayStart = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())
  if (from !== todayStart - (days - 1) * DAY_MS || from >= to) return false

  const daily: UsageTotals[] = []
  for (let index = 0; index < value.daily.length; index++) {
    const item: unknown = value.daily[index]
    const expected = new Date(from + index * DAY_MS).toISOString().slice(0, 10)
    if (!object(item) || !dateOnly(item.date) || item.date !== expected || !totals(item)) return false
    daily.push(item)
  }
  const models: UsageTotals[] = []
  const modelKeys = new Set<string>()
  for (const item of value.models as unknown[]) {
    if (!object(item) || typeof item.provider !== 'string' || !item.provider.trim()
      || typeof item.model !== 'string' || !item.model.trim()) return false
    const provider = item.provider, model = item.model
    if (!totals(item)) return false
    const key = JSON.stringify([provider, model])
    if (modelKeys.has(key)) return false
    modelKeys.add(key)
    models.push(item)
  }
  return matchesSummary(daily, value.summary) && matchesSummary(models, value.summary)
}

export function validPersonalActivity(value: unknown, ownerId: string): value is PersonalActivityResponse {
  if (!object(value) || value.ownerId !== ownerId || !Array.isArray(value.items) || value.items.length > 12) return false
  const ids = new Set<string>()
  return value.items.every((item: unknown) => {
    if (!object(item) || typeof item.id !== 'string' || !item.id.trim() || ids.has(item.id)
      || typeof item.text !== 'string' || !instant(item.createdAt)) return false
    ids.add(item.id)
    return true
  })
}
