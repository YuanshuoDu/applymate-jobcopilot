export const ROLLOUT_STAGES = [
  "internal-only",
  "1%",
  "5%",
  "25%",
  "50%",
  "100%",
] as const

export type RolloutStage = (typeof ROLLOUT_STAGES)[number]

export const INTERNAL_OBSERVATION_MS = 24 * 60 * 60 * 1_000
export const CANARY_OBSERVATION_MS = 4 * 60 * 60 * 1_000

export type RolloutMetrics = Readonly<{
  turnCompletionRate: number
  unauthorizedExternalAction: number
  submissionDuplicate: number
  replayConsistency: number
  costP95Ratio: number
}>

export type RolloutStageDecision = Readonly<{
  stage: RolloutStage
  nextStage: RolloutStage
  status: "hold" | "advance" | "rollback"
  observationReady: boolean
  failures: readonly string[]
  observationWindowMs: number
}>

export function evaluateRolloutStage(
  stage: RolloutStage,
  metrics: RolloutMetrics,
  observedFrom: Date,
  now: Date,
): RolloutStageDecision {
  validateMetrics(metrics)
  const elapsedMs = now.getTime() - observedFrom.getTime()
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) throw new Error("rollout observation timestamps are invalid")

  const observationWindowMs = stage === "internal-only" ? INTERNAL_OBSERVATION_MS : CANARY_OBSERVATION_MS
  const observationReady = elapsedMs >= observationWindowMs
  const failures = failedThresholds(metrics)
  if (failures.length > 0) {
    const previous = previousStage(stage)
    return {
      stage,
      nextStage: previous ?? "internal-only",
      status: previous ? "rollback" : "hold",
      observationReady,
      failures,
      observationWindowMs,
    }
  }
  if (!observationReady) {
    return { stage, nextStage: stage, status: "hold", observationReady, failures, observationWindowMs }
  }
  const nextStage = nextRolloutStage(stage)
  return { stage, nextStage, status: nextStage === stage ? "hold" : "advance", observationReady, failures, observationWindowMs }
}

function nextRolloutStage(stage: RolloutStage): RolloutStage {
  const index = ROLLOUT_STAGES.indexOf(stage)
  return ROLLOUT_STAGES[Math.min(index + 1, ROLLOUT_STAGES.length - 1)]
}

function previousStage(stage: RolloutStage): RolloutStage | null {
  const index = ROLLOUT_STAGES.indexOf(stage)
  return index > 0 ? ROLLOUT_STAGES[index - 1] : null
}

function failedThresholds(metrics: RolloutMetrics): string[] {
  const failures: string[] = []
  if (metrics.turnCompletionRate < 0.99) failures.push("turn_completion_rate")
  if (metrics.unauthorizedExternalAction !== 0) failures.push("unauthorized_external_action")
  if (metrics.submissionDuplicate !== 0) failures.push("submission_duplicate")
  if (metrics.replayConsistency < 0.999) failures.push("replay_consistency")
  if (metrics.costP95Ratio > 1.2) failures.push("cost_p95")
  return failures
}

function validateMetrics(metrics: RolloutMetrics): void {
  for (const [key, value] of Object.entries(metrics)) {
    if (!Number.isFinite(value) || value < 0) throw new Error(`${key} must be finite and non-negative`)
  }
}
