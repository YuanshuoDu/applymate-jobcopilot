import { Prisma } from "@prisma/client"
import { objectiveApplicationApprovalSetItemId, parseObjectiveApplicationApprovalSet } from "@jobcopilot/agent-protocol"
import { appendAgentEventWithOutboxInTransaction } from "../session/fact-store"
import { acquireSourceMaterialFence } from "../source-material-fence"
import { assertApprovalFreshnessInTransaction } from "../approval/decision"
import { readObjectiveApplicationResumeWitness } from "../approval/objective-application-resume-witness"
import { sameObjectiveApplicationResumeWitness } from "@jobcopilot/shared"
import { ApprovalStoreError } from "../approval/types"
import { loadLockedObjectiveApprovalSetMembers, parseObjectiveApprovalSetMemberEnvelope } from "./objective-approval-set-decision-data"
import { waitNotFound, waitNotPending, waitRevisionMismatch, waitScopeMismatch } from "./errors"
import type { LoadedObjectiveApprovalSetMember, ObjectiveApprovalSetMember } from "./objective-approval-set-decision-data"

type Tx = Prisma.TransactionClient
type JsonRecord = Record<string, unknown>
type DecisionStatus = "approved" | "rejected" | "expired"
export type ObjectiveApplicationApprovalSetDecisionInput = Readonly<{
  approvalId: string; userId: string; sessionId: string; expectedTurnId: string; expectedRevision: number
  expectedReceiptRevision: number; expectedScopeHash: string; clientMessageId: string; decision: "approved" | "rejected"; now?: Date
}>
export type ObjectiveApplicationApprovalSetDecisionResult = Readonly<{
  waitKind: "approval_set"; waitId: string; itemId: string; turnId: string; approvalId: string
  disposition: "resolved" | "duplicate"; status: DecisionStatus; nextTurnRevision: number; setCompleted: boolean
}>
export type ObjectiveApplicationApprovalSetDecisionHooks = Readonly<{
  verifySource(tx: Tx, input: ObjectiveApprovalSetSourceInput): Promise<"current" | "stale">
  recordApprovedHandoff(tx: Tx, input: ObjectiveApprovalSetSourceInput): Promise<void>
}>
export type ObjectiveApprovalSetSourceInput = Readonly<{
  setId: string; intentHash: string; sourceTurnId: string; slotOrdinal: number; member: ObjectiveApprovalSetMember
}>

const COMMAND_PREFIX = "objective-approval-set-command:"
const TERMINAL = new Set(["approved", "rejected", "expired"])
function jsonRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null
}
function commandKey(clientMessageId: string): string { return COMMAND_PREFIX + clientMessageId }
function validInput(input: ObjectiveApplicationApprovalSetDecisionInput): boolean {
  return [input.approvalId, input.userId, input.sessionId, input.expectedTurnId, input.clientMessageId]
    .every(value => typeof value === "string" && value.trim().length > 0 && value.length <= 128)
    && Number.isSafeInteger(input.expectedRevision) && input.expectedRevision >= 0
    && Number.isSafeInteger(input.expectedReceiptRevision) && input.expectedReceiptRevision >= 0
    && typeof input.expectedScopeHash === "string" && /^[a-f0-9]{64}$/.test(input.expectedScopeHash)
    && (input.decision === "approved" || input.decision === "rejected")
    && (input.now === undefined || input.now instanceof Date && !Number.isNaN(input.now.getTime()))
}

async function lockScope(tx: Tx, input: ObjectiveApplicationApprovalSetDecisionInput) {
  const sessions = await tx.$queryRaw<Array<{ id: string; status: string }>>(Prisma.sql`
    SELECT "id", "status" FROM "agent_sessions" WHERE "id" = ${input.sessionId} AND "userId" = ${input.userId} FOR UPDATE
  `)
  if (!sessions[0] || ["aborted", "archived"].includes(sessions[0].status)) throw waitNotFound()
  const turns = await tx.$queryRaw<Array<{ id: string; status: string; revision: number }>>(Prisma.sql`
    SELECT "id", "status", "revision" FROM "agent_turns"
    WHERE "id" = ${input.expectedTurnId} AND "sessionId" = ${input.sessionId} AND "userId" = ${input.userId} FOR UPDATE
  `)
  if (!turns[0]) throw waitNotFound()
  return turns[0]
}

async function lockedItem(tx: Tx, itemId: string, input: ObjectiveApplicationApprovalSetDecisionInput) {
  const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "agent_items" WHERE "id" = ${itemId} AND "sessionId" = ${input.sessionId}
      AND "turnId" = ${input.expectedTurnId} AND "type" = 'approval_request' FOR UPDATE
  `)
  if (!rows[0]) throw waitNotFound()
  const item = await tx.agentItem.findFirst({
    where: { id: itemId, sessionId: input.sessionId, turnId: input.expectedTurnId, type: "approval_request" },
    select: { id: true, status: true, revision: true, content: true },
  })
  const set = item && parseObjectiveApplicationApprovalSet(item.content)
  if (!item || !set || objectiveApplicationApprovalSetItemId(set.setId) !== itemId) throw waitScopeMismatch()
  return { item, set }
}

async function lockSourceTurn(tx: Tx, sourceTurnId: string, input: ObjectiveApplicationApprovalSetDecisionInput): Promise<void> {
  if (sourceTurnId === input.expectedTurnId) throw waitScopeMismatch()
  const source = await tx.agentTurn.findFirst({
    where: { id: sourceTurnId, sessionId: input.sessionId, userId: input.userId, status: "completed" }, select: { id: true },
  })
  if (!source) throw waitScopeMismatch()
}

async function duplicate(tx: Tx, input: ObjectiveApplicationApprovalSetDecisionInput, setId: string, itemId: string, itemStatus: string, turnRevision: number, member: LoadedObjectiveApprovalSetMember) {
  const event = await tx.agentEvent.findFirst({
    where: { sessionId: input.sessionId, idempotencyKey: commandKey(input.clientMessageId) },
    select: { type: true, actor: true, itemId: true, turnId: true, correlationId: true, causationId: true, payload: true },
  })
  if (!event) return null
  const payload = jsonRecord(event.payload)
  if (event.turnId !== input.expectedTurnId || event.correlationId !== input.approvalId || !payload) throw waitScopeMismatch()
  if (member.row.status !== "pending" && input.expectedRevision !== member.row.revision + 1) throw waitScopeMismatch()
  let status: DecisionStatus, nextTurnRevision: number
  if (event.type === "approval.resolved" && event.actor === "user" && event.itemId === itemId
    && payload.waitKind === "approval" && payload.waitId === input.approvalId && payload.itemId === itemId
    && payload.turnId === input.expectedTurnId && payload.toolCallId === member.member.toolCallId
    && (payload.status === "approved" || payload.status === "rejected") && payload.status === input.decision
    && Number.isSafeInteger(payload.nextTurnRevision)
    && member.row.status === payload.status) {
    status = payload.status
    nextTurnRevision = Number(payload.nextTurnRevision)
  } else if (event.type === "approval.expired" && event.actor === "system" && event.itemId === null
    && event.causationId === itemId && payload.approvalId === input.approvalId && payload.action === "review_application"
    && payload.revision === member.row.revision && payload.requestedDecision === input.decision
    && payload.expectedTurnRevision === input.expectedRevision && member.row.status === "expired") {
    status = "expired"
    nextTurnRevision = turnRevision
    if (itemStatus === "completed") {
      const wake = await tx.agentEvent.findFirst({ where: { sessionId: input.sessionId, idempotencyKey: `approval-set:${setId}:wakeup` }, select: { payload: true } })
      const wakePayload = wake && jsonRecord(wake.payload)
      if (!wakePayload || wakePayload.waitKind !== "approval_set" || wakePayload.waitId !== setId
        || wakePayload.itemId !== itemId || !Number.isSafeInteger(wakePayload.nextTurnRevision)) throw waitScopeMismatch()
      nextTurnRevision = Number(wakePayload.nextTurnRevision)
    }
  } else throw waitScopeMismatch()
  return { waitKind: "approval_set" as const, waitId: setId, itemId, turnId: input.expectedTurnId,
    approvalId: input.approvalId, disposition: "duplicate" as const, status,
    nextTurnRevision, setCompleted: itemStatus === "completed" }
}

async function updateMember(tx: Tx, member: LoadedObjectiveApprovalSetMember, status: DecisionStatus, now: Date) {
  const row = member.row
  const changed = await tx.agentApproval.updateMany({
    where: { id: row.id, userId: row.userId, sessionId: row.sessionId, turnId: row.turnId, status: "pending", revision: row.revision, scopeHash: row.scopeHash, nonceHash: row.nonceHash },
    data: { status, decidedAt: now },
  })
  if (changed.count !== 1) throw waitNotPending()
}

async function appendMemberOutcome(tx: Tx, member: LoadedObjectiveApprovalSetMember, setId: string, itemId: string,
  status: DecisionStatus, nextTurnRevision: number, clientMessageId?: string, requestedDecision?: "approved" | "rejected", expectedTurnRevision?: number) {
  const { row } = member, resolved = status !== "expired"
  return appendAgentEventWithOutboxInTransaction(tx, {
    sessionId: row.sessionId, turnId: member.member.turnId, itemId: resolved ? itemId : null, taskId: member.member.taskId,
    type: resolved ? "approval.resolved" : "approval.expired", actor: resolved ? "user" : "system",
    correlationId: row.id, causationId: itemId,
    idempotencyKey: clientMessageId ? commandKey(clientMessageId) : `approval-set:${setId}:${row.id}:expired`,
    payload: resolved
      ? { waitKind: "approval", waitId: row.id, itemId, turnId: row.turnId, toolCallId: row.toolCallId, status, nextTurnRevision }
      : { approvalId: row.id, action: row.type, revision: row.revision, ...(requestedDecision && expectedTurnRevision !== undefined ? { requestedDecision, expectedTurnRevision } : {}) },
    outboxTopic: "agent.session.event",
  })
}

async function closeSet(tx: Tx, input: ObjectiveApplicationApprovalSetDecisionInput, setId: string, itemId: string,
  itemRevision: number, turnRevision: number, now: Date): Promise<number> {
  const item = await tx.agentItem.updateMany({
    where: { id: itemId, sessionId: input.sessionId, turnId: input.expectedTurnId, status: "started", revision: itemRevision },
    data: { status: "completed", revision: { increment: 1 }, completedAt: now },
  })
  if (item.count !== 1) throw waitNotPending()
  const nextTurnRevision = turnRevision + 1
  const turn = await tx.agentTurn.updateMany({
    where: { id: input.expectedTurnId, sessionId: input.sessionId, userId: input.userId, status: "waiting_for_approval", revision: turnRevision },
    data: { revision: { increment: 1 } },
  })
  if (turn.count !== 1) throw waitRevisionMismatch(turnRevision, turnRevision + 1)
  const completed = await appendAgentEventWithOutboxInTransaction(tx, {
    sessionId: input.sessionId, turnId: input.expectedTurnId, itemId, taskId: null, type: "item.completed", actor: "orchestrator",
    correlationId: itemId, causationId: itemId, idempotencyKey: "agent-wait:" + itemId + ":completed",
    payload: { itemId, status: "completed" }, outboxTopic: "agent.session.event",
  })
  await appendAgentEventWithOutboxInTransaction(tx, {
    sessionId: input.sessionId, turnId: input.expectedTurnId, itemId, taskId: null, type: "turn.wakeup", actor: "user",
    correlationId: input.expectedTurnId, causationId: completed.event.id, idempotencyKey: "approval-set:" + setId + ":wakeup",
    payload: { waitKind: "approval_set", waitId: setId, itemId, turnId: input.expectedTurnId, toolCallId: null, status: "resolved", nextTurnRevision },
    outboxTopic: "agent.turn.wakeup",
  })
  return nextTurnRevision
}

/** Resolves one durable set member while preserving one aggregate wait and a single final wake. */
export async function decideObjectiveApplicationApprovalSetMemberInTransaction(
  tx: Tx, input: ObjectiveApplicationApprovalSetDecisionInput, hooks: ObjectiveApplicationApprovalSetDecisionHooks,
): Promise<ObjectiveApplicationApprovalSetDecisionResult> {
  if (!validInput(input)) throw waitScopeMismatch()
  const now = input.now ?? new Date()
  await acquireSourceMaterialFence(tx, [input.userId])
  const turn = await lockScope(tx, input)
  const preliminary = await tx.agentApproval.findFirst({
    where: { id: input.approvalId, userId: input.userId, sessionId: input.sessionId, turnId: input.expectedTurnId },
  })
  const marker = preliminary && parseObjectiveApprovalSetMemberEnvelope(preliminary.payload)
  if (!preliminary || !marker) throw waitNotFound()
  let itemId: string
  try { itemId = objectiveApplicationApprovalSetItemId(marker.setId) } catch { throw waitScopeMismatch() }
  const { item, set } = await lockedItem(tx, itemId, input)
  await lockSourceTurn(tx, set.sourceTurnId, input)
  const members = await loadLockedObjectiveApprovalSetMembers(tx, input, set)
  if (item.status === "started" && members.some(({ row }) => row.revision + 1 !== turn.revision)) throw waitScopeMismatch()
  const selected = members.find(({ member }) => member.approvalId === input.approvalId)
  if (!selected) throw waitScopeMismatch()
  if (selected.row.revision !== input.expectedReceiptRevision || selected.row.scopeHash !== input.expectedScopeHash) throw waitScopeMismatch()
  const replay = await duplicate(tx, input, set.setId, itemId, item.status, turn.revision, selected)
  if (replay) return replay
  if (item.status !== "started" || selected.row.status !== "pending") throw waitNotPending()
  if (turn.status !== "waiting_for_approval") throw waitNotPending()
  if (turn.revision !== input.expectedRevision) throw waitRevisionMismatch(input.expectedRevision, turn.revision)

  const setExpired = new Date(set.expiresAt) <= now, pending = members.filter(({ row }) => row.status === "pending")
  const stale = new Set<string>()
  for (const member of pending) {
    if (setExpired || member.row.expiresAt! <= now) { stale.add(member.member.approvalId); continue }
    try {
      await assertApprovalFreshnessInTransaction(tx, { id: member.row.id, userId: input.userId, sessionId: input.sessionId, turnId: input.expectedTurnId })
    } catch (error) {
      if (error instanceof ApprovalStoreError && error.code === "approval_revision_mismatch") stale.add(member.row.id)
      else throw error
    }
    const current = await readObjectiveApplicationResumeWitness(tx, { userId: input.userId, jobId: member.member.jobId })
    if (!current || !sameObjectiveApplicationResumeWitness(member.member.resumeWitness, current)) stale.add(member.row.id)
  }
  let selectedStatus: DecisionStatus = input.decision
  let selectedSource: ObjectiveApprovalSetSourceInput | null = null
  if (stale.has(selected.row.id)) selectedStatus = "expired"
  else if (input.decision === "approved") {
    selectedSource = { setId: set.setId, intentHash: set.intentHash, sourceTurnId: set.sourceTurnId,
      slotOrdinal: selected.slotOrdinal, member: selected.member }
    const freshness = await hooks.verifySource(tx, selectedSource)
    if (freshness !== "current" && freshness !== "stale") throw waitScopeMismatch()
    if (freshness === "stale") { stale.add(selected.row.id); selectedStatus = "expired" }
  }
  const resulting = members.map(({ row }) => row.status === "pending"
    ? row.id === selected.row.id ? selectedStatus : stale.has(row.id) ? "expired" : "pending"
    : row.status)
  const setCompleted = resulting.every(status => TERMINAL.has(status))
  const nextTurnRevision = setCompleted ? turn.revision + 1 : turn.revision
  for (const member of pending) if (stale.has(member.row.id)) {
    await updateMember(tx, member, "expired", now)
    await appendMemberOutcome(tx, member, set.setId, itemId, "expired", nextTurnRevision,
      member.row.id === selected.row.id ? input.clientMessageId : undefined,
      member.row.id === selected.row.id ? input.decision : undefined, member.row.id === selected.row.id ? input.expectedRevision : undefined)
  }
  if (!stale.has(selected.row.id)) {
    await updateMember(tx, selected, input.decision, now)
    if (input.decision === "approved") await hooks.recordApprovedHandoff(tx, selectedSource!)
    await appendMemberOutcome(tx, selected, set.setId, itemId, input.decision, nextTurnRevision, input.clientMessageId, input.decision, input.expectedRevision)
  }
  if (setCompleted) await closeSet(tx, input, set.setId, itemId, item.revision, turn.revision, now)
  return { waitKind: "approval_set", waitId: set.setId, itemId, turnId: input.expectedTurnId,
    approvalId: input.approvalId, disposition: "resolved", status: selectedStatus, nextTurnRevision, setCompleted }
}
