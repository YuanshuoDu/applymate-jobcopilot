import {
  DEFAULT_ROLLOUT_ENVIRONMENT,
  DEFAULT_ROLLOUT_STAGE,
  evaluateRollbackThresholds,
  isRolloutEnvironment,
  isRolloutStageKey,
  isObservationComplete,
  nextStage,
  normalizePersistedStage,
  observationWindow,
  previousStage,
  stageDefinition,
  type PersistedRolloutStage,
  type RolloutEnvironment,
  type RolloutMetrics,
  type RolloutStageKey,
} from './flags'

export const rolloutStageSelect = {
  environment: true,
  stageKey: true,
  rolloutPercent: true,
  enabled: true,
  internalUserIds: true,
  observationStartedAt: true,
  observationEndsAt: true,
  version: true,
  status: true,
  rollbackReason: true,
  lastTransitionAt: true,
} as const

export interface RolloutStageStore {
  rolloutStage: {
    findUnique(args: unknown): Promise<PersistedRolloutStage | null>
    create(args: unknown): Promise<unknown>
    updateMany(args: unknown): Promise<{ count: number }>
  }
}

type NormalizedRolloutStage = ReturnType<typeof normalizePersistedStage>

export type AdvanceDecision =
  | { ok: true; targetStage: RolloutStageKey; observation: { start: Date; end: Date } }
  | { ok: false; code: 'ALREADY_AT_MAXIMUM' | 'OBSERVATION_WINDOW_OPEN' | 'ROLLBACK_REQUIRED' | 'INVALID_TARGET'; reasons?: readonly string[] }

export function defaultRolloutStage(environment: RolloutEnvironment = DEFAULT_ROLLOUT_ENVIRONMENT, now = new Date()): PersistedRolloutStage {
  return {
    environment,
    stageKey: DEFAULT_ROLLOUT_STAGE,
    rolloutPercent: 0,
    enabled: true,
    internalUserIds: [],
    observationStartedAt: null,
    observationEndsAt: null,
    version: 1,
    status: 'active',
    rollbackReason: null,
    lastTransitionAt: now,
  }
}

export async function getRolloutStage(environmentInput = DEFAULT_ROLLOUT_ENVIRONMENT, client?: RolloutStageStore): Promise<{ stage: NormalizedRolloutStage; persisted: boolean }> {
  if (!isRolloutEnvironment(environmentInput)) throw new Error('Unsupported rollout environment')
  const store = client ?? await defaultStore()
  const row = await store.rolloutStage.findUnique({ where: { environment: environmentInput }, select: rolloutStageSelect })
  if (!row) return { stage: normalizePersistedStage(defaultRolloutStage(environmentInput)), persisted: false }
  return { stage: normalizePersistedStage(row), persisted: true }
}

async function defaultStore(): Promise<RolloutStageStore> {
  const dbModule = await import('@/lib/db')
  return dbModule.db
}

export function decideAdvance(current: PersistedRolloutStage, requestedStage: unknown, metrics: Partial<RolloutMetrics> | undefined, now = new Date()): AdvanceDecision {
  const normalized = normalizePersistedStage(current)
  const targetStage = requestedStage === undefined ? nextStage(normalized.stageKey) : requestedStage
  if (!targetStage || !isRolloutStageKey(targetStage)) return { ok: false, code: targetStage ? 'INVALID_TARGET' : 'ALREADY_AT_MAXIMUM' }
  if (targetStage !== nextStage(normalized.stageKey)) return { ok: false, code: 'INVALID_TARGET' }
  if (!isObservationComplete(normalized.stageKey, normalized.observationStartedAt, now)) return { ok: false, code: 'OBSERVATION_WINDOW_OPEN' }
  const evaluation = evaluateRollbackThresholds(metrics ?? {})
  if (evaluation.shouldRollback) return { ok: false, code: 'ROLLBACK_REQUIRED', reasons: evaluation.reasons }
  return { ok: true, targetStage, observation: observationWindow(targetStage, now) }
}

export function rollbackTarget(current: PersistedRolloutStage): RolloutStageKey | null {
  return previousStage(normalizePersistedStage(current).stageKey)
}

export function stageTransitionData(targetStage: RolloutStageKey, actorUserId: string, now: Date, reason: string | null = null) {
  const observation = observationWindow(targetStage, now)
  const definition = stageDefinition(targetStage)
  return {
    stageKey: targetStage,
    rolloutPercent: definition.rolloutPercent,
    enabled: true,
    observationStartedAt: observation.start,
    observationEndsAt: observation.end,
    status: 'active' as const,
    rollbackReason: reason,
    lastTransitionAt: now,
    updatedById: actorUserId,
    version: { increment: 1 },
  }
}

export function parseEnvironment(value: string | null | undefined): RolloutEnvironment {
  const environment = value ?? DEFAULT_ROLLOUT_ENVIRONMENT
  if (!isRolloutEnvironment(environment)) throw new Error('Unsupported rollout environment')
  return environment
}
