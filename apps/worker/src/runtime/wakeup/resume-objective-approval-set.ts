import type pg from "pg"
import {
  hashApprovalScope, isApprovalHash, objectiveApplicationApprovalSetItemId,
  parseObjectiveApplicationApprovalSet,
} from "@jobcopilot/agent-protocol"
import { parseObjectiveApplicationResumeWitness } from "@jobcopilot/shared"
import { protocolScope } from "../approval/types.js"
import type { AgentTurnWakeupPayload } from "./types.js"

type Client = Pick<pg.PoolClient, "query">
type RecordValue = Record<string, unknown>
type ApprovalSet = NonNullable<ReturnType<typeof parseObjectiveApplicationApprovalSet>>
type Mismatch = (code: "approval_set_lineage_mismatch" | "event_lineage_mismatch", message: string) => never
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
const MEMBER_SCHEMA = "objective-application-approval-set-member.v1"
const COMMAND_PREFIX = "objective-approval-set-command:"

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

export async function assertObjectiveApprovalSetWakeupEvent(
  client: Client, payload: AgentTurnWakeupPayload, mismatch: Mismatch,
): Promise<void> {
  const result = await client.query<ApprovalEvent & { sessionId: string }>(
    `SELECT "sessionId", "turnId", "itemId", "taskId", "type", "actor", "correlationId", "causationId", "idempotencyKey", "payload"
     FROM "agent_events" WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "itemId" = $4 AND "type" = 'turn.wakeup' FOR SHARE`,
    [payload.eventId, payload.sessionId, payload.turnId, payload.itemId],
  )
  const event = result.rows[0], value = record(event?.payload)
  const valid = !!event && !!value && event.itemId === payload.itemId && event.type === "turn.wakeup"
    && Reflect.ownKeys(value).length === 7 && value.waitKind === payload.waitKind && value.waitId === payload.waitId
    && value.itemId === payload.itemId && value.turnId === payload.turnId && value.toolCallId === null
    && value.status === "resolved" && value.nextTurnRevision === payload.nextTurnRevision
    && event.actor === "user" && event.taskId === null && event.correlationId === payload.turnId
    && typeof event.causationId === "string" && event.causationId.length > 0
    && event.idempotencyKey === `approval-set:${payload.waitId}:wakeup`
  if (!valid) mismatch("event_lineage_mismatch", "Approval set wakeup event lineage does not match payload")
  const completed = await client.query<ApprovalEvent & { id: string }>(
    `SELECT "id", "turnId", "itemId", "taskId", "type", "actor", "correlationId", "causationId", "idempotencyKey", "payload"
     FROM "agent_events" WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "itemId" = $4 AND "type" = 'item.completed' FOR SHARE`,
    [event!.causationId, payload.sessionId, payload.turnId, payload.itemId],
  )
  const cause = completed.rows[0], body = record(cause?.payload)
  if (!cause || !body || cause.type !== "item.completed" || cause.actor !== "orchestrator" || cause.itemId !== payload.itemId
    || cause.taskId !== null || cause.correlationId !== payload.itemId || cause.causationId !== payload.itemId
    || cause.idempotencyKey !== `agent-wait:${payload.itemId}:completed` || body.itemId !== payload.itemId
    || body.status !== "completed" || Reflect.ownKeys(body).length !== 2) {
    mismatch("event_lineage_mismatch", "Approval set completion event lineage does not match wakeup")
  }
}

async function assertApprovalSetMembers(client: Client, payload: AgentTurnWakeupPayload, userId: string, set: ApprovalSet, mismatch: Mismatch): Promise<void> {
  const ids = set.members.map(member => member.approvalId)
  const approvals = await client.query<ApprovalRow>(
    `SELECT "id", "sessionId", "turnId", "userId", "taskId", "jobId", "toolCallId", "type", "status", "payload",
       "resourceHash", "materialHash", "answersHash", "scopeHash", "nonceHash", "revision", "expiresAt", "consumedAt"
     FROM "agent_approvals" WHERE "sessionId" = $1 AND "turnId" = $2 AND "userId" = $3 AND "type" = 'review_application'
       AND ("id" = ANY($4::text[]) OR "payload" ->> 'setId' = $5) ORDER BY "id" FOR UPDATE`,
    [payload.sessionId, payload.turnId, userId, ids, set.setId],
  )
  if (approvals.rows.length !== ids.length) mismatch("approval_set_lineage_mismatch", "Approval set lineage is incomplete")
  const byId = new Map(approvals.rows.map(row => [row.id, row])), jobs = new Set<string>(), calls = new Set<string>()
  for (const member of set.members) {
    const row = byId.get(member.approvalId), parsed = row && exactMemberEnvelope(row.payload)
    const witness = parsed && parseObjectiveApplicationResumeWitness(parsed.proof.resumeWitness)
    if (!row || !parsed || !witness || row.id !== member.approvalId || row.userId !== userId
      || row.sessionId !== payload.sessionId || row.turnId !== payload.turnId || row.type !== "review_application"
      || !row.jobId || !row.toolCallId || row.expiresAt?.toISOString() !== set.expiresAt
      || parsed.envelope.setId !== set.setId || parsed.envelope.sourceTurnId !== set.sourceTurnId
      || parsed.envelope.slotOrdinal !== member.slotOrdinal || witness.userId !== userId || witness.jobId !== row.jobId
      || jobs.has(row.jobId) || calls.has(row.toolCallId) || !await assertMemberScope(row, userId)) mismatch("approval_set_lineage_mismatch", "Approval set lineage is incomplete")
    if (!(row.status === "approved" || row.status === "rejected" || row.status === "expired") || row.consumedAt !== null) {
      mismatch("approval_set_lineage_mismatch", "Approval set member is not terminal")
    }
    jobs.add(row.jobId); calls.add(row.toolCallId)
  }
  const events = await client.query<ApprovalEvent>(
    `SELECT "correlationId", "type", "actor", "itemId", "turnId", "causationId", "idempotencyKey", "payload"
     FROM "agent_events" WHERE "sessionId" = $1 AND "turnId" = $2 AND "correlationId" = ANY($3::text[])
       AND "type" IN ('approval.resolved', 'approval.expired') FOR SHARE`, [payload.sessionId, payload.turnId, ids],
  )
  if (events.rows.length !== ids.length) mismatch("approval_set_lineage_mismatch", "Approval set outcome is incomplete")
  const byApproval = new Map<string, ApprovalEvent[]>()
  for (const event of events.rows) byApproval.set(event.correlationId, [...(byApproval.get(event.correlationId) ?? []), event])
  for (const member of set.members) {
    const row = byId.get(member.approvalId)!, history = byApproval.get(member.approvalId) ?? []
    if (history.length !== 1) mismatch("approval_set_lineage_mismatch", "Approval set outcome is ambiguous")
    const event = history[0]!, body = record(event.payload)
    if (!body || event.turnId !== payload.turnId || event.causationId !== payload.itemId) mismatch("approval_set_lineage_mismatch", "Approval set outcome lineage is incomplete")
    if (row.status === "expired") {
      const key = event.idempotencyKey
      if (event.type !== "approval.expired" || event.actor !== "system" || event.itemId !== null
        || body.approvalId !== row.id || body.action !== row.type || body.revision !== row.revision
        || !(key === `approval-set:${set.setId}:${row.id}:expired` || typeof key === "string" && key.startsWith(COMMAND_PREFIX) && key.length > COMMAND_PREFIX.length)
        || (key?.startsWith(COMMAND_PREFIX) ? !["approved", "rejected"].includes(String(body.requestedDecision)) || body.expectedTurnRevision !== payload.nextTurnRevision - 1
          : Object.hasOwn(body, "requestedDecision") || Object.hasOwn(body, "expectedTurnRevision"))) mismatch("approval_set_lineage_mismatch", "Approval set expiry proof is invalid")
    } else if (event.type !== "approval.resolved" || event.actor !== "user" || event.itemId !== payload.itemId
      || event.correlationId !== row.id || typeof event.idempotencyKey !== "string"
      || !event.idempotencyKey.startsWith(COMMAND_PREFIX) || event.idempotencyKey.length <= COMMAND_PREFIX.length
      || body.waitKind !== "approval" || body.waitId !== row.id || body.itemId !== payload.itemId
      || body.turnId !== payload.turnId || body.toolCallId !== row.toolCallId || body.status !== row.status
      || !Number.isSafeInteger(body.nextTurnRevision) || Number(body.nextTurnRevision) < payload.nextTurnRevision - 1
      || Number(body.nextTurnRevision) > payload.nextTurnRevision) mismatch("approval_set_lineage_mismatch", "Approval set decision proof is invalid")
  }
}

export async function assertObjectiveApprovalSetItem(
  client: Client, payload: AgentTurnWakeupPayload, userId: string, item: { taskId: string | null; content: unknown }, mismatch: Mismatch,
): Promise<void> {
  const set = parseObjectiveApplicationApprovalSet(item.content)
  if (item.taskId !== null || !set || objectiveApplicationApprovalSetItemId(set.setId) !== payload.itemId
    || set.setId !== payload.waitId || set.sourceTurnId === payload.turnId) mismatch("approval_set_lineage_mismatch", "Approval set item lineage is invalid")
  const source = await client.query(`SELECT "id" FROM "agent_turns" WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3 AND "status" = 'completed' FOR SHARE`, [set.sourceTurnId, payload.sessionId, userId])
  if (!source.rows[0]) mismatch("approval_set_lineage_mismatch", "Approval set source Turn is unavailable")
  await assertApprovalSetMembers(client, payload, userId, set, mismatch)
}
