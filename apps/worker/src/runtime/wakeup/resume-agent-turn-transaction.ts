import { randomUUID } from "node:crypto"
import type pg from "pg"
import {
  hashApprovalScope, isApprovalHash, objectiveApplicationApprovalSetItemId,
  parseObjectiveApplicationApprovalSet,
} from "@jobcopilot/agent-protocol"
import { parseObjectiveApplicationResumeWitness } from "@jobcopilot/shared"
import { persistWakeupTurnDispatchInTransaction } from "../turns/recovery-scanner.js"
import { protocolScope } from "../approval/types.js"
import type { AgentTurnWakeupPayload, WakeupResult } from "./types.js"

type Client = pg.PoolClient
type PoolLike = Pick<pg.Pool, "connect">
type RecordValue = Record<string, unknown>
type TerminalWakeupErrorCode = "schema_invalid_payload" | "outbox_scope_mismatch" | "event_lineage_mismatch" | "item_lineage_mismatch" | "tool_lineage_mismatch" | "turn_revision_conflict" | "wait_scope_mismatch" | "approval_set_lineage_mismatch"
type ApprovalRow = {
  id: string; sessionId: string; turnId: string | null; userId: string; taskId: string | null
  jobId: string | null; toolCallId: string | null; type: string; status: string; payload: unknown
  resourceHash: string | null; materialHash: string | null; answersHash: string | null
  scopeHash: string | null; nonceHash: string | null; revision: number; expiresAt: Date | null; consumedAt: Date | null
}
type ApprovalEvent = {
  correlationId: string; type: string; actor: string; itemId: string | null; taskId: string | null; turnId: string
  causationId: string | null; idempotencyKey: string | null; payload: unknown
}

export class TerminalWakeupError extends Error {
  constructor(readonly code: TerminalWakeupErrorCode, message: string) { super(message); this.name = "TerminalWakeupError" }
}
const CLOSED_SESSION_STATUSES = new Set(["aborted", "archived"])
const MEMBER_SCHEMA = "objective-application-approval-set-member.v1"
const COMMAND_PREFIX = "objective-approval-set-command:"
function json(value: unknown): string { return JSON.stringify(value) }
function record(value: unknown): RecordValue | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  try {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return null
    const keys = Reflect.ownKeys(value)
    if (keys.some(key => typeof key !== "string" || !Object.getOwnPropertyDescriptor(value, key)?.enumerable
      || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, "value"))) return null
    return value as RecordValue
  } catch { return null }
}
function fail(code: TerminalWakeupErrorCode, message: string): never { throw new TerminalWakeupError(code, message) }
function approvalSetMismatch(): never { return fail("approval_set_lineage_mismatch", "Approval set lineage is incomplete") }

function validateWakeupPayload(payload: AgentTurnWakeupPayload): void {
  if (payload.waitKind === "approval_set" && (!record(payload) || Reflect.ownKeys(payload).length !== 9
    || Reflect.ownKeys(payload).some(key => typeof key !== "string" || !["eventId", "sessionId", "turnId", "itemId", "waitKind", "waitId", "toolCallId", "status", "nextTurnRevision"].includes(key)))) fail("schema_invalid_payload", "Agent wakeup payload is invalid")
  const identifiers = [payload.eventId, payload.sessionId, payload.turnId, payload.itemId, payload.waitId]
  const validToolCallId = payload.toolCallId === null || (typeof payload.toolCallId === "string" && payload.toolCallId.trim().length > 0)
  const base = identifiers.every(value => typeof value === "string" && value.trim().length > 0)
    && Number.isSafeInteger(payload.nextTurnRevision) && payload.nextTurnRevision >= 0 && validToolCallId
  const validWait = payload.waitKind === "approval_set"
    ? payload.status === "resolved" && payload.toolCallId === null
    : (payload.waitKind === "approval" || payload.waitKind === "question")
      && (payload.status === "approved" || payload.status === "rejected" || payload.status === "answered")
  if (!base || !validWait) fail("schema_invalid_payload", "Agent wakeup payload is invalid")
}

async function assertWakeupEvent(client: Client, payload: AgentTurnWakeupPayload): Promise<void> {
  const result = await client.query<ApprovalEvent & { sessionId: string }>(
    `SELECT "sessionId", "turnId", "itemId", "taskId", "type", "actor", "correlationId", "causationId", "idempotencyKey", "payload"
     FROM "agent_events" WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "itemId" = $4 AND "type" = 'turn.wakeup' FOR SHARE`,
    [payload.eventId, payload.sessionId, payload.turnId, payload.itemId],
  )
  const event = result.rows[0], value = record(event?.payload)
  const matches = !!event && !!value && event.itemId === payload.itemId && event.type === "turn.wakeup"
    && value.waitKind === payload.waitKind && value.waitId === payload.waitId && value.itemId === payload.itemId
    && value.turnId === payload.turnId && value.toolCallId === payload.toolCallId
    && value.status === payload.status && value.nextTurnRevision === payload.nextTurnRevision
  const groupMatches = payload.waitKind !== "approval_set" || (!!value && Reflect.ownKeys(value).length === 7 && event?.actor === "user" && event.taskId === null
    && event.correlationId === payload.turnId && typeof event.causationId === "string" && event.causationId.length > 0
    && event.idempotencyKey === `approval-set:${payload.waitId}:wakeup`)
  if (!matches || !groupMatches) fail("event_lineage_mismatch", "Agent wakeup event lineage does not match payload")
  if (payload.waitKind === "approval_set") {
    const completed = await client.query<ApprovalEvent & { id: string }>(
      `SELECT "id", "turnId", "itemId", "taskId", "type", "actor", "correlationId", "causationId", "idempotencyKey", "payload"
       FROM "agent_events" WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "itemId" = $4 AND "type" = 'item.completed' FOR SHARE`,
      [event!.causationId, payload.sessionId, payload.turnId, payload.itemId],
    )
    const cause = completed.rows[0], body = record(cause?.payload)
    if (!cause || cause.type !== "item.completed" || cause.actor !== "orchestrator" || cause.itemId !== payload.itemId || cause.taskId !== null
      || cause.correlationId !== payload.itemId || cause.causationId !== payload.itemId
      || cause.idempotencyKey !== `agent-wait:${payload.itemId}:completed` || body?.itemId !== payload.itemId
      || body.status !== "completed" || Reflect.ownKeys(body).length !== 2) {
      fail("event_lineage_mismatch", "Approval set completion event lineage does not match wakeup")
    }
  }
}

function exactMemberEnvelope(value: unknown) {
  const envelope = record(value), proof = record(envelope?.proof)
  if (!envelope || Reflect.ownKeys(envelope).length !== 5 || envelope.schema !== MEMBER_SCHEMA
    || typeof envelope.setId !== "string" || typeof envelope.sourceTurnId !== "string"
    || !Number.isSafeInteger(envelope.slotOrdinal) || !proof || !Object.hasOwn(proof, "resumeWitness")) return null
  return { envelope, proof }
}

async function assertMemberScope(row: ApprovalRow, userId: string): Promise<boolean> {
  if (!row.scopeHash || !isApprovalHash(row.scopeHash) || !row.nonceHash || !isApprovalHash(row.nonceHash)
    || !row.resourceHash || !isApprovalHash(row.resourceHash) || !row.materialHash || !isApprovalHash(row.materialHash)
    || !row.answersHash || !isApprovalHash(row.answersHash) || !row.jobId || !row.toolCallId || !row.turnId
    || !row.expiresAt || !Number.isSafeInteger(row.revision)) return false
  return row.scopeHash === await hashApprovalScope(protocolScope({
    userId, sessionId: row.sessionId, turnId: row.turnId, jobId: row.jobId, toolCallId: row.toolCallId,
    action: "review_application", resourceHash: row.resourceHash, materialHash: row.materialHash,
    answersHash: row.answersHash, revision: row.revision, expiresAt: row.expiresAt,
  }, row.nonceHash))
}

async function assertApprovalSetMembers(client: Client, payload: AgentTurnWakeupPayload, userId: string, set: NonNullable<ReturnType<typeof parseObjectiveApplicationApprovalSet>>): Promise<void> {
  const ids = set.members.map(member => member.approvalId)
  const approvals = await client.query<ApprovalRow>(
    `SELECT "id", "sessionId", "turnId", "userId", "taskId", "jobId", "toolCallId", "type", "status", "payload",
       "resourceHash", "materialHash", "answersHash", "scopeHash", "nonceHash", "revision", "expiresAt", "consumedAt"
     FROM "agent_approvals" WHERE "sessionId" = $1 AND "turnId" = $2 AND "userId" = $3 AND "type" = 'review_application'
       AND ("id" = ANY($4::text[]) OR "payload" ->> 'setId' = $5) ORDER BY "id" FOR UPDATE`,
    [payload.sessionId, payload.turnId, userId, ids, set.setId],
  )
  if (approvals.rows.length !== ids.length) approvalSetMismatch()
  const byId = new Map(approvals.rows.map(row => [row.id, row]))
  const jobs = new Set<string>(), calls = new Set<string>()
  for (const member of set.members) {
    const row = byId.get(member.approvalId), parsed = row && exactMemberEnvelope(row.payload)
    const witness = parsed && parseObjectiveApplicationResumeWitness(parsed.proof.resumeWitness)
    if (!row || !parsed || !witness || row.id !== member.approvalId || row.userId !== userId
      || row.sessionId !== payload.sessionId || row.turnId !== payload.turnId || row.type !== "review_application"
      || !row.jobId || !row.toolCallId || row.expiresAt?.toISOString() !== set.expiresAt
      || parsed.envelope.setId !== set.setId || parsed.envelope.sourceTurnId !== set.sourceTurnId
      || parsed.envelope.slotOrdinal !== member.slotOrdinal || witness.userId !== userId || witness.jobId !== row.jobId
      || jobs.has(row.jobId) || calls.has(row.toolCallId) || !await assertMemberScope(row, userId)) approvalSetMismatch()
    const validStatus = row.status === "approved" && row.consumedAt === null
      || row.status === "rejected" && row.consumedAt === null
      || row.status === "expired" && row.consumedAt === null
    if (!validStatus) approvalSetMismatch()
    jobs.add(row.jobId); calls.add(row.toolCallId)
  }
  const events = await client.query<ApprovalEvent>(
    `SELECT "correlationId", "type", "actor", "itemId", "turnId", "causationId", "idempotencyKey", "payload"
     FROM "agent_events" WHERE "sessionId" = $1 AND "turnId" = $2 AND "correlationId" = ANY($3::text[])
       AND "type" IN ('approval.resolved', 'approval.expired') FOR SHARE`, [payload.sessionId, payload.turnId, ids],
  )
  if (events.rows.length !== ids.length) approvalSetMismatch()
  const byApproval = new Map<string, ApprovalEvent[]>()
  for (const event of events.rows) byApproval.set(event.correlationId, [...(byApproval.get(event.correlationId) ?? []), event])
  for (const member of set.members) {
    const row = byId.get(member.approvalId)!, history = byApproval.get(member.approvalId) ?? []
    if (history.length !== 1) approvalSetMismatch()
    const event = history[0]!, body = record(event.payload)
    if (!body || event.turnId !== payload.turnId || event.causationId !== payload.itemId) approvalSetMismatch()
    if (row.status === "expired") {
      const key = event.idempotencyKey
      if (event.type !== "approval.expired" || event.actor !== "system" || event.itemId !== null
        || body.approvalId !== row.id || body.action !== row.type || body.revision !== row.revision
        || !(key === `approval-set:${set.setId}:${row.id}:expired` || typeof key === "string" && key.startsWith(COMMAND_PREFIX) && key.length > COMMAND_PREFIX.length)
        || (key?.startsWith(COMMAND_PREFIX) ? !["approved", "rejected"].includes(String(body.requestedDecision)) || body.expectedTurnRevision !== payload.nextTurnRevision - 1
          : Object.hasOwn(body, "requestedDecision") || Object.hasOwn(body, "expectedTurnRevision"))) approvalSetMismatch()
    } else {
      const status = row.status
      if (event.type !== "approval.resolved" || event.actor !== "user" || event.itemId !== payload.itemId
        || event.correlationId !== row.id || typeof event.idempotencyKey !== "string"
        || !event.idempotencyKey.startsWith(COMMAND_PREFIX) || event.idempotencyKey.length <= COMMAND_PREFIX.length
        || body.waitKind !== "approval" || body.waitId !== row.id || body.itemId !== payload.itemId
        || body.turnId !== payload.turnId || body.toolCallId !== row.toolCallId || body.status !== status
        || !Number.isSafeInteger(body.nextTurnRevision)
        || Number(body.nextTurnRevision) < payload.nextTurnRevision - 1 || Number(body.nextTurnRevision) > payload.nextTurnRevision) approvalSetMismatch()
    }
  }
}

async function appendResumeEvent(client: Client, payload: AgentTurnWakeupPayload, userId: string): Promise<void> {
  const sequenceResult = await client.query<{ eventSequence: string | bigint }>(`UPDATE "agent_sessions" AS session SET "eventSequence" = "eventSequence" + 1
    WHERE session."id" = $1 AND session."userId" = $2 AND session."status" NOT IN ('aborted', 'archived') RETURNING "eventSequence"`, [payload.sessionId, userId])
  const sequence = sequenceResult.rows[0]?.eventSequence
  if (sequence === undefined) throw new Error("Agent session sequence is unavailable for wakeup")
  const eventId = randomUUID(), eventPayload = { waitKind: payload.waitKind, waitId: payload.waitId, itemId: payload.itemId,
    turnId: payload.turnId, toolCallId: payload.toolCallId, status: payload.status, resumedFromEventId: payload.eventId }
  await client.query(`INSERT INTO "agent_events" ("id", "sessionId", "turnId", "itemId", "taskId", "sequence", "type", "actor", "correlationId", "causationId", "idempotencyKey", "payload") VALUES ($1, $2, $3, $4, NULL, $5, 'turn.resumed', 'system', $3, $6, $7, $8::jsonb)`, [eventId, payload.sessionId, payload.turnId, payload.itemId, String(sequence), payload.eventId, `agent-wakeup:${payload.eventId}:resumed`, json(eventPayload)])
  await client.query(`INSERT INTO "agent_outbox" ("id", "topic", "aggregateId", "idempotencyKey", "payload") VALUES ($1, 'agent.session.event', $2, $3, $4::jsonb)`, [`agent-outbox-${eventId}`, payload.sessionId, `agent-event:${eventId}`, json({
    eventId, sessionId: payload.sessionId, turnId: payload.turnId, itemId: payload.itemId, taskId: null, sequence: String(sequence),
    type: "turn.resumed", actor: "system", correlationId: payload.turnId, causationId: payload.eventId,
    idempotencyKey: `agent-wakeup:${payload.eventId}:resumed`, payload: eventPayload,
  })])
}

export async function resumeAgentTurnInTransaction(client: Client, payload: AgentTurnWakeupPayload): Promise<WakeupResult> {
  validateWakeupPayload(payload)
  const sessionResult = await client.query<{ userId: string; status: string }>(`SELECT "userId", "status" FROM "agent_sessions" WHERE "id" = $1 FOR UPDATE`, [payload.sessionId])
  const session = sessionResult.rows[0]
  if (!session || CLOSED_SESSION_STATUSES.has(session.status)) return { status: "ignored", sessionId: payload.sessionId, turnId: payload.turnId, itemId: payload.itemId, toolCallId: payload.toolCallId }
  await client.query(`SELECT set_config($1, $2, true)`, ["app.user_id", session.userId])
  const turnResult = await client.query<{ userId: string; status: string; revision: number; source: string; executionMode: string | null; input: unknown; rootTaskId: string | null; hasLiveLease: boolean }>(
    `SELECT turn."userId", turn."status", turn."revision", turn."source", turn."executionMode", turn."input", turn."rootTaskId",
       COALESCE(turn."leaseOwnerId" IS NOT NULL AND turn."leaseExpiresAt" > CURRENT_TIMESTAMP, FALSE) AS "hasLiveLease"
     FROM "agent_turns" AS turn WHERE turn."id" = $1 AND turn."sessionId" = $2 AND turn."userId" = $3 FOR UPDATE`, [payload.turnId, payload.sessionId, session.userId])
  const turn = turnResult.rows[0]
  if (!turn) return { status: "ignored", sessionId: payload.sessionId, turnId: payload.turnId, itemId: payload.itemId, toolCallId: payload.toolCallId }
  await assertWakeupEvent(client, payload)
  if (turn.status === "queued" || turn.status === "in_progress") return { status: "already_resumed", sessionId: payload.sessionId, turnId: payload.turnId, itemId: payload.itemId, toolCallId: payload.toolCallId }
  if (turn.status !== "waiting_for_approval" && turn.status !== "waiting_for_user") return { status: "ignored", sessionId: payload.sessionId, turnId: payload.turnId, itemId: payload.itemId, toolCallId: payload.toolCallId }
  const expected = payload.waitKind === "question" ? "waiting_for_user" : "waiting_for_approval"
  if (turn.status !== expected) fail("wait_scope_mismatch", "Agent wakeup wait kind does not match Turn status")
  if (turn.revision !== payload.nextTurnRevision) fail("turn_revision_conflict", "Agent Turn revision changed before wakeup")
  const itemResult = await client.query<{ status: string; taskId: string | null; content: unknown }>(
    `SELECT "status", "taskId", "content" FROM "agent_items" WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "type" = $4 FOR UPDATE`,
    [payload.itemId, payload.sessionId, payload.turnId, payload.waitKind === "question" ? "question" : "approval_request"])
  const item = itemResult.rows[0]
  if (!item || item.status !== "completed") return { status: "ignored", sessionId: payload.sessionId, turnId: payload.turnId, itemId: payload.itemId, toolCallId: payload.toolCallId }
  if (payload.waitKind === "approval_set") {
    const set = parseObjectiveApplicationApprovalSet(item.content)
    if (item.taskId !== null || !set || objectiveApplicationApprovalSetItemId(set.setId) !== payload.itemId
      || set.setId !== payload.waitId || set.sourceTurnId === payload.turnId) approvalSetMismatch()
    const source = await client.query(`SELECT "id" FROM "agent_turns" WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3 AND "status" = 'completed' FOR SHARE`, [set.sourceTurnId, payload.sessionId, session.userId])
    if (!source.rows[0]) approvalSetMismatch()
    await assertApprovalSetMembers(client, payload, session.userId, set)
  } else {
    const content = record(item.content) ?? {}
    const itemWaitId = payload.waitKind === "approval" ? content.approvalId : content.waitId ?? content.questionId
    if (content.waitKind !== payload.waitKind || itemWaitId !== payload.waitId) fail("item_lineage_mismatch", "Agent wait item lineage does not match wakeup")
    const itemToolCallId = typeof content.toolCallId === "string" ? content.toolCallId : null
    if (itemToolCallId !== payload.toolCallId) fail("tool_lineage_mismatch", "Agent wait tool lineage does not match wakeup")
  }
  const turnInput = record(turn.input) ?? {}
  const itemContent = record(item.content)
  const scheduledQuestion = payload.waitKind === "question" && payload.status === "answered"
    && itemContent?.answerAvailable === true && itemContent.answer !== null && itemContent.answer !== undefined
    && turn.source === "automation" && turn.executionMode === "canonical_task_graph" && turnInput.automationRunMode === "scheduled"
    && typeof turn.rootTaskId === "string" && turn.rootTaskId.length > 0 && (item.taskId === null || item.taskId === turn.rootTaskId)
  if (scheduledQuestion && turn.hasLiveLease) return { status: "deferred", sessionId: payload.sessionId, turnId: payload.turnId, itemId: payload.itemId, toolCallId: payload.toolCallId }
  if (payload.waitKind === "approval_set" && turn.hasLiveLease) return { status: "deferred", sessionId: payload.sessionId, turnId: payload.turnId, itemId: payload.itemId, toolCallId: null }
  const updated = await client.query(`UPDATE "agent_turns" AS turn SET "status" = 'queued', "leaseOwnerId" = NULL, "leaseExpiresAt" = NULL,
       "leaseStartedAt" = NULL, "revision" = "revision" + 1, "completedAt" = NULL, "updatedAt" = CURRENT_TIMESTAMP
     WHERE turn."id" = $1 AND turn."sessionId" = $2 AND turn."userId" = $3 AND turn."status" IN ('waiting_for_approval', 'waiting_for_user') AND turn."revision" = $4
       AND EXISTS (SELECT 1 FROM "agent_sessions" AS session WHERE session."id" = turn."sessionId" AND session."userId" = turn."userId" AND session."status" NOT IN ('aborted', 'archived'))`,
    [payload.turnId, payload.sessionId, session.userId, payload.nextTurnRevision])
  if (updated.rowCount !== 1) return { status: "already_resumed", sessionId: payload.sessionId, turnId: payload.turnId, itemId: payload.itemId, toolCallId: payload.toolCallId }
  if (payload.waitKind !== "approval_set") await client.query(`UPDATE "agent_executions" SET "status" = 'queued', "error" = NULL, "completedAt" = NULL WHERE "userId" = $1 AND "sessionId" = $2 AND "status" = 'waiting_for_user'`, [session.userId, payload.sessionId])
  await appendResumeEvent(client, payload, session.userId)
  if (!await persistWakeupTurnDispatchInTransaction(client, payload.turnId, payload.sessionId, payload.eventId)) fail("outbox_scope_mismatch", "Turn dispatch lineage does not match wakeup scope")
  return { status: "resumed", sessionId: payload.sessionId, turnId: payload.turnId, itemId: payload.itemId, toolCallId: payload.toolCallId }
}

export async function resumeAgentTurn(pool: PoolLike, payload: AgentTurnWakeupPayload): Promise<WakeupResult> {
  const client = await pool.connect()
  try { await client.query("BEGIN"); const result = await resumeAgentTurnInTransaction(client, payload); await client.query("COMMIT"); return result }
  catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error }
  finally { client.release() }
}
