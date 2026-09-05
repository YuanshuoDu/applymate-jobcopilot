export {
  DoubleExecutionBlockedError,
  runV1AndV2InParallel,
  type ExternalExecutionBoundary,
  type ShadowBranchMetrics,
  type ShadowBranchOutcome,
  type ShadowComparison,
  type ShadowComparisonRecorder,
  type ShadowExecutionContext,
  type ShadowExecutor,
  type ShadowRunResult,
  type ShadowSession,
} from './shadow.js'

export {
  CANARY_OBSERVATION_MS,
  INTERNAL_OBSERVATION_MS,
  ROLLOUT_STAGES,
  evaluateRolloutStage,
  type RolloutMetrics,
  type RolloutStage,
  type RolloutStageDecision,
} from './stage-controller.js'
