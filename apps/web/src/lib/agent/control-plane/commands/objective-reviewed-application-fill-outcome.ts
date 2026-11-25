import { Prisma } from "@prisma/client"
import {
  canonicalJson, hashContent, objectiveApplicationApprovedIntentId, objectiveReviewedFillHandoffIdempotencyKey,
  parseObjectiveApplicationApprovedIntent, parseObjectiveReviewedFillSource, type ObjectiveApplicationApprovedIntent,
} from "@jobcopilot/shared"

type Tx = Prisma.TransactionClient
type Row = Record<string, unknown>
type TaskRow = { id: string; userId: string; sessionId: string; jobId: string; status: string; checkpoint: string | null;
  workerTaskId: string | null; fillTurnId: string | null; fillTurnSessionId: string | null; fillTurnUserId: string | null; completedAt: Date | null }
type ApprovedRow = { id: string; taskId: string; type: string; actor: string; body: string; data: unknown; task: TaskRow }
export type ObjectiveReviewedFillOutcomeSelector = Readonly<{ userId: string; sessionId: string; applicationTaskId: string;
  jobId: string; approvalId: string; setId: string; slotOrdinal: number; sourceTurnId: string; reviewTurnId: string; fillTurnId: string }>
export type ObjectiveReviewedFillOutcome = Readonly<{ status: "confirmed"; fillTurnId: string; finalItemId: string }
  | { status: "deferred" | "invalid" }>

const APPROVED_EVENT = "objective_application_review_approved"
const APPROVED_BODY = "Objective application review approval recorded."
const FINAL_EVENT = "objective_application_submit_finalization_queued"
const RESULT_EVENT = "objective_application_submit_result_recorded"
const RESULT_SCHEMA = "agent-harness.v2.objective-application-submit-result.v1"
const RESULT_BODY = "Objective browser-confirmed result recorded."
const FINAL_SCHEMA = "agent-harness.v2.objective-application-submit-finalization-queued.v1"
const FINAL_BODY = "Objective submit finalization queued."
const FINAL_RESPONSE = "The application site confirmed that the application was submitted."
const FINAL_EVIDENCE = "objective_application_submit_site_confirmation"
const FILL_TEXT = "Fill the server-bound application form for user review. Never submit it."
const FINAL_KEYS = ["schemaVersion", "userId", "sessionId", "jobId", "applicationTaskId", "fillTurnId", "approvalId",
  "constraintHash", "workerTaskId", "executionId", "attemptId", "resultLinkEventId", "applyResultId"] as const
const HASH = /^[a-f0-9]{64}$/
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/

/** Reads one owner-scoped approval event and returns only confirmed Fill evidence links. */
export async function readObjectiveReviewedApplicationFillOutcome(
  tx: Tx, input: ObjectiveReviewedFillOutcomeSelector,
): Promise<ObjectiveReviewedFillOutcome> {
  if (!validInput(input)) return { status: "invalid" }
  const approved = await tx.applicationTaskEvent.findMany({
    where: { taskId: input.applicationTaskId, type: APPROVED_EVENT, actor: "user",
      data: { path: ["approvalId"], equals: input.approvalId }, task: { is: { userId: input.userId, sessionId: input.sessionId } } }, take: 2,
    select: { id: true, taskId: true, type: true, actor: true, body: true, data: true,
      task: { select: { id: true, userId: true, sessionId: true, jobId: true, status: true, checkpoint: true,
        workerTaskId: true, fillTurnId: true, fillTurnSessionId: true, fillTurnUserId: true, completedAt: true } } },
  }) as ApprovedRow[]
  if (approved.length !== 1) return { status: "invalid" }
  const turns = await tx.agentTurn.findMany({ where: { id: input.fillTurnId, sessionId: input.sessionId, userId: input.userId },
    select: { id: true, sessionId: true, userId: true, createdAt: true, status: true, source: true, executionMode: true,
      input: true, finalResponse: true, error: true, rootTaskId: true, completedAt: true, leaseOwnerId: true, leaseExpiresAt: true }, take: 2 })
  if (turns.length !== 1) return { status: "invalid" }
  return verifyLoadedObjectiveReviewedApplicationFillOutcome(tx, input, approved[0], turns[0])
}

/** Shared verifier for a canonical approved-event projection already loaded by the continuation. */
export async function verifyLoadedObjectiveReviewedApplicationFillOutcome(
  tx: Tx, input: ObjectiveReviewedFillOutcomeSelector, approvedValue: unknown, turnValue: unknown,
): Promise<ObjectiveReviewedFillOutcome> {
  if (!validInput(input)) return { status: "invalid" }
  const event = record(approvedValue), intent = parseObjectiveApplicationApprovedIntent(event?.data)
  const task = event ? record(event.task) as TaskRow | null : null, turn = record(turnValue)
  if (!event || !intent || !task || !turn || event.id !== objectiveApplicationApprovedIntentId(intent.setId, intent.slotOrdinal)
    || event.type !== APPROVED_EVENT || event.actor !== "user" || event.body !== APPROVED_BODY
    || event.taskId !== intent.applicationTaskId || !sameTaskOwner(task, intent)
    || intent.userId !== input.userId || intent.sessionId !== input.sessionId || intent.setId !== input.setId
    || intent.slotOrdinal !== input.slotOrdinal || intent.approvalId !== input.approvalId || intent.jobId !== input.jobId
    || intent.sourceTurnId !== input.sourceTurnId || intent.reviewTurnId !== input.reviewTurnId
    || intent.applicationTaskId !== input.applicationTaskId || task.fillTurnId !== input.fillTurnId
    || turn.id !== input.fillTurnId || turn.sessionId !== input.sessionId || turn.userId !== input.userId) return { status: "invalid" }
  return verifySuccessfulFill(tx, intent, task, turn)
}

async function verifySuccessfulFill(tx: Tx, approved: ObjectiveApplicationApprovedIntent, task: TaskRow, turn: Row): Promise<ObjectiveReviewedFillOutcome> {
  const fillTurnId = task.fillTurnId!
  if (task.status !== "submitted" || task.checkpoint !== "submission_verified" || !validDate(task.completedAt)
    || !task.workerTaskId || task.fillTurnSessionId !== approved.sessionId || task.fillTurnUserId !== approved.userId
    || turn.id !== fillTurnId || turn.status !== "completed" || turn.source !== "user" || turn.executionMode !== "canonical_task_graph"
    || turn.error !== null || !validDate(turn.completedAt) || turn.leaseOwnerId !== null || turn.leaseExpiresAt !== null
    || !validId(turn.rootTaskId)) return { status: "deferred" }
  const turnInput = record(turn.input), source = parseObjectiveReviewedFillSource(turnInput)
  if (!turnInput || !source || source.approvalId !== approved.approvalId || source.reviewTurnId !== approved.reviewTurnId
    || source.materialProofHash !== approved.materialProofHash || turnInput.clientMessageId !== objectiveReviewedFillHandoffIdempotencyKey(approved.approvalId)
    || !exactFillInput(turnInput)) return { status: "invalid" }
  const final = parseFinalResponse(turn.finalResponse)
  if (!final) return { status: "deferred" }
  const rootTaskId = turn.rootTaskId
  const finalItemId = "turn:" + fillTurnId + ":item:final:objective-application-submit-finalize:" + fillTurnId
  const [job, root, items, terminalEvents, finalEvents, resultEvents] = await Promise.all([
    tx.job.findFirst({ where: { id: approved.jobId, userId: approved.userId },
      select: { id: true, userId: true, status: true, workflowState: true, appliedAt: true } }),
    tx.subAgentTask.findFirst({ where: { id: rootTaskId, sessionId: approved.sessionId, turnId: fillTurnId,
      rootTaskId, role: "orchestrator", taskType: "root" },
      select: { id: true, status: true, leaseOwner: true, attemptCount: true, result: true } }),
    tx.agentItem.findMany({ where: { id: finalItemId, sessionId: approved.sessionId, turnId: fillTurnId, taskId: rootTaskId },
      select: { id: true, taskId: true, type: true, status: true, phase: true, revision: true, content: true }, take: 2 }),
    tx.agentEvent.findMany({ where: { sessionId: approved.sessionId, turnId: fillTurnId, taskId: rootTaskId,
      itemId: finalItemId, type: "turn.completed" },
      select: { id: true, actor: true, type: true, taskId: true, itemId: true, idempotencyKey: true, payload: true }, take: 2 }),
    tx.applicationTaskEvent.findMany({ where: { taskId: task.id, type: FINAL_EVENT, data: { path: ["fillTurnId"], equals: fillTurnId } },
      select: { id: true, taskId: true, type: true, actor: true, body: true, data: true }, take: 2 }),
    tx.applicationTaskEvent.findMany({ where: { taskId: task.id, type: RESULT_EVENT, data: { path: ["fillTurnId"], equals: fillTurnId } },
      select: { id: true, taskId: true, type: true, actor: true, body: true, data: true }, take: 2 }),
  ])
  if (!job || job.id !== approved.jobId || job.userId !== approved.userId
    || job.status !== "applied" || job.workflowState !== "submitted" || !validDate(job.appliedAt)) return { status: "deferred" }
  if (!root || root.status !== "completed" || root.leaseOwner !== null || root.attemptCount !== 1
    || !rootResult(root.result, finalItemId)) return { status: "deferred" }
  if (!itemMatches(items, finalItemId, rootTaskId, final)) return { status: "deferred" }
  if (!terminalEventMatches(terminalEvents, fillTurnId, rootTaskId, finalItemId, final)
    || !finalizationMatches(finalEvents, approved, task, fillTurnId, resultEvents)) return { status: "deferred" }
  return { status: "confirmed", fillTurnId, finalItemId }
}

function itemMatches(rows: readonly Row[], id: string, rootTaskId: string, final: Row): boolean {
  if (rows.length !== 1) return false
  const row = rows[0]!, content = record(row.content)
  return row.id === id && row.taskId === rootTaskId && row.type === "agent_message" && row.status === "completed" && row.phase === "final_answer" && row.revision === 1
    && content?.text === FINAL_RESPONSE && sameJson(content.final, final)
}
function finalizationMatches(rows: readonly Row[], approved: ObjectiveApplicationApprovedIntent, task: TaskRow, fillTurnId: string,
  resultRows: readonly Row[]): boolean {
  if (rows.length !== 1) return false
  const event = rows[0]!, data = exactObject(event.data, FINAL_KEYS)
  if (!data || event.id !== finalizationId(task.id, fillTurnId, data.executionId, data.resultLinkEventId)
    || event.taskId !== task.id || event.type !== FINAL_EVENT || event.actor !== "worker" || event.body !== FINAL_BODY) return false
  if (data.schemaVersion !== FINAL_SCHEMA || data.userId !== approved.userId || data.sessionId !== approved.sessionId
    || data.jobId !== approved.jobId || data.applicationTaskId !== task.id || data.fillTurnId !== fillTurnId
    || data.approvalId !== "application-fill:" + task.id + ":" + fillTurnId || typeof data.constraintHash !== "string"
    || !HASH.test(data.constraintHash) || data.workerTaskId !== task.workerTaskId || !validId(data.executionId)
    || !validId(data.attemptId) || !validId(data.resultLinkEventId) || !Number.isSafeInteger(data.applyResultId)
    || Number(data.applyResultId) < 1) return false
  return resultLinkMatches(resultRows, approved, task, fillTurnId, data)
}
function resultLinkMatches(rows: readonly Row[], approved: ObjectiveApplicationApprovedIntent, task: TaskRow, fillTurnId: string, final: Row): boolean {
  if (rows.length !== 1) return false
  const event = rows[0]!, data = exactObject(event.data,
    ["schemaVersion", "applicationTaskId", "userId", "jobId", "sessionId", "fillTurnId", "approvalId", "constraintHash", "workerTaskId", "executionId", "attemptId", "applyResultId"])
  const approvalId = "application-fill:" + task.id + ":" + fillTurnId
  const expectedId = "objective-application-submit-result:" + hashContent([task.id, fillTurnId, approvalId]).slice(7)
  return !!data && event.id === final.resultLinkEventId && event.id === expectedId && event.taskId === task.id
    && event.type === RESULT_EVENT && event.actor === "worker" && event.body === RESULT_BODY
    && data.schemaVersion === RESULT_SCHEMA && data.applicationTaskId === task.id && data.userId === approved.userId
    && data.jobId === approved.jobId && data.sessionId === approved.sessionId && data.fillTurnId === fillTurnId
    && data.approvalId === approvalId && data.constraintHash === final.constraintHash && data.workerTaskId === task.workerTaskId
    && data.executionId === final.executionId && data.attemptId === final.attemptId && data.applyResultId === final.applyResultId
}
function finalizationId(taskId: string, fillTurnId: string, executionId: unknown, resultEventId: unknown): string { return "objective-application-submit-finalization:" + hashContent([taskId, fillTurnId, executionId, resultEventId]).slice(7) }
function terminalEventMatches(rows: readonly Row[], turnId: string, rootTaskId: string, itemId: string, final: Row): boolean {
  if (rows.length !== 1) return false
  const event = rows[0]!, payload = record(event.payload), key = "turn:" + turnId + ":event:turn-completed"
  return event.id === key && event.idempotencyKey === key && event.actor === "orchestrator" && event.type === "turn.completed"
    && event.taskId === rootTaskId && event.itemId === itemId && !!payload
    && exactObject(payload, ["turnId", "taskId", "finalItemId", "usage"]) !== null
    && payload.turnId === turnId && payload.taskId === rootTaskId && payload.finalItemId === itemId && sameJson(payload.usage, final.usage)
}
function rootResult(value: unknown, finalItemId: string): boolean { const result = record(value); return result?.status === "completed" && result.finalItemId === finalItemId && result.waitId === null }
function parseFinalResponse(value: unknown): Row | null {
  if (typeof value !== "string") return null
  try {
    const final = exactObject(JSON.parse(value), ["schemaVersion", "goal", "completed", "completedTasks", "notCompleted", "blocker", "next", "evidenceRefs", "response", "usage", "stepCount", "toolCallCount", "terminalReason", "summary"])
    return final && final.schemaVersion === "agent-harness.v2.final" && final.completed === true && final.terminalReason === "goal_satisfied"
      && final.response === FINAL_RESPONSE && final.summary === FINAL_RESPONSE && Array.isArray(final.evidenceRefs)
      && final.evidenceRefs.length === 1 && final.evidenceRefs[0] === FINAL_EVIDENCE ? final : null
  } catch { return null }
}
function exactFillInput(input: Row): boolean {
  if (Object.keys(input).sort().join(",") !== "clientMessageId,content,goal,reviewedApplicationMaterialSource" || input.goal !== FILL_TEXT
    || !Array.isArray(input.content) || input.content.length !== 1) return false
  const part = record(input.content[0])
  return !!part && Object.keys(part).sort().join(",") === "text,type" && part.type === "text" && part.text === FILL_TEXT
}
function sameTaskOwner(task: TaskRow, intent: ObjectiveApplicationApprovedIntent): boolean {
  return task.id === intent.applicationTaskId && task.userId === intent.userId && task.sessionId === intent.sessionId && task.jobId === intent.jobId
}
function validInput(input: ObjectiveReviewedFillOutcomeSelector): boolean {
  return [input.userId, input.sessionId, input.applicationTaskId, input.jobId, input.approvalId, input.setId,
    input.sourceTurnId, input.reviewTurnId, input.fillTurnId].every(validId)
    && Number.isSafeInteger(input.slotOrdinal) && input.slotOrdinal >= 1 && input.slotOrdinal <= 8
}
function validId(value: unknown): value is string { return typeof value === "string" && ID.test(value) }
function validDate(value: unknown): value is Date { return value instanceof Date && Number.isFinite(value.getTime()) }
function record(value: unknown): Row | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  try { const proto = Object.getPrototypeOf(value); if (proto !== Object.prototype && proto !== null) return null
    if (Reflect.ownKeys(value).some(key => typeof key !== "string" || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key) ?? {}, "value"))) return null
    return value as Row
  } catch { return null }
}
function exactObject(value: unknown, keys: readonly string[]): Row | null {
  const row = record(value); return row && Reflect.ownKeys(row).length === keys.length && keys.every(key => Object.hasOwn(row, key)) ? row : null
}
function sameJson(a: unknown, b: unknown): boolean { try { return canonicalJson(a) === canonicalJson(b) } catch { return false } }
