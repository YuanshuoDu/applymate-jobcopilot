import { describe, expect, it } from 'vitest'
import { redisBudgetAlert } from './redis-cost-alert'

const snapshot = { available: true, totalCommands: 362926, inputBytes: 0, outputBytes: 4096, estimatedCostUsd: 5.01, sampledAt: '2026-08-26T12:00:00.000Z', period: 'current_month' as const, source: 'upstash_management_stats' as const, alertThresholdUsd: 5, maxBudgetUsd: 20, alertTriggered: true }
const lifetimeSnapshot = { ...snapshot, period: 'instance_lifetime' as const, source: 'upstash_rest_info' as const }

describe('redis budget alert', () => {
  it('creates one stable monthly identity when the threshold is breached', () => {
    expect(redisBudgetAlert(snapshot, new Date('2026-08-26T12:00:00Z'))).toMatchObject({ ruleKey: 'upstash_redis_cost', dedupeKey: 'upstash_redis_cost:2026-08', metric: 'upstash_cost_usd', severity: 'high' })
  })
  it('does not alert below threshold or without a configured threshold', () => {
    expect(redisBudgetAlert({ ...snapshot, alertTriggered: false })).toBeNull()
    expect(redisBudgetAlert({ ...snapshot, alertThresholdUsd: null })).toBeNull()
  })
  it('does not alert from an instance-lifetime estimate', () => {
    expect(redisBudgetAlert(lifetimeSnapshot, new Date('2026-08-26T12:00:00Z'))).toBeNull()
  })
})
