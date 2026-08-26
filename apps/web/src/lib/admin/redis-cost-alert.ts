import type { RedisUsageSnapshot } from './redis-usage'

export type RedisBudgetAlert = {
  ruleKey: string
  dedupeKey: string
  metric: string
  value: number
  threshold: number
  severity: 'high'
  title: string
  body: string
}

/** Convert a provider snapshot into one deduplicated monthly admin alert. */
export function redisBudgetAlert(snapshot: RedisUsageSnapshot | null, now = new Date()): RedisBudgetAlert | null {
  if (!snapshot?.alertTriggered || snapshot.period !== 'current_month' || snapshot.alertThresholdUsd === null) return null
  const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`
  const value = Number(snapshot.estimatedCostUsd.toFixed(6))
  const threshold = Number(snapshot.alertThresholdUsd.toFixed(6))
  return {
    ruleKey: 'upstash_redis_cost',
    dedupeKey: `upstash_redis_cost:${month}`,
    metric: 'upstash_cost_usd',
    value,
    threshold,
    severity: 'high',
    title: 'Upstash Redis budget alert',
    body: `Upstash Redis current-month cost is $${value.toFixed(2)}; application alert threshold is $${threshold.toFixed(2)}.`,
  }
}
