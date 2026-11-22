import { createHash, randomUUID } from "node:crypto"
import type pg from "pg"
import type { RepositoryJsonValue } from "@jobcopilot/agent-protocol"
import type { PoolClient } from "pg"
import type { CanonicalTurnState } from "./canonical-turn-state.js"
import type { CanonicalExecutionProjection } from "./canonical-execution-projection.js"
import type { CanonicalSessionProjection } from "./canonical-session-projection.js"
import { executionOwnerFence } from "./execution-owner.js"
import type { TurnLease } from "./turns/lease.js"
import { createPgTurnEngineStore } from "./turns/turn-engine-store.js"
import type { TurnEngineTerminalGuard } from "./turns/turn-engine-terminal-commit.js"
import type { TurnEngineStore } from "./turns/turn-engine-types.js"
import type { TurnExecutionResult } from "./turns/turn-queue.js"
import type { RootTaskStore } from "./subagents/root-task-store.js"
import { TASK_GRAPH_FINAL_SUMMARY_BINDING } from "./subagents/task-graph-final-summary-binding.js"
import { buildGroundedTaskGraphFinalResponse } from "./subagents/task-graph-final-response.js"
import { formatTaskGraphFinalSummary } from "./subagents/task-graph-final-summary-format.js"
import { buildTaskGraphFinalSourceManifest } from "./subagents/task-graph-final-source-manifest.js"
import { taskGraphFinalSummaryCopiesMatch, finalizeTurn, serializeFinalResponse } from "./finalizer.js"
import { verifyCandidateFinal } from "./verifier.js"
import { toRepositoryJson } from "./turns/turn-engine-types.js"
import { readCanonicalApprovedApplicationSubmitResumeProof, sameCanonicalApprovedApplicationSubmitResumeProof,
  type CanonicalApprovedApplicationSubmitResumeProof } from "./canonical-approved-application-submit-resume-proof.js"

type CurrentProof = Readonly<{ rootTaskId: string; proof: CanonicalApprovedApplicationSubmitResumeProof }>
type StoreFactory = (pool: pg.Pool, guard?: TurnEngineTerminalGuard) => TurnEngineStore
type QueryRow = { readonly rootTaskId: string | null }

/** Reads the exact active root and its opaque resume witness without consuming any Waits. */
export async function readCurrentApprovedApplicationSubmitResumeProof(input: {
  readonly pool: Pick<pg.Pool, "connect">
  readonly lease: TurnLease
  readonly now: Date
}): Promise<CurrentProof | null> {
  const client = await input.pool.connect()
  let committed = false
  try {
    await client.query("BEGIN")
    await client.query("SELECT set_config($1, $2, true)", ["app.user_id", input.lease.userId])
    const turn = await client.query<QueryRow>(`SELECT turn."rootTaskId" FROM "agent_turns" AS turn
      JOIN "agent_sessions" AS session ON session."id" = turn."sessionId" AND session."userId" = turn."userId"
      WHERE turn."id" = $1 AND turn."sessionId" = $2 AND turn."userId" = $3
        AND turn."status" = 'in_progress' AND turn."leaseOwnerId" = $4 AND turn."leaseVersion" = $5
        AND turn."leaseExpiresAt" > $6 AND session."status" NOT IN ('aborted', 'archived') LIMIT 2`,
    [input.lease.turnId, input.lease.sessionId, input.lease.userId, input.lease.ownerId, input.lease.leaseVersion, input.now])
    const rootTaskId = turn.rows.length === 1 ? turn.rows[0]?.rootTaskId : null
    if (typeof rootTaskId !== "string" || !rootTaskId.trim()) {
      await client.query("COMMIT"); committed = true
      return null
    }
    const proof = await readCanonicalApprovedApplicationSubmitResumeProof(client, { lease: input.lease, rootTaskId, now: input.now })
    await client.query("COMMIT"); committed = true
    return proof ? { rootTaskId, proof } : null
  } catch (error: unknown) {
    if (!committed) await client.query("ROLLBACK").catch(() => undefined)
    throw error
  } finally { client.release() }
}

/** Completes only the already-filled, approved Turn; it never claims a submit job. */
export async function finishApprovedApplicationFillTurn(input: {
  readonly pool: pg.Pool
  readonly lease: TurnLease
  readonly state: CanonicalTurnState
  readonly rootTaskId: string
  readonly proof: CanonicalApprovedApplicationSubmitResumeProof
  readonly signal: AbortSignal
  readonly rootTasks: RootTaskStore
  readonly executionProjection: CanonicalExecutionProjection
  readonly sessionProjection: CanonicalSessionProjection
  readonly now: () => Date
  readonly storeFactory?: StoreFactory
}): Promise<TurnExecutionResult> {
  const { lease, rootTaskId, state, rootTasks } = input
  if (state.rootTaskId !== rootTaskId || state.source !== "user" || state.automationRunMode !== undefined
    || !rootTasks.checkCompletion) throw new Error("approved_application_fill_resume_scope_invalid")
  const owner = executionOwnerFence({ kind: "turn", taskId: rootTaskId, lease })
  if (owner.kind !== "turn" || owner.taskId !== owner.rootTaskId) throw new Error("approved_application_fill_resume_owner_invalid")
  const projectionScope = { userId: lease.userId, sessionId: lease.sessionId, turnId: lease.turnId }
  const resume = state.resume
  const ordinal = resume?.nextOrdinal
  const stepCount = (resume?.stepCount ?? 0) + 1
  const toolCallCount = resume?.toolCallCount
  if (!resume || typeof ordinal !== "number" || !Number.isSafeInteger(ordinal) || ordinal < 1
    || !Number.isSafeInteger(resume.stepCount) || resume.stepCount < 1
    || !Number.isSafeInteger(stepCount) || typeof toolCallCount !== "number" || !Number.isSafeInteger(toolCallCount) || toolCallCount < 0) {
    throw new Error("approved_application_fill_resume_count_invalid")
  }
  const stepId = `approved-fill-resume:${createHash("sha256").update(lease.turnId, "utf8").digest("hex")}:${lease.leaseVersion}:${ordinal}`
  const finalItemId = `turn:${lease.turnId}:item:final:${stepId}`
  const evidenceRef = "approved-application-fill-completed"
  const graph = await rootTasks.checkCompletion({ lease, rootTaskId, now: input.now(), taskGraphVerification: true,
    nativeVerificationPassed: false, requireTaskGraph: true })
  const binding = graph.ok ? graph[TASK_GRAPH_FINAL_SUMMARY_BINDING] : undefined
  if (!graph.ok || !binding) throw new Error("approved_application_fill_resume_graph_unverified")
  const message = buildGroundedTaskGraphFinalResponse(binding)
  const summary = formatTaskGraphFinalSummary(binding.summary)
  const verification = verifyCandidateFinal({ goal: state.goal,
    candidate: { text: message, finishReason: "stop", evidenceRefs: [evidenceRef] }, evidence: [{ id: evidenceRef, status: "verified" }] })
  if (!verification.ok) throw new Error("approved_application_fill_resume_verification_failed")
  const usage = resume.usage
  const final = finalizeTurn({ goal: state.goal, verification, terminalReason: "goal_satisfied", response: message,
    summaryOverride: summary, usage, stepCount, toolCallCount })
  const response = serializeFinalResponse(final)
  const manifest = buildTaskGraphFinalSourceManifest(binding, finalItemId)
  const finalContent = toRepositoryJson({ text: message, final: toRepositoryJson(final), ...(manifest ? { taskGraphSources: manifest } : {}) })
  const deny = { ok: false as const, blocker: "approved_application_fill_resume_unverified", feedback: "The completed application fill is no longer verified." }
  const terminalGuard: TurnEngineTerminalGuard = async (client, terminal, terminalAdmission) => {
    if (input.signal.aborted || terminal.owner.turnId !== lease.turnId || terminal.owner.sessionId !== lease.sessionId
      || terminal.owner.userId !== lease.userId || terminal.owner.taskId !== rootTaskId || terminal.stepId !== stepId
      || terminal.finalItemId !== finalItemId || terminal.response !== response || terminal.stepCount !== stepCount
      || terminal.toolCallCount !== toolCallCount) return deny
    const current = await readCanonicalApprovedApplicationSubmitResumeProof(client, { lease, rootTaskId, now: input.now() })
    if (!current || !sameCanonicalApprovedApplicationSubmitResumeProof(input.proof, current)) return deny
    const graph = await rootTasks.checkCompletion!({ lease, rootTaskId, now: input.now(), taskGraphVerification: true,
      nativeVerificationPassed: false, client: client as PoolClient, requireTaskGraph: true, terminalAdmission })
    if (!graph.ok) return graph
    return taskGraphFinalSummaryCopiesMatch(terminal[TASK_GRAPH_FINAL_SUMMARY_BINDING], graph[TASK_GRAPH_FINAL_SUMMARY_BINDING],
      terminal.finalContent, terminal.response, terminal.finalItemId) ? { ok: true } : deny
  }
  const store = (input.storeFactory ?? createPgTurnEngineStore)(input.pool, terminalGuard)
  await input.executionProjection.start(projectionScope)
  await input.sessionProjection.start(projectionScope)
  const turnStarted = await store.appendEvent({ owner, id: `${eventId(lease.turnId, "turn-started")}:${randomUUID()}`, itemId: null, type: "turn.started",
    correlationId: lease.turnId, causationId: null, idempotencyKey: `turn:${lease.turnId}:event:turn-started`,
    payload: { goal: state.goal, taskId: rootTaskId, rootTaskId } })
  if (input.signal.aborted) return interruptedResult(input, rootTaskId, stepCount, toolCallCount)
  const step = await store.startStep({ owner, stepId, ordinal, attempt: 1, inputThroughSequence: resume.inputThroughSequence,
    consumedInputIds: [], modelProfileSnapshot: state.modelProfileSnapshot as RepositoryJsonValue, now: input.now() })
  if (step.ordinal !== ordinal) throw new Error("approved_application_fill_resume_step_conflict")
  const started = await store.appendEvent({ owner, id: eventId(lease.turnId, `step-started:${stepId}`), itemId: null,
    type: "step.started", correlationId: stepId, causationId: turnStarted.id,
    idempotencyKey: `turn:${lease.turnId}:event:step-started:${stepId}`,
    payload: { stepId, ordinal, taskId: rootTaskId } })
  await store.updateStep({ owner, stepId, status: "completed", finishReason: "stop", errorCode: null,
    inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, now: input.now() })
  await store.appendEvent({ owner, id: eventId(lease.turnId, `step-completed:${stepId}`), itemId: null,
    type: "step.completed", correlationId: stepId, causationId: started.id,
    idempotencyKey: `turn:${lease.turnId}:event:step-completed:${stepId}`,
    payload: { stepId, status: "completed", taskId: rootTaskId } })
  if (input.signal.aborted) return interruptedResult(input, rootTaskId, stepCount, toolCallCount)
  const terminal = await store.recordFinalResponse({ owner, response, now: input.now(), terminal: {
    stepId, finalItemId, finalContent, stepCount, toolCallCount, usage, [TASK_GRAPH_FINAL_SUMMARY_BINDING]: binding,
  } })
  if (!terminal || terminal.status !== "completed" || terminal.finalItemId !== finalItemId) {
    throw new Error("approved_application_fill_resume_terminal_receipt_missing")
  }
  const result = { status: "completed" as const, finalItemId, finalText: message, stepCount, toolCallCount }
  await rootTasks.finish({ lease, rootTaskId, result, now: input.now() })
  await input.executionProjection.finish({ ...projectionScope, result: { status: result.status } })
  await input.sessionProjection.finish({ ...projectionScope, result: { status: result.status } })
  return { status: result.status }
}

async function interruptedResult(input: {
  readonly lease: TurnLease; readonly rootTasks: RootTaskStore; readonly executionProjection: CanonicalExecutionProjection
  readonly sessionProjection: CanonicalSessionProjection; readonly now: () => Date
}, rootTaskId: string, stepCount: number, toolCallCount: number): Promise<TurnExecutionResult> {
  const result = { status: "interrupted" as const, stepCount, toolCallCount, errorCode: "turn_cancelled" }
  await input.rootTasks.finish({ lease: input.lease, rootTaskId, result, now: input.now() })
  const scope = { userId: input.lease.userId, sessionId: input.lease.sessionId, turnId: input.lease.turnId }
  await input.executionProjection.finish({ ...scope, result: { status: result.status, errorCode: result.errorCode } })
  await input.sessionProjection.finish({ ...scope, result: { status: result.status, errorCode: result.errorCode } })
  return { status: result.status, summary: result.errorCode }
}

function eventId(turnId: string, suffix: string): string { return `turn:${turnId}:event:${suffix}` }
