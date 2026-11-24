import { Prisma, type PrismaClient } from "@prisma/client"
import {
  canonicalJson, hashContent, objectiveApplicationApprovedIntentId, objectiveReviewedFillHandoffIdempotencyKey,
  parseObjectiveApplicationApprovedIntent, parseObjectiveReviewedFillHandoffOutboxRow, parseObjectiveReviewedFillSource,
  type ObjectiveApplicationApprovedIntent,
} from "@jobcopilot/shared"

type Tx = Prisma.TransactionClient
type Row = Record<string, unknown>
type TaskRow = { id: string; userId: string; sessionId: string; jobId: string; status: string; checkpoint: string | null;
  workerTaskId: string | null; fillTurnId: string | null; fillTurnSessionId: string | null; fillTurnUserId: string | null; completedAt: Date | null }
type ApprovedRow = { id: string; taskId: string; type: string; actor: string; body: string; data: unknown; task: TaskRow }
type ContinuationInput = Readonly<{ userId: string; sessionId: string; applicationTaskId: string; approvalId: string;
  setId: string; slotOrdinal: number; sourceTurnId: string; reviewTurnId: string }>
type Result = "first" | "ready" | "deferred" | "invalid"
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
const APPROVED_KEYS = ["schemaVersion", "userId", "sessionId", "reviewTurnId", "applicationTaskId", "jobId",
  "approvalId", "setId", "slotOrdinal", "sourceTurnId", "materialProofHash"] as const
const FINAL_KEYS = ["schemaVersion", "userId", "sessionId", "jobId", "applicationTaskId", "fillTurnId", "approvalId",
  "constraintHash", "workerTaskId", "executionId", "attemptId", "resultLinkEventId", "applyResultId"] as const
const HASH = /^[a-f0-9]{64}$/
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/

/** Continues a user-approved set only after its latest bound Fill has canonical success evidence. */
export async function verifyObjectiveReviewedFillContinuation(tx: Tx, input: ContinuationInput): Promise<Result> {
  if (!validInput(input)) return "invalid"
  const pauses = await tx.$queryRaw<Array<{ paused: boolean }>>(Prisma.sql`
    SELECT EXISTS (SELECT 1 FROM "agent_events" pause WHERE pause."sessionId"=${input.sessionId}
      AND pause."actor"='user' AND pause."type"='session.pause_requested' AND NOT EXISTS (
        SELECT 1 FROM "agent_events" resumed WHERE resumed."sessionId"=pause."sessionId" AND resumed."turnId"=pause."turnId"
          AND resumed."actor"='user' AND resumed."type"='session.resume_requested' AND resumed."sequence">pause."sequence")) AS paused`)
  if (pauses.length !== 1 || typeof pauses[0]?.paused !== "boolean") return "invalid"
  if (pauses[0].paused) return "deferred"
  const events = await tx.applicationTaskEvent.findMany({
    where: { type: APPROVED_EVENT, actor: "user", task: { is: { userId: input.userId, sessionId: input.sessionId } },
      data: { path: ["setId"], equals: input.setId } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: 9,
    select: { id: true, taskId: true, type: true, actor: true, body: true, data: true,
      task: { select: { id: true, userId: true, sessionId: true, jobId: true, status: true, checkpoint: true,
        workerTaskId: true, fillTurnId: true, fillTurnSessionId: true, fillTurnUserId: true, completedAt: true } } },
  }) as ApprovedRow[]
  if (events.length === 0 || events.length > 8) return "invalid"
  const members: Array<{ event: ApprovedRow; intent: ObjectiveApplicationApprovedIntent }> = []
  const slots = new Set<number>(), approvals = new Set<string>(), tasks = new Set<string>()
  for (const event of events) {
    const intent = parseObjectiveApplicationApprovedIntent(event.data)
    if (!intent || event.id !== objectiveApplicationApprovedIntentId(intent.setId, intent.slotOrdinal)
      || event.type !== APPROVED_EVENT || event.actor !== "user" || event.body !== APPROVED_BODY
      || event.taskId !== intent.applicationTaskId || !sameTaskOwner(event.task, intent)
      || intent.setId !== input.setId || intent.userId !== input.userId || intent.sessionId !== input.sessionId
      || intent.sourceTurnId !== input.sourceTurnId || intent.reviewTurnId !== input.reviewTurnId
      || slots.has(intent.slotOrdinal) || approvals.has(intent.approvalId) || tasks.has(intent.applicationTaskId)) return "invalid"
    slots.add(intent.slotOrdinal); approvals.add(intent.approvalId); tasks.add(intent.applicationTaskId)
    members.push({ event, intent })
  }
  const current = members.find(({ intent, event }) => intent.approvalId === input.approvalId
    && intent.applicationTaskId === input.applicationTaskId && intent.slotOrdinal === input.slotOrdinal
    && event.task.fillTurnId === null)
  if (!current) return "invalid"
  const bound = members.filter(member => member !== current && member.event.task.fillTurnId !== null)
  if (bound.length === 0) return "first"
  const turnIds = bound.map(member => member.event.task.fillTurnId!)
  if (new Set(turnIds).size !== turnIds.length) return "invalid"
  const keys = [current, ...bound].map(({ intent }) => objectiveReviewedFillHandoffIdempotencyKey(intent.approvalId))
  if (keys.some(key => !key)) return "invalid"
  const outboxes = await tx.agentOutbox.findMany({
    where: { idempotencyKey: { in: keys as string[] } },
    select: { id: true, topic: true, aggregateId: true, idempotencyKey: true, payload: true, publishedAt: true, lastError: true },
  })
  if (outboxes.length !== keys.length) return "invalid"
  const outboxByKey = new Map<string, (typeof outboxes)[number]>()
  for (const row of outboxes) {
    if (outboxByKey.has(row.idempotencyKey)) return "invalid"
    const parsed = parseObjectiveReviewedFillHandoffOutboxRow({ id: row.id, topic: row.topic, aggregateId: row.aggregateId,
      idempotencyKey: row.idempotencyKey, payload: row.payload })
    const member = members.find(candidate => objectiveReviewedFillHandoffIdempotencyKey(candidate.intent.approvalId) === row.idempotencyKey)
    if (!parsed || !member || !sameOutboxIntent(parsed.payload, member.intent)) return "invalid"
    outboxByKey.set(row.idempotencyKey, row)
  }
  for (const member of bound) {
    const row = outboxByKey.get(objectiveReviewedFillHandoffIdempotencyKey(member.intent.approvalId)!)
    if (!row?.publishedAt || row.lastError !== null) return "deferred"
  }
  const [turnRows, inputRows] = await Promise.all([
    tx.agentTurn.findMany({ where: { id: { in: turnIds }, sessionId: input.sessionId, userId: input.userId },
      select: { id: true, createdAt: true, status: true, source: true, executionMode: true, input: true, finalResponse: true,
        error: true, rootTaskId: true, completedAt: true, leaseOwnerId: true, leaseExpiresAt: true } }),
    tx.agentInput.findMany({ where: { sessionId: input.sessionId, userId: input.userId,
      OR: bound.map(member => ({ targetTurnId: member.event.task.fillTurnId!,
        clientMessageId: objectiveReviewedFillHandoffIdempotencyKey(member.intent.approvalId)!, delivery: "follow_up" })) },
      select: { targetTurnId: true, clientMessageId: true, acceptedSequence: true, delivery: true, cancelledAt: true } }),
  ])
  if (turnRows.length !== turnIds.length || inputRows.length !== turnIds.length) return "invalid"
  const turnById = new Map(turnRows.map(row => [row.id, row])), inputById = new Map(inputRows.map(row => [row.targetTurnId, row]))
  const ordered = bound.map(member => {
    const task = member.event.task, id = task.fillTurnId!
    const turn = turnById.get(id), accepted = inputById.get(id)
    if (!turn || !accepted || accepted.clientMessageId !== objectiveReviewedFillHandoffIdempotencyKey(member.intent.approvalId)
      || accepted.delivery !== "follow_up" || accepted.cancelledAt !== null || typeof accepted.acceptedSequence !== "bigint"
      || !validDate(turn.createdAt)) return null
    return { member, task, turn, sequence: accepted.acceptedSequence }
  })
  if (ordered.some(value => value === null)) return "invalid"
  const valid = ordered as Array<NonNullable<(typeof ordered)[number]>>
  valid.sort((a, b) => a.sequence < b.sequence ? -1 : a.sequence > b.sequence ? 1 : 0)
  if (valid.some((row, index) => index > 0 && row.sequence === valid[index - 1]!.sequence)) return "invalid"
  const latest = valid[valid.length - 1]!
  return verifySuccessfulFill(tx, latest.member.intent, latest.task, latest.turn)
}

async function verifySuccessfulFill(tx: Tx, approved: ObjectiveApplicationApprovedIntent, task: TaskRow, turn: Row): Promise<Result> {
  const fillTurnId = task.fillTurnId!
  if (task.status !== "submitted" || task.checkpoint !== "submission_verified" || !validDate(task.completedAt)
    || !task.workerTaskId || task.fillTurnSessionId !== approved.sessionId || task.fillTurnUserId !== approved.userId
    || turn.id !== fillTurnId || turn.status !== "completed" || turn.source !== "user" || turn.executionMode !== "canonical_task_graph"
    || turn.error !== null || !validDate(turn.completedAt) || turn.leaseOwnerId !== null || turn.leaseExpiresAt !== null
    || !validId(turn.rootTaskId)) return "deferred"
  const turnInput = record(turn.input), source = parseObjectiveReviewedFillSource(turnInput)
  if (!turnInput || !source || source.approvalId !== approved.approvalId || source.reviewTurnId !== approved.reviewTurnId
    || source.materialProofHash !== approved.materialProofHash || turnInput.clientMessageId !== objectiveReviewedFillHandoffIdempotencyKey(approved.approvalId)
    || !exactFillInput(turnInput)) return "invalid"
  const final = parseFinalResponse(turn.finalResponse)
  if (!final) return "deferred"
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
    || job.status !== "applied" || job.workflowState !== "submitted" || !validDate(job.appliedAt)) return "deferred"
  if (!root || root.status !== "completed" || root.leaseOwner !== null || root.attemptCount !== 1
    || !rootResult(root.result, finalItemId)) return "deferred"
  if (!itemMatches(items, finalItemId, rootTaskId, final)) return "deferred"
  if (!terminalEventMatches(terminalEvents, fillTurnId, rootTaskId, finalItemId, final)
    || !finalizationMatches(finalEvents, approved, task, fillTurnId, resultEvents)) return "deferred"
  return "ready"
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
    ["schemaVersion", "applicationTaskId", "userId", "jobId", "sessionId", "fillTurnId", "approvalId", "constraintHash",
      "workerTaskId", "executionId", "attemptId", "applyResultId"])
  const approvalId = "application-fill:" + task.id + ":" + fillTurnId
  const expectedId = "objective-application-submit-result:" +
    hashContent([task.id, fillTurnId, approvalId]).slice(7)
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
  const event = rows[0]!, payload = record(event.payload)
  const key = "turn:" + turnId + ":event:turn-completed"
  return event.id === key && event.idempotencyKey === key && event.actor === "orchestrator" && event.type === "turn.completed"
    && event.taskId === rootTaskId && event.itemId === itemId && !!payload
    && exactObject(payload, ["turnId", "taskId", "finalItemId", "usage"]) !== null
    && payload.turnId === turnId && payload.taskId === rootTaskId && payload.finalItemId === itemId
    && sameJson(payload.usage, final.usage)
}
function rootResult(value: unknown, finalItemId: string): boolean { const result = record(value); return result?.status === "completed" && result.finalItemId === finalItemId && result.waitId === null }
function parseFinalResponse(value: unknown): Row | null {
  if (typeof value !== "string") return null
  try {
    const final = exactObject(JSON.parse(value), ["schemaVersion", "goal", "completed", "completedTasks", "notCompleted", "blocker",
      "next", "evidenceRefs", "response", "usage", "stepCount", "toolCallCount", "terminalReason", "summary"])
    return final && final.schemaVersion === "agent-harness.v2.final" && final.completed === true
      && final.terminalReason === "goal_satisfied" && final.response === FINAL_RESPONSE && final.summary === FINAL_RESPONSE
      && Array.isArray(final.evidenceRefs) && final.evidenceRefs.length === 1 && final.evidenceRefs[0] === FINAL_EVIDENCE ? final : null
  } catch { return null }
}
function exactFillInput(input: Row): boolean {
  if (Object.keys(input).sort().join(",") !== "clientMessageId,content,goal,reviewedApplicationMaterialSource" || input.goal !== FILL_TEXT
    || !Array.isArray(input.content) || input.content.length !== 1) return false
  const part = record(input.content[0])
  return !!part && Object.keys(part).sort().join(",") === "text,type" && part.type === "text" && part.text === FILL_TEXT
}
function sameTaskOwner(task: TaskRow, intent: ObjectiveApplicationApprovedIntent): boolean { return task.id === intent.applicationTaskId && task.userId === intent.userId && task.sessionId === intent.sessionId && task.jobId === intent.jobId }
function sameOutboxIntent(row: Row, intent: ObjectiveApplicationApprovedIntent): boolean { return row.userId === intent.userId && row.sessionId === intent.sessionId && row.applicationTaskId === intent.applicationTaskId && row.approvalId === intent.approvalId && row.predecessorTurnId === intent.reviewTurnId }
function validInput(input: ContinuationInput): boolean { return [input.userId, input.sessionId, input.applicationTaskId, input.approvalId, input.setId, input.sourceTurnId, input.reviewTurnId].every(validId) && Number.isSafeInteger(input.slotOrdinal) && input.slotOrdinal >= 1 && input.slotOrdinal <= 8 }
function validId(value: unknown): value is string { return typeof value === "string" && ID.test(value) }
function validDate(value: unknown): value is Date { return value instanceof Date && Number.isFinite(value.getTime()) }
function record(value: unknown): Row | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  try {
    const proto = Object.getPrototypeOf(value)
    if (proto !== Object.prototype && proto !== null) return null
    if (Reflect.ownKeys(value).some(key => typeof key !== "string" || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key) ?? {}, "value"))) return null
    return value as Row
  } catch { return null }
}
function exactObject(value: unknown, keys: readonly string[]): Row | null {
  const row = record(value)
  return row && Reflect.ownKeys(row).length === keys.length && keys.every(key => Object.hasOwn(row, key)) ? row : null
}
function sameJson(a: unknown, b: unknown): boolean { try { return canonicalJson(a) === canonicalJson(b) } catch { return false } }
