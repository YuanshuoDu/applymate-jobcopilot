import type { CanonicalTurnState } from "./canonical-turn-state.js"
import type { CanonicalExecutionProjection } from "./canonical-execution-projection.js"
import type { CanonicalSessionProjection } from "./canonical-session-projection.js"
import type { RootTaskStore } from "./subagents/root-task-store.js"
import type { TurnLease } from "./turns/lease.js"
import type { TurnExecutionResult } from "./turns/turn-queue.js"

/** Persist and surface selected-job intent when TaskGraph planning is unavailable. */
export async function failSelectedJobPreparationUnavailable(input: {
  readonly lease: TurnLease
  readonly state: CanonicalTurnState
  readonly rootTasks: RootTaskStore
  readonly executionProjection: CanonicalExecutionProjection
  readonly sessionProjection: CanonicalSessionProjection
  readonly now: () => Date
}): Promise<TurnExecutionResult> {
  const { lease, state, rootTasks, executionProjection, sessionProjection, now } = input
  const errorCode = "selected_job_preparation_unavailable"
  const identity = { userId: lease.userId, sessionId: lease.sessionId, turnId: lease.turnId }
  const root = await rootTasks.ensure({ lease, goal: state.goal, modelProfileSnapshot: state.modelProfileSnapshot, toolPolicySnapshot: state.toolPolicySnapshot, budgetSnapshot: state.budgetSnapshot, allowedActions: [], now: now() })
  const result = { status: "failed" as const, errorCode, stepCount: 0, toolCallCount: 0 }
  await rootTasks.finish({ lease, rootTaskId: root.id, result, now: now() })
  await executionProjection.finish({ ...identity, result })
  await sessionProjection.finish({ ...identity, result })
  return { status: "failed", summary: errorCode }
}
