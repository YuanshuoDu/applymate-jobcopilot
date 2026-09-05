import { randomUUID } from 'node:crypto'
import type { PrismaClient } from '@prisma/client'
import {
  isRolloutEnvironment,
  isRolloutStageKey,
  ROLLOUT_DIFF_METRICS,
  type RolloutDiffMetricKey,
  type RolloutEnvironment,
  type RolloutStageKey,
} from './flags'

export interface RolloutMetricPair {
  legacyValue: number
  v2Value: number
  withinThreshold: boolean
}

export interface PersistRolloutDiffInput {
  comparisonId: string
  environment: RolloutEnvironment
  stageKey: RolloutStageKey
  sessionId: string
  traceId?: string | null
  metrics: Partial<Record<RolloutDiffMetricKey, RolloutMetricPair>>
  occurredAt?: Date
}

export interface RolloutDiffStore {
  rolloutDiff: Pick<PrismaClient['rolloutDiff'], 'createMany' | 'findMany'>
}

export interface RolloutDiffSummary {
  total: number
  withinThreshold: number
  byMetric: Partial<Record<RolloutDiffMetricKey, { total: number; withinThreshold: number; latestAt: string | null }>>
}

function opaque(value: string, label: string): string {
  if (!value || value.length > 256 || /\s|[\u0000-\u001f\u007f]/u.test(value)) throw new Error(`${label} must be a bounded opaque identifier`)
  return value
}

function metricNumber(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be finite and non-negative`)
  return value
}

function validateInput(input: PersistRolloutDiffInput): void {
  opaque(input.comparisonId, 'comparisonId')
  opaque(input.sessionId, 'sessionId')
  if (input.traceId) opaque(input.traceId, 'traceId')
  if (!isRolloutEnvironment(input.environment)) throw new Error('Unsupported rollout environment')
  if (!isRolloutStageKey(input.stageKey)) throw new Error('Unsupported rollout stage')
  if (Object.keys(input.metrics).length === 0) throw new Error('At least one rollout metric is required')
  for (const [metricKey, pair] of Object.entries(input.metrics)) {
    if (!(ROLLOUT_DIFF_METRICS as readonly string[]).includes(metricKey)) throw new Error(`Unsupported rollout metric: ${metricKey}`)
    if (!pair || typeof pair !== 'object' || typeof pair.withinThreshold !== 'boolean') throw new Error(`Invalid rollout metric: ${metricKey}`)
    metricNumber(pair.legacyValue, `${metricKey}.legacyValue`)
    metricNumber(pair.v2Value, `${metricKey}.v2Value`)
  }
  if (input.occurredAt && Number.isNaN(input.occurredAt.getTime())) throw new Error('occurredAt must be a valid date')
}

export async function persistRolloutDiff(input: PersistRolloutDiffInput, client?: RolloutDiffStore): Promise<{ count: number }> {
  validateInput(input)
  const store = client ?? await defaultStore()
  const rows = Object.entries(input.metrics).map(([metricKey, pair]) => ({
    id: randomUUID(),
    comparisonId: input.comparisonId,
    environment: input.environment,
    stageKey: input.stageKey,
    sessionId: input.sessionId,
    traceId: input.traceId ?? null,
    metricKey,
    legacyValue: pair.legacyValue,
    v2Value: pair.v2Value,
    delta: pair.v2Value - pair.legacyValue,
    withinThreshold: pair.withinThreshold,
    ...(input.occurredAt ? { occurredAt: input.occurredAt } : {}),
  }))
  const result = await store.rolloutDiff.createMany({ data: rows, skipDuplicates: true })
  return { count: result.count }
}

export async function summarizeRolloutDiffs(environment: RolloutEnvironment, client?: RolloutDiffStore): Promise<RolloutDiffSummary> {
  const store = client ?? await defaultStore()
  const rows = await store.rolloutDiff.findMany({
    where: { environment },
    orderBy: { createdAt: 'desc' },
    take: 500,
    select: { metricKey: true, withinThreshold: true, createdAt: true },
  })
  const byMetric: RolloutDiffSummary['byMetric'] = {}
  let withinThreshold = 0
  for (const row of rows) {
    if (!isRolloutDiffMetricKey(row.metricKey)) continue
    const bucket = byMetric[row.metricKey] ?? { total: 0, withinThreshold: 0, latestAt: null }
    bucket.total += 1
    if (row.withinThreshold) {
      bucket.withinThreshold += 1
      withinThreshold += 1
    }
    bucket.latestAt ??= row.createdAt.toISOString()
    byMetric[row.metricKey] = bucket
  }
  return { total: rows.length, withinThreshold, byMetric }
}

async function defaultStore(): Promise<RolloutDiffStore> {
  const dbModule = await import('@/lib/db')
  return dbModule.db
}

function isRolloutDiffMetricKey(value: string): value is RolloutDiffMetricKey {
  return (ROLLOUT_DIFF_METRICS as readonly string[]).includes(value)
}
