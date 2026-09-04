import { createHash } from 'node:crypto'

export const ROLLOUT_ENVIRONMENTS = ['development', 'staging', 'production'] as const
export type RolloutEnvironment = (typeof ROLLOUT_ENVIRONMENTS)[number]

const HOUR_MS = 60 * 60 * 1000

export const ROLLOUT_STAGES = [
  { key: 'internal-only', rolloutPercent: 0, observationMs: 24 * HOUR_MS, internalOnly: true },
  { key: '1%', rolloutPercent: 1, observationMs: 4 * HOUR_MS, internalOnly: false },
  { key: '5%', rolloutPercent: 5, observationMs: 4 * HOUR_MS, internalOnly: false },
  { key: '25%', rolloutPercent: 25, observationMs: 4 * HOUR_MS, internalOnly: false },
  { key: '50%', rolloutPercent: 50, observationMs: 4 * HOUR_MS, internalOnly: false },
  { key: '100%', rolloutPercent: 100, observationMs: 4 * HOUR_MS, internalOnly: false },
] as const

export type RolloutStageKey = (typeof ROLLOUT_STAGES)[number]['key']
export type RolloutStageDefinition = (typeof ROLLOUT_STAGES)[number]

export const DEFAULT_ROLLOUT_STAGE: RolloutStageKey = 'internal-only'
export const DEFAULT_ROLLOUT_ENVIRONMENT: RolloutEnvironment = 'staging'

export const ROLLOUT_DIFF_METRICS = [
  'turn_completion_rate',
  'unauthorized_external_action',
  'submission_duplicate',
  'replay_consistency',
  'cost_p95_ratio',
] as const

export type RolloutDiffMetricKey = (typeof ROLLOUT_DIFF_METRICS)[number]

export const ROLLBACK_THRESHOLDS = {
  turnCompletionRate: { minimum: 0.99, unit: 'ratio' },
  unauthorizedExternalAction: { maximum: 0, unit: 'count' },
  submissionDuplicate: { maximum: 0, unit: 'count' },
  replayConsistency: { minimum: 0.999, unit: 'ratio' },
  costP95Ratio: { maximum: 1.2, unit: 'legacy_ratio' },
} as const

export interface PersistedRolloutStage {
  environment: string
  stageKey: string
  rolloutPercent: number
  enabled: boolean
  internalUserIds: readonly string[]
  observationStartedAt: Date | string | null
  observationEndsAt: Date | string | null
  version: number
  status: string
  rollbackReason: string | null
  lastTransitionAt: Date | string
}

export interface RolloutSessionAllocation {
  sessionId: string
  userId?: string | null
  stageKey: RolloutStageKey
  rolloutPercent: number
  bucket: number
  useV2: boolean
  reason: 'disabled' | 'internal_user' | 'percentage_bucket' | 'outside_percentage'
}

export interface RolloutMetrics {
  turnCompletionRate: number
  unauthorizedExternalAction: number
  submissionDuplicate: number
  replayConsistency: number
  costP95Ratio: number
}

export interface RollbackEvaluation {
  shouldRollback: boolean
  reasons: readonly string[]
  metrics: RolloutMetrics | null
}

export function stageDefinition(stageKey: RolloutStageKey): RolloutStageDefinition {
  const stage = ROLLOUT_STAGES.find((candidate) => candidate.key === stageKey)
  if (!stage) throw new Error(`Unknown rollout stage: ${stageKey}`)
  return stage
}

export function isRolloutEnvironment(value: unknown): value is RolloutEnvironment {
  return typeof value === 'string' && (ROLLOUT_ENVIRONMENTS as readonly string[]).includes(value)
}

export function isRolloutStageKey(value: unknown): value is RolloutStageKey {
  return typeof value === 'string' && (ROLLOUT_STAGES as readonly { key: string }[]).some((stage) => stage.key === value)
}

export function nextStage(stageKey: RolloutStageKey): RolloutStageKey | null {
  const index = ROLLOUT_STAGES.findIndex((stage) => stage.key === stageKey)
  return ROLLOUT_STAGES[index + 1]?.key ?? null
}

export function previousStage(stageKey: RolloutStageKey): RolloutStageKey | null {
  const index = ROLLOUT_STAGES.findIndex((stage) => stage.key === stageKey)
  return index > 0 ? ROLLOUT_STAGES[index - 1]?.key ?? null : null
}

export function observationWindow(stageKey: RolloutStageKey, startedAt: Date | string): { start: Date; end: Date } {
  const start = startedAt instanceof Date ? new Date(startedAt) : new Date(startedAt)
  if (Number.isNaN(start.getTime())) throw new Error('observation start must be a valid date')
  const end = new Date(start.getTime() + stageDefinition(stageKey).observationMs)
  return { start, end }
}

export function isObservationComplete(stageKey: RolloutStageKey, startedAt: Date | string | null, now = new Date()): boolean {
  if (!startedAt) return false
  return now.getTime() >= observationWindow(stageKey, startedAt).end.getTime()
}

function opaque(value: string, label: string): string {
  if (!value || value.length > 256 || /\s|[\u0000-\u001f\u007f]/u.test(value)) throw new Error(`${label} must be a bounded opaque identifier`)
  return value
}

function sessionBucket(sessionId: string): number {
  const digest = createHash('sha256').update(sessionId).digest()
  return digest.readUInt32BE(0) % 10_000
}

export function allocateSession(sessionIdInput: string, stage: Pick<PersistedRolloutStage, 'stageKey' | 'rolloutPercent' | 'enabled' | 'internalUserIds'>, userIdInput?: string | null): RolloutSessionAllocation {
  const sessionId = opaque(sessionIdInput, 'sessionId')
  if (!isRolloutStageKey(stage.stageKey)) throw new Error('stageKey is not a supported rollout stage')
  const definition = stageDefinition(stage.stageKey)
  const userId = userIdInput ? opaque(userIdInput, 'userId') : null
  const bucket = sessionBucket(sessionId)
  const internalUser = Boolean(userId && stage.internalUserIds.includes(userId))
  if (!stage.enabled) return { sessionId, userId, stageKey: definition.key, rolloutPercent: definition.rolloutPercent, bucket, useV2: false, reason: 'disabled' }
  if (definition.internalOnly) return { sessionId, userId, stageKey: definition.key, rolloutPercent: 0, bucket, useV2: internalUser, reason: internalUser ? 'internal_user' : 'outside_percentage' }
  const rolloutPercent = definition.rolloutPercent
  const useV2 = internalUser || bucket < rolloutPercent * 100
  return { sessionId, userId, stageKey: definition.key, rolloutPercent, bucket, useV2, reason: internalUser ? 'internal_user' : useV2 ? 'percentage_bucket' : 'outside_percentage' }
}

function finiteNonNegative(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be finite and non-negative`)
  return value
}

function boundedRatio(value: number, label: string): number {
  finiteNonNegative(value, label)
  if (value > 1) throw new Error(`${label} must be between 0 and 1`)
  return value
}

export function evaluateRollbackThresholds(metrics: Partial<RolloutMetrics>): RollbackEvaluation {
  const missing: string[] = []
  const values: Partial<RolloutMetrics> = {}
  const assign = <K extends keyof RolloutMetrics>(key: K, value: number | undefined, validator: (input: number, label: string) => number) => {
    if (value === undefined) missing.push(key)
    else values[key] = validator(value, key)
  }
  assign('turnCompletionRate', metrics.turnCompletionRate, boundedRatio)
  assign('unauthorizedExternalAction', metrics.unauthorizedExternalAction, finiteNonNegative)
  assign('submissionDuplicate', metrics.submissionDuplicate, finiteNonNegative)
  assign('replayConsistency', metrics.replayConsistency, boundedRatio)
  assign('costP95Ratio', metrics.costP95Ratio, finiteNonNegative)
  if (missing.length > 0) return { shouldRollback: true, reasons: missing.map((key) => `missing_metric:${key}`), metrics: null }
  const complete = values as RolloutMetrics
  const reasons = [
    complete.turnCompletionRate < ROLLBACK_THRESHOLDS.turnCompletionRate.minimum ? 'turn_completion_below_99_percent' : null,
    complete.unauthorizedExternalAction > ROLLBACK_THRESHOLDS.unauthorizedExternalAction.maximum ? 'unauthorized_external_action_detected' : null,
    complete.submissionDuplicate > ROLLBACK_THRESHOLDS.submissionDuplicate.maximum ? 'duplicate_submission_detected' : null,
    complete.replayConsistency < ROLLBACK_THRESHOLDS.replayConsistency.minimum ? 'replay_consistency_below_99_9_percent' : null,
    complete.costP95Ratio > ROLLBACK_THRESHOLDS.costP95Ratio.maximum ? 'cost_p95_above_legacy_guardrail' : null,
  ].filter((reason): reason is string => reason !== null)
  return { shouldRollback: reasons.length > 0, reasons, metrics: complete }
}

export function normalizePersistedStage(row: PersistedRolloutStage): PersistedRolloutStage & { stageKey: RolloutStageKey; environment: RolloutEnvironment } {
  if (!isRolloutEnvironment(row.environment) || !isRolloutStageKey(row.stageKey)) throw new Error('Persisted rollout stage is invalid')
  const definition = stageDefinition(row.stageKey)
  if (row.rolloutPercent !== definition.rolloutPercent) throw new Error('Persisted rollout percentage does not match stage')
  if (!Number.isInteger(row.version) || row.version < 1) throw new Error('Persisted rollout version is invalid')
  if (!['active', 'rolled_back', 'blocked'].includes(row.status)) throw new Error('Persisted rollout status is invalid')
  return row as PersistedRolloutStage & { stageKey: RolloutStageKey; environment: RolloutEnvironment }
}
