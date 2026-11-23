import type pg from "pg"
import type { TurnExecutionResult } from "./turns/turn-queue.js"
import type { TurnEngineOptions, TurnEngineResult, TurnEngineStore } from "./turns/turn-engine-types.js"
import type { TurnLease } from "./turns/lease.js"
import { loadCanonicalTurnState, type CanonicalTurnState, type CanonicalTurnStateLoadOptions } from "./canonical-turn-state.js"
import type { ProductionAgentFlags } from "./production-agent-flags.js"
import type { TaskGraphCommandPort } from "./subagents/task-graph-command-port.js"
import type { RootTaskStore } from "./subagents/root-task-store.js"
import type { CanonicalExecutionProjection } from "./canonical-execution-projection.js"
import type { CanonicalSessionProjection } from "./canonical-session-projection.js"
import { createPgDurableWaitPort } from "./subagents/durable-wait-store.js"
import { createPgInputClaimStore } from "./context/input-claim-store.js"
import { createCanonicalTurnContextBuilder } from "./canonical-turn-context-builder.js"
import { createPgTurnEngineStore } from "./turns/turn-engine-store.js"
import { issueOrReplayReviewedApplicationReview } from "./reviewed-application-review-issuance.js"
import { runCanonicalReviewedApplicationReviewTurn } from "./canonical-reviewed-application-review-turn.js"
import { finishApprovedApplicationFillTurn, readCurrentApprovedApplicationSubmitResumeProof } from "./canonical-approved-application-submit-resume.js"
import { sameCanonicalApprovedApplicationSubmitResumeProof } from "./canonical-approved-application-submit-resume-proof.js"
import { approvedFillTerminalClaimRequeue, claimApprovedFillTerminalLease, getApprovedFillTerminalClaim, type ApprovedFillTerminalClaimFallback } from "./turns/approved-fill-terminal-claim.js"

export type ReviewedApplicationReviewIssuer = typeof issueOrReplayReviewedApplicationReview
type ReviewOptions = Readonly<{
  productionFlags?: ProductionAgentFlags
  taskGraphCommandPort?: TaskGraphCommandPort
  contextBuilderFactory?: (input: { pool: pg.Pool; scope: { userId: string } }) => TurnEngineOptions["contextBuilder"]
  reviewedApplicationReviewIssuer?: ReviewedApplicationReviewIssuer
  turnEngineStoreFactory?: (pool: pg.Pool, terminalGuard?: Parameters<typeof createPgTurnEngineStore>[1]) => TurnEngineStore
}>
type StateLoader = (pool: Pick<pg.Pool, "connect">, lease: TurnLease, now?: Date, options?: CanonicalTurnStateLoadOptions) => Promise<CanonicalTurnState>
type ResumeGateInput = Readonly<{
  hasStateLoader: boolean; productionFlags?: ProductionAgentFlags; taskGraphCommandPort?: TaskGraphCommandPort
  coordinationEnabled: boolean; childExecutionEnabled: boolean; consumeWaitOutcomes: boolean; hasRootCompletionCheck: boolean
}>

export function approvedApplicationFillResumeEnabled(input: ResumeGateInput): boolean {
  return !input.hasStateLoader && input.productionFlags?.taskGraphPlanningEnabled === true
    && input.coordinationEnabled && input.childExecutionEnabled && input.consumeWaitOutcomes
    && !!input.taskGraphCommandPort && input.hasRootCompletionCheck
}

export function approvedFillTerminalClaimOption(input: {
  readonly options: ReviewOptions & { stateLoader?: StateLoader }; readonly rootTasks: RootTaskStore
  readonly coordinationEnabled: boolean; readonly childExecutionEnabled: boolean; readonly consumeWaitOutcomes: boolean
}): { readonly approvedFillTerminalClaim: ApprovedFillTerminalClaimFallback } | {} {
  const { options, rootTasks } = input
  return approvedApplicationFillResumeEnabled({ hasStateLoader: !!options.stateLoader, productionFlags: options.productionFlags,
    taskGraphCommandPort: options.taskGraphCommandPort, coordinationEnabled: input.coordinationEnabled,
    childExecutionEnabled: input.childExecutionEnabled, consumeWaitOutcomes: input.consumeWaitOutcomes,
    hasRootCompletionCheck: !!rootTasks.checkCompletion }) ? { approvedFillTerminalClaim: claimApprovedFillTerminalLease } : {}
}

export async function loadAndDispatchCanonicalReviewedApplicationReview<Options extends ReviewOptions & { stateLoader?: StateLoader }>(input: {
  pool: pg.Pool; lease: TurnLease; signal: AbortSignal; options: Options; rootTasks: RootTaskStore
  executionProjection: CanonicalExecutionProjection; sessionProjection: CanonicalSessionProjection; now: () => Date
  coordinationEnabled: boolean; childExecutionEnabled: boolean; consumeWaitOutcomes: boolean
}): Promise<{ readonly result: TurnExecutionResult | undefined; readonly setupOptions: Options & { stateLoader: () => Promise<CanonicalTurnState> }; readonly durableWaitPort: ReturnType<typeof createPgDurableWaitPort> }> {
  const durableWaitPort = createPgDurableWaitPort(input.pool)
  const loadState = (consumeWaitOutcomes: boolean) => input.options.stateLoader?.(input.pool, input.lease, input.now(), {
    consumeWaitOutcomes, durableWaitControlReader: durableWaitPort,
  }) ?? loadCanonicalTurnState(input.pool, input.lease, input.now(), { consumeWaitOutcomes, durableWaitControlReader: durableWaitPort })
  const terminalClaim = getApprovedFillTerminalClaim(input.lease)
  const resumeEnabled = approvedApplicationFillResumeEnabled({ hasStateLoader: !!input.options.stateLoader,
    productionFlags: input.options.productionFlags, taskGraphCommandPort: input.options.taskGraphCommandPort,
    coordinationEnabled: input.coordinationEnabled, childExecutionEnabled: input.childExecutionEnabled,
    consumeWaitOutcomes: input.consumeWaitOutcomes, hasRootCompletionCheck: !!input.rootTasks.checkCompletion })
  if (terminalClaim && !resumeEnabled) throw approvedFillTerminalClaimRequeue(input.lease)
  if (resumeEnabled) {
    const preflight = await readCurrentApprovedApplicationSubmitResumeProof({ pool: input.pool, lease: input.lease, now: input.now() })
    if (terminalClaim && (!preflight || preflight.rootTaskId !== terminalClaim.rootTaskId
      || !sameCanonicalApprovedApplicationSubmitResumeProof(terminalClaim, preflight.proof))) {
      throw approvedFillTerminalClaimRequeue(input.lease)
    }
    if (preflight) {
      // The proof must exist before the ordinary owner-fenced child-Wait consumption can write.
      const state = await loadState(true)
      if (state.rootTaskId !== preflight.rootTaskId) {
        if (terminalClaim) throw approvedFillTerminalClaimRequeue(input.lease)
        throw new Error("approved_application_fill_resume_root_changed")
      }
      const current = await readCurrentApprovedApplicationSubmitResumeProof({ pool: input.pool, lease: input.lease, now: input.now() })
      if (!current || current.rootTaskId !== preflight.rootTaskId
        || !sameCanonicalApprovedApplicationSubmitResumeProof(preflight.proof, current.proof)
        || (terminalClaim && !sameCanonicalApprovedApplicationSubmitResumeProof(terminalClaim, current.proof))) {
        if (terminalClaim) throw approvedFillTerminalClaimRequeue(input.lease)
        throw new Error("approved_application_fill_resume_proof_changed")
      }
      const root = await input.rootTasks.ensure({ lease: input.lease, goal: state.goal, modelProfileSnapshot: state.modelProfileSnapshot,
        toolPolicySnapshot: state.toolPolicySnapshot, budgetSnapshot: state.budgetSnapshot, allowedActions: [], now: input.now() })
      if (root.id !== preflight.rootTaskId || root.attemptCount !== 1) {
        if (terminalClaim) throw approvedFillTerminalClaimRequeue(input.lease)
        throw new Error("approved_application_fill_resume_root_changed")
      }
      const rebound = await readCurrentApprovedApplicationSubmitResumeProof({ pool: input.pool, lease: input.lease, now: input.now() })
      if (!rebound || rebound.rootTaskId !== preflight.rootTaskId
        || !sameCanonicalApprovedApplicationSubmitResumeProof(preflight.proof, rebound.proof)
        || (terminalClaim && !sameCanonicalApprovedApplicationSubmitResumeProof(terminalClaim, rebound.proof))) {
        if (terminalClaim) throw approvedFillTerminalClaimRequeue(input.lease)
        throw new Error("approved_application_fill_resume_proof_changed")
      }
      const result = await finishApprovedApplicationFillTurn({ pool: input.pool, lease: input.lease, state,
        rootTaskId: preflight.rootTaskId, proof: preflight.proof, signal: input.signal, rootTasks: input.rootTasks,
        executionProjection: input.executionProjection, sessionProjection: input.sessionProjection, now: input.now,
        ...(input.options.turnEngineStoreFactory ? { storeFactory: input.options.turnEngineStoreFactory } : {}) })
      return { result, durableWaitPort, setupOptions: { ...input.options, stateLoader: async () => state } }
    }
  }
  if (terminalClaim) throw approvedFillTerminalClaimRequeue(input.lease)
  const state = await loadState(input.consumeWaitOutcomes)
  const result = await dispatchCanonicalReviewedApplicationReview({ ...input, state })
  return { result, durableWaitPort, setupOptions: { ...input.options, stateLoader: async () => state } }
}

export async function dispatchCanonicalReviewedApplicationReview(input: {
  pool: pg.Pool; lease: TurnLease; signal: AbortSignal; state: CanonicalTurnState; options: ReviewOptions
  rootTasks: RootTaskStore; executionProjection: CanonicalExecutionProjection; sessionProjection: CanonicalSessionProjection
  now: () => Date; coordinationEnabled: boolean; childExecutionEnabled: boolean; consumeWaitOutcomes: boolean
}): Promise<TurnExecutionResult | undefined> {
  const { state } = input
  if (state.intent?.kind !== "reviewed_application_review") return undefined
  const { pool, lease, signal, options, rootTasks, executionProjection, sessionProjection, now } = input
  const projectionScope = { userId: lease.userId, sessionId: lease.sessionId, turnId: lease.turnId }
  const root = await rootTasks.ensure({ lease, goal: state.goal, modelProfileSnapshot: state.modelProfileSnapshot,
    toolPolicySnapshot: state.toolPolicySnapshot, budgetSnapshot: state.budgetSnapshot, allowedActions: [], now: now() })
  await executionProjection.start(projectionScope)
  await sessionProjection.start(projectionScope)
  const graphReady = state.intent.version === 1 && state.source === "user" && state.automationRunMode === undefined
    && options.productionFlags?.taskGraphPlanningEnabled === true && input.coordinationEnabled && input.childExecutionEnabled
    && input.consumeWaitOutcomes && !!options.taskGraphCommandPort && !!rootTasks.checkCompletion
  let result: TurnEngineResult
  if (!graphReady || !state.rootInputId) {
    result = { status: "failed", stepCount: 0, toolCallCount: 0,
      errorCode: graphReady ? "reviewed_application_root_input_missing" : "reviewed_application_review_runtime_unavailable" }
  } else {
    const contextBuilder = options.contextBuilderFactory?.({ pool, scope: state.scope }) ?? createCanonicalTurnContextBuilder({
      pool, store: createPgInputClaimStore(pool, state.scope), scope: state.scope, lease,
      rootTaskId: root.id, rootAttemptCount: root.attemptCount, rootInputId: state.rootInputId,
      turnInput: state.turnInput, planningEnabled: false, selectedJobMode: false,
    })
    result = await runCanonicalReviewedApplicationReviewTurn({ pool, lease, rootTaskId: root.id, scope: state.scope,
      intent: state.intent, goal: state.goal, snapshot: state.snapshot, contextBuilder,
      modelProfileSnapshot: state.modelProfileSnapshot, rootInputId: state.rootInputId, rootContextInputId: state.rootInputId,
      signal, issue: options.reviewedApplicationReviewIssuer ?? issueOrReplayReviewedApplicationReview, now,
      storeFactory: (reviewPool, guard) => options.turnEngineStoreFactory?.(reviewPool, guard) ?? createPgTurnEngineStore(reviewPool, guard),
    })
  }
  await rootTasks.finish({ lease, rootTaskId: root.id, result, now: now() })
  await executionProjection.finish({ ...projectionScope, result: { status: result.status, errorCode: result.errorCode } })
  await sessionProjection.finish({ ...projectionScope, result: { status: result.status, errorCode: result.errorCode } })
  return { status: result.status, summary: result.errorCode, ...(result.waitId ? { waitId: result.waitId } : {}) }
}
