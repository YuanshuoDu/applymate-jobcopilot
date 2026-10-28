import { Prisma } from '@prisma/client'

export type PersonalUsageDays = 7 | 30
export type UsageTotals = { calls: number; inputTokens: number; outputTokens: number; totalTokens: number }
export type PersonalUsage = {
  days: PersonalUsageDays
  timezone: 'UTC'
  from: string
  to: string
  summary: UsageTotals
  daily: Array<UsageTotals & { date: string }>
  models: Array<UsageTotals & { provider: string; model: string }>
}

type UsageRow = {
  date: string
  provider: string
  model: string
  calls: number | bigint
  inputTokens: number | bigint
  outputTokens: number | bigint
}

const DAY_MS = 86_400_000
function emptyTotals(): UsageTotals { return { calls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 } }

function count(value: number | bigint): number {
  const result = Number(value)
  if (!Number.isSafeInteger(result) || result < 0) throw new Error('Invalid usage total')
  return result
}

function add(target: UsageTotals, value: UsageTotals): void {
  target.calls = count(target.calls + value.calls)
  target.inputTokens = count(target.inputTokens + value.inputTokens)
  target.outputTokens = count(target.outputTokens + value.outputTokens)
  target.totalTokens = count(target.inputTokens + target.outputTokens)
}

/** Recorded calls, including failures; excludes reservations and pre-provider cancellations. */
export async function readPersonalUsage(
  client: Pick<Prisma.TransactionClient, '$queryRaw'>,
  userId: string,
  days: PersonalUsageDays,
  now = new Date(),
): Promise<PersonalUsage> {
  const to = new Date(now)
  const from = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate()) - (days - 1) * DAY_MS)
  // Prisma's created_at TIMESTAMP(3) stores UTC. Aggregate in the database to
  // avoid loading individual calls or exposing prompts and private metadata.
  const rows = await client.$queryRaw<UsageRow[]>(Prisma.sql`
    SELECT TO_CHAR(created_at, 'YYYY-MM-DD') AS date, provider, model,
      COUNT(*) AS calls,
      COALESCE(SUM(input_tokens), 0) AS "inputTokens",
      COALESCE(SUM(output_tokens), 0) AS "outputTokens"
    FROM ai_usage_events
    WHERE user_id = ${userId}
      AND created_at >= ${from} AND created_at < ${to}
      AND status IN ('success', 'error')
    GROUP BY TO_CHAR(created_at, 'YYYY-MM-DD'), provider, model
    ORDER BY date ASC, provider ASC, model ASC
  `)

  const daily = Array.from({ length: days }, (_, index) => ({
    date: new Date(from.getTime() + index * DAY_MS).toISOString().slice(0, 10),
    ...emptyTotals(),
  }))
  const byDate = new Map(daily.map(day => [day.date, day]))
  const models = new Map<string, PersonalUsage['models'][number]>()
  const summary = emptyTotals()
  for (const row of rows) {
    const day = byDate.get(row.date)
    if (!day) throw new Error('Usage date outside requested window')
    const inputTokens = count(row.inputTokens)
    const outputTokens = count(row.outputTokens)
    const totals = { calls: count(row.calls), inputTokens, outputTokens, totalTokens: count(inputTokens + outputTokens) }
    const key = JSON.stringify([row.provider, row.model])
    const model = models.get(key) ?? { provider: row.provider, model: row.model, ...emptyTotals() }
    add(day, totals)
    add(model, totals)
    add(summary, totals)
    models.set(key, model)
  }
  return {
    days, timezone: 'UTC', from: from.toISOString(), to: to.toISOString(), summary, daily,
    models: [...models.values()].sort((a, b) => b.calls - a.calls || b.totalTokens - a.totalTokens
      || a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model)),
  }
}
