import { Prisma, type PrismaClient } from "@prisma/client"
import {
  objectiveApplicationApprovedIntentId, objectiveReviewedFillHandoffIdempotencyKey,
  parseObjectiveApplicationApprovedIntent, parseObjectiveReviewedFillHandoffOutboxRow,
  type ObjectiveApplicationApprovedIntent,
} from "@jobcopilot/shared"
import { verifyLoadedObjectiveReviewedApplicationFillOutcome } from "./objective-reviewed-application-fill-outcome"

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
      select: { id: true, sessionId: true, userId: true, createdAt: true, status: true, source: true, executionMode: true, input: true, finalResponse: true,
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
  const intent = latest.member.intent
  const outcome = await verifyLoadedObjectiveReviewedApplicationFillOutcome(tx, {
    userId: intent.userId, sessionId: intent.sessionId, applicationTaskId: intent.applicationTaskId, jobId: intent.jobId,
    approvalId: intent.approvalId, setId: intent.setId, slotOrdinal: intent.slotOrdinal,
    sourceTurnId: intent.sourceTurnId, reviewTurnId: intent.reviewTurnId, fillTurnId: latest.task.fillTurnId!,
  }, latest.member.event, latest.turn)
  return outcome.status === "confirmed" ? "ready" : outcome.status
}

function sameOutboxIntent(row: Row, intent: ObjectiveApplicationApprovedIntent): boolean { return row.userId === intent.userId && row.sessionId === intent.sessionId && row.applicationTaskId === intent.applicationTaskId && row.approvalId === intent.approvalId && row.predecessorTurnId === intent.reviewTurnId }
function sameTaskOwner(task: TaskRow, intent: ObjectiveApplicationApprovedIntent): boolean { return task.id === intent.applicationTaskId && task.userId === intent.userId && task.sessionId === intent.sessionId && task.jobId === intent.jobId }
function validInput(input: ContinuationInput): boolean { return [input.userId, input.sessionId, input.applicationTaskId, input.approvalId, input.setId, input.sourceTurnId, input.reviewTurnId].every(validId) && Number.isSafeInteger(input.slotOrdinal) && input.slotOrdinal >= 1 && input.slotOrdinal <= 8 }
function validId(value: unknown): value is string { return typeof value === "string" && ID.test(value) }
function validDate(value: unknown): value is Date { return value instanceof Date && Number.isFinite(value.getTime()) }
