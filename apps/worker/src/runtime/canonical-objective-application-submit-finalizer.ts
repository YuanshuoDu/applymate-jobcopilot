import type { Pool, PoolClient } from "pg"
import { parseObjectiveReviewedFillSource } from "@jobcopilot/shared"
import type { ApplicationSubmissionExecution } from "../queue/application-submit-fence.js"
import { projectObjectiveSessionAfterFillTerminal } from "../db/application-task-state.js"
import {
  OBJECTIVE_APPLICATION_SUBMIT_FINALIZATION_EVENT_BODY, OBJECTIVE_APPLICATION_SUBMIT_FINALIZATION_EVENT_TYPE,
  objectiveApplicationSubmitFinalizationEventId, parseObjectiveApplicationSubmitFinalizationReceipt,
  readObjectiveApplicationSubmitFinalizationWithClient, hasObjectiveApplicationSubmitFinalizationEvidenceWithClient,
} from "./turns/recovery-scanner-objective-submit.js"
import { executionOwnerFence } from "./execution-owner.js"
import type { TurnLease } from "./turns/lease.js"
import type { CanonicalTurnState } from "./canonical-turn-state.js"
import type { CanonicalExecutionProjection } from "./canonical-execution-projection.js"
import type { CanonicalSessionProjection } from "./canonical-session-projection.js"
import type { RootTaskStore } from "./subagents/root-task-store.js"
import { createPgTurnEngineStore } from "./turns/turn-engine-store.js"
import type { TurnEngineStore } from "./turns/turn-engine-types.js"
import type { TurnEngineResult } from "./turns/turn-engine-types.js"
import type { TurnEngineTerminalGuard } from "./turns/turn-engine-terminal-commit.js"
import { toRepositoryJson } from "./turns/turn-engine-types.js"
import { finalizeTurn, serializeFinalResponse } from "./finalizer.js"
import { verifyCandidateFinal } from "./verifier.js"

type Row = Record<string, unknown>
type QueryClient = Pick<PoolClient, "query">
type StoreFactory = (pool: Pool, guard?: TurnEngineTerminalGuard) => TurnEngineStore
type Task = { id: string; jobId: string; status: string; checkpoint: string | null; workerTaskId: string | null }
type Finalization = NonNullable<Awaited<ReturnType<typeof readObjectiveApplicationSubmitFinalizationWithClient>>>
type ObjectiveMarker = "absent" | "valid" | "invalid"
type Disposition = Readonly<{ kind: "none" } | { kind: "blocked" } | { kind: "confirmed"; execution: ApplicationSubmissionExecution; receipt: Finalization }>

const RESPONSE = "The application site confirmed that the application was submitted."
const EVIDENCE_REF = "objective_application_submit_site_confirmation"
const FINAL_STEP_PREFIX = "objective-application-submit-finalize:"
const UNAVAILABLE = "objective_submit_finalization_unavailable"
const OBJECTIVE_FILL_KEY_PREFIX = "agent-objective-reviewed-fill:"

/** Intercepts only a confirmed Objective submit; all other Fill Turns use normal canonical setup. */
export async function finalizeCanonicalObjectiveApplicationSubmit(input: {
  readonly pool: Pool; readonly lease: TurnLease; readonly state: CanonicalTurnState; readonly signal: AbortSignal
  readonly rootTasks: RootTaskStore; readonly executionProjection: CanonicalExecutionProjection
  readonly sessionProjection: CanonicalSessionProjection; readonly now: () => Date; readonly storeFactory?: StoreFactory
}): Promise<import("./turns/turn-queue.js").TurnExecutionResult | undefined> {
  const { state, lease } = input
  if (state.source !== "user" || state.automationRunMode === "scheduled") return undefined
  const marker = objectiveMarker(state.turnInput)
  if (marker === "absent") return undefined
  const disposition = await readDisposition(input.pool, lease, input.now(), marker)
  if (disposition.kind === "none") return undefined
  const root = await input.rootTasks.ensure({ lease, goal: state.goal, modelProfileSnapshot: state.modelProfileSnapshot,
    toolPolicySnapshot: state.toolPolicySnapshot, budgetSnapshot: state.budgetSnapshot, allowedActions: [], now: input.now() })
  if (state.rootTaskId && root.id !== state.rootTaskId) throw new Error("objective_submit_root_mismatch")
  const rootTaskId = root.id, resume = state.resume
  if (resume && (resume.stepCount < 1 || !Number.isSafeInteger(resume.toolCallCount) || resume.toolCallCount < 0)) {
    throw new Error("objective_submit_resume_invalid")
  }
  const identity = { userId: lease.userId, sessionId: lease.sessionId, turnId: lease.turnId }
  await input.executionProjection.start(identity); await input.sessionProjection.start(identity)
  const result: TurnEngineResult = disposition.kind === "confirmed" && !input.signal.aborted
    ? resume ? await terminalize(input, rootTaskId, resume, disposition.execution, disposition.receipt)
      : { status: "waiting_for_user" as const, stepCount: 0, toolCallCount: 0, errorCode: UNAVAILABLE }
    : { status: input.signal.aborted ? "interrupted" as const : "waiting_for_user" as const,
      stepCount: resume?.stepCount ?? 0, toolCallCount: resume?.toolCallCount ?? 0,
      errorCode: input.signal.aborted ? "turn_cancelled" : UNAVAILABLE }
  await settleRoot(input, rootTaskId, result)
  return { status: result.status, summary: result.errorCode, ...(result.waitId ? { waitId: result.waitId } : {}) }
}

async function readDisposition(pool: Pool, lease: TurnLease, now: Date, marker: ObjectiveMarker): Promise<Disposition> {
  const client = await pool.connect(); let committed = false
  try {
    await client.query("BEGIN")
    await client.query("SELECT set_config($1, $2, true)", ["app.user_id", lease.userId])
    const turn = await client.query<Row>(`SELECT "source","executionMode","status" FROM "agent_turns"
      WHERE "id"=$1 AND "sessionId"=$2 AND "userId"=$3 AND "leaseOwnerId"=$4 AND "leaseVersion"=$5
        AND "leaseExpiresAt">$6 AND "status"='in_progress' LIMIT 2`,
    [lease.turnId, lease.sessionId, lease.userId, lease.ownerId, lease.leaseVersion, now])
    if (turn.rows.length !== 1 || turn.rows[0]?.source !== "user" || turn.rows[0]?.executionMode !== "canonical_task_graph") {
      await client.query("COMMIT"); committed = true; return { kind: "blocked" }
    }
    if (marker === "invalid") { await client.query("COMMIT"); committed = true; return { kind: "blocked" } }
    const tasks = await client.query<Task>(`SELECT "id","jobId","status","checkpoint","workerTaskId" FROM "application_tasks"
      WHERE "userId"=$1 AND "sessionId"=$2 AND "fillTurnId"=$3 AND "fillTurnSessionId"=$2 AND "fillTurnUserId"=$1 LIMIT 2`,
    [lease.userId, lease.sessionId, lease.turnId])
    if (tasks.rows.length === 0) { await client.query("COMMIT"); committed = true; return { kind: "none" } }
    if (tasks.rows.length !== 1) { await client.query("COMMIT"); committed = true; return { kind: "blocked" } }
    const task = tasks.rows[0]!
    const events = await client.query<Row>(`SELECT "id","taskId","type","actor","body","data","createdAt" FROM "application_task_events"
      WHERE "taskId"=$1 AND "type"=$2 ORDER BY "createdAt" ASC,"id" ASC LIMIT 2`,
    [task.id, OBJECTIVE_APPLICATION_SUBMIT_FINALIZATION_EVENT_TYPE])
    if (events.rows.length > 1) { await client.query("COMMIT"); committed = true; return { kind: "blocked" } }
    if (events.rows.length === 1) {
      const event = events.rows[0]!, parsed = parseObjectiveApplicationSubmitFinalizationReceipt(event.data)
      const execution = parsed ? executionFor(parsed) : null
      const identityMatches = !!parsed && !!execution && event.taskId === task.id && event.type === OBJECTIVE_APPLICATION_SUBMIT_FINALIZATION_EVENT_TYPE
        && event.actor === "worker" && event.body === OBJECTIVE_APPLICATION_SUBMIT_FINALIZATION_EVENT_BODY
        && event.id === objectiveApplicationSubmitFinalizationEventId(execution, parsed.resultLinkEventId)
        && execution.applicationTaskId === task.id && execution.userId === lease.userId
        && execution.sessionId === lease.sessionId && execution.fillTurnId === lease.turnId && execution.jobId === task.jobId
        && execution.workerTaskId === task.workerTaskId
      const current = identityMatches && execution ? await readObjectiveApplicationSubmitFinalizationWithClient(client, execution) : null
      if (!current || !sameReceipt(current, parsed!)) {
        await client.query("COMMIT"); committed = true; return { kind: "blocked" }
      }
      await client.query("COMMIT"); committed = true; return { kind: "confirmed", execution: execution!, receipt: current }
    }
    const evidence = await hasObjectiveApplicationSubmitFinalizationEvidenceWithClient(client, { applicationTaskId: task.id })
    const [approval, attempts, starts, results] = await Promise.all([
      client.query<Row>(`SELECT "status","consumedAt" FROM "agent_approvals" WHERE "id"=$1 AND "userId"=$2 AND "sessionId"=$3
        AND "turnId"=$4 AND "taskId"=$5 AND "type"='submit_application' LIMIT 2`,
      [`application-fill:${task.id}:${lease.turnId}`, lease.userId, lease.sessionId, lease.turnId, task.id]),
      client.query<Row>(`SELECT "id" FROM "submission_attempt" WHERE "userId"=$1 AND "jobId"=$2 AND "receiptId"=$3 LIMIT 1`,
      [lease.userId, task.jobId, `application-fill:${task.id}:${lease.turnId}`]),
      client.query<Row>(`SELECT "id" FROM "application_task_events" WHERE "taskId"=$1 AND "type"='submission_execution_started'
        AND "data"->>'fillTurnId'=$2 LIMIT 1`, [task.id, lease.turnId]),
      client.query<Row>(`SELECT "id" FROM "application_task_events" WHERE "taskId"=$1
        AND "type"='objective_application_submit_result_recorded' AND "data"->>'fillTurnId'=$2 LIMIT 1`, [task.id, lease.turnId]),
    ])
    const consumed = approval.rows.some(row => row.status === "consumed" && row.consumedAt != null)
    const requestMayHaveStarted = evidence || consumed || attempts.rows.length > 0 || starts.rows.length > 0 || results.rows.length > 0
      || task.status === "submitted" || task.checkpoint === "submission_request_started" || task.checkpoint === "submission_verified"
    await client.query("COMMIT"); committed = true
    return requestMayHaveStarted ? { kind: "blocked" } : { kind: "none" }
  } catch (error: unknown) {
    if (!committed) await client.query("ROLLBACK").catch(() => undefined)
    throw error
  } finally { client.release() }
}

async function terminalize(input: Parameters<typeof finalizeCanonicalObjectiveApplicationSubmit>[0], rootTaskId: string,
  resume: NonNullable<CanonicalTurnState["resume"]>, execution: ApplicationSubmissionExecution,
  receipt: Finalization): Promise<TurnEngineResult> {
  const { state, lease } = input
  const owner = executionOwnerFence({ kind: "turn", taskId: rootTaskId, lease })
  if (owner.kind !== "turn" || owner.taskId !== owner.rootTaskId) throw new Error("objective_submit_owner_invalid")
  const stepId = `${FINAL_STEP_PREFIX}${lease.turnId}`
  const prior = await readFinalStep(input.pool, owner.sessionId, owner.turnId, owner.taskId, stepId)
  if (prior === "invalid") throw new Error("objective_submit_final_step_conflict")
  const priorStep = prior === false ? null : prior
  const stepCount = resume.stepCount + (priorStep ? 0 : 1), toolCallCount = resume.toolCallCount
  const response = RESPONSE, itemId = `turn:${lease.turnId}:item:final:${stepId}`
  const verification = verifyCandidateFinal({ goal: state.goal, candidate: { text: response, finishReason: "stop", evidenceRefs: [EVIDENCE_REF] },
    evidence: [{ id: EVIDENCE_REF, status: "verified" }] })
  if (!verification.ok) throw new Error("objective_submit_final_verification_failed")
  const final = finalizeTurn({ goal: state.goal, verification, terminalReason: "goal_satisfied", response,
    summaryOverride: response, usage: resume.usage, stepCount, toolCallCount })
  const finalContent = toRepositoryJson({ text: response, final: toRepositoryJson(final) })
  const serialized = serializeFinalResponse(final)
  const guard: TurnEngineTerminalGuard = (client, terminal) => verifyAtCommit(client, terminal, {
    execution, receipt, owner, stepId, itemId, stepCount, toolCallCount, serialized, finalContent,
  })
  const store = (input.storeFactory ?? createPgTurnEngineStore)(input.pool, guard)
  const step = await store.startStep({ owner, stepId, ordinal: priorStep?.ordinal ?? resume.nextOrdinal, attempt: 1,
    inputThroughSequence: resume.inputThroughSequence, consumedInputIds: resume.consumedInputIds,
    modelProfileSnapshot: toRepositoryJson(state.modelProfileSnapshot), now: input.now() })
  if (priorStep && step.ordinal !== priorStep.ordinal) throw new Error("objective_submit_final_step_ordinal_mismatch")
  await store.appendEvent({ owner, id: `turn:${lease.turnId}:event:objective-submit-step-started`, itemId: null,
    type: "step.started", correlationId: step.id, causationId: null,
    idempotencyKey: `turn:${lease.turnId}:event:step-started:${step.id}`,
    payload: { stepId: step.id, ordinal: step.ordinal, taskId: owner.taskId } })
  if (priorStep?.status !== "completed") await store.updateStep({ owner, stepId: step.id, status: "completed", finishReason: "stop",
    errorCode: null, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, now: input.now() })
  await store.appendEvent({ owner, id: `turn:${lease.turnId}:event:objective-submit-step-completed`, itemId: null,
    type: "step.completed", correlationId: step.id, causationId: `turn:${lease.turnId}:event:objective-submit-step-started`,
    idempotencyKey: `turn:${lease.turnId}:event:step-completed:${step.id}`,
    payload: { stepId: step.id, status: "completed", taskId: owner.taskId } })
  const terminal = await store.recordFinalResponse({ owner, response: serialized, now: input.now(), terminal: {
    stepId, finalItemId: itemId, finalContent, stepCount, toolCallCount, usage: final.usage,
  } })
  if (!terminal || terminal.status !== "completed" || terminal.finalItemId !== itemId) throw new Error("objective_submit_terminal_missing")
  return { status: "completed", finalItemId: itemId, finalText: response, stepCount, toolCallCount }
}

async function readFinalStep(pool: Pool, sessionId: string, turnId: string, taskId: string, stepId: string): Promise<false | { ordinal: number; status: string } | "invalid"> {
  const client = await pool.connect()
  try {
    const rows = await client.query<Row>(`SELECT "id","sessionId","turnId","taskId","ordinal","attempt","status","finishReason","errorCode"
      FROM "agent_steps" WHERE "id"=$1 AND "sessionId"=$2 AND "turnId"=$3 LIMIT 2`, [stepId, sessionId, turnId])
    if (rows.rows.length === 0) return false
    const row = rows.rows[0]
    if (rows.rows.length !== 1 || !row || row.id !== stepId || row.sessionId !== sessionId || row.turnId !== turnId
      || row.taskId !== taskId || Number(row.attempt) !== 1 || !Number.isSafeInteger(Number(row.ordinal))
      || !["streaming", "completed"].includes(String(row.status))
      || row.status === "completed" && (row.finishReason !== "stop" || row.errorCode !== null)) return "invalid"
    return { ordinal: Number(row.ordinal), status: String(row.status) }
  } finally { client.release() }
}

async function verifyAtCommit(client: PoolClient, terminal: Parameters<TurnEngineTerminalGuard>[1], expected: {
  execution: ApplicationSubmissionExecution; receipt: Finalization; owner: ReturnType<typeof executionOwnerFence> & { kind: "turn" }
  stepId: string; itemId: string; stepCount: number; toolCallCount: number; serialized: string; finalContent: unknown
}): Promise<{ ok: true } | { ok: false; blocker: string; feedback: string }> {
  const denied = { ok: false as const, blocker: UNAVAILABLE, feedback: "The application site confirmation could not be rechecked." }
  if (terminal.owner.turnId !== expected.owner.turnId || terminal.owner.sessionId !== expected.owner.sessionId
    || terminal.owner.userId !== expected.owner.userId || terminal.owner.taskId !== expected.owner.taskId
    || terminal.stepId !== expected.stepId || terminal.finalItemId !== expected.itemId || terminal.stepCount !== expected.stepCount
    || terminal.toolCallCount !== expected.toolCallCount || terminal.response !== expected.serialized
    || JSON.stringify(terminal.finalContent) !== JSON.stringify(expected.finalContent)) return denied
  const current = await readObjectiveApplicationSubmitFinalizationWithClient(client, expected.execution)
  if (!current || !sameFinalization(current, expected.receipt)) return denied
  await projectObjectiveSessionAfterFillTerminal(client, {
    userId: expected.owner.userId, sessionId: expected.owner.sessionId, turnId: expected.owner.turnId,
  })
  return { ok: true }
}

async function settleRoot(input: Parameters<typeof finalizeCanonicalObjectiveApplicationSubmit>[0], rootTaskId: string,
  result: TurnEngineResult): Promise<void> {
  const identity = { userId: input.lease.userId, sessionId: input.lease.sessionId, turnId: input.lease.turnId }
  await input.rootTasks.finish({ lease: input.lease, rootTaskId, result, now: input.now() })
  await input.executionProjection.finish({ ...identity, result: { status: result.status, errorCode: result.errorCode } })
  await input.sessionProjection.finish({ ...identity, result: { status: result.status, errorCode: result.errorCode } })
}

function executionFor(value: ReturnType<typeof parseObjectiveApplicationSubmitFinalizationReceipt>): ApplicationSubmissionExecution | null {
  return value ? { applicationTaskId: value.applicationTaskId, userId: value.userId, jobId: value.jobId,
    sessionId: value.sessionId, fillTurnId: value.fillTurnId, approvalId: value.approvalId,
    constraintHash: value.constraintHash, workerTaskId: value.workerTaskId, executionId: value.executionId } : null
}
function sameFinalization(left: Finalization, right: Finalization): boolean {
  return left.schemaVersion === right.schemaVersion && left.applicationTaskId === right.applicationTaskId
    && left.userId === right.userId && left.jobId === right.jobId && left.sessionId === right.sessionId
    && left.fillTurnId === right.fillTurnId && left.approvalId === right.approvalId && left.constraintHash === right.constraintHash
    && left.workerTaskId === right.workerTaskId && left.executionId === right.executionId && left.attemptId === right.attemptId
    && left.resultLinkEventId === right.resultLinkEventId && left.applyResultId === right.applyResultId
    && left.eventId === right.eventId
}
function sameReceipt(left: Finalization, right: NonNullable<ReturnType<typeof parseObjectiveApplicationSubmitFinalizationReceipt>>): boolean {
  return left.schemaVersion === right.schemaVersion && left.applicationTaskId === right.applicationTaskId
    && left.userId === right.userId && left.jobId === right.jobId && left.sessionId === right.sessionId
    && left.fillTurnId === right.fillTurnId && left.approvalId === right.approvalId && left.constraintHash === right.constraintHash
    && left.workerTaskId === right.workerTaskId && left.executionId === right.executionId && left.attemptId === right.attemptId
    && left.resultLinkEventId === right.resultLinkEventId && left.applyResultId === right.applyResultId
}

function objectiveMarker(value: unknown): ObjectiveMarker {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "absent"
  try {
    const marker = Object.getOwnPropertyDescriptor(value, "reviewedApplicationMaterialSource")
    const key = Object.getOwnPropertyDescriptor(value, "clientMessageId")
    const reservedKey = !!key && Object.hasOwn(key, "value") && typeof key.value === "string"
      && key.value.startsWith(OBJECTIVE_FILL_KEY_PREFIX)
    if (!marker && !reservedKey) return "absent"
    if (!marker?.enumerable || !Object.hasOwn(marker, "value") || !parseObjectiveReviewedFillSource(value)) return "invalid"
    return "valid"
  } catch { return "invalid" }
}
