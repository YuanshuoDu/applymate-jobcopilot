import { randomUUID } from "node:crypto"
import type pg from "pg"
import { canonicalJson } from "@jobcopilot/shared"
import {
  OBJECTIVE_APPLICATION_APPROVAL_SET_SCHEMA,
  hashApprovalScope,
  isApprovalHash,
  objectiveApplicationApprovalSetItemId,
  parseObjectiveApplicationApprovalSet,
  type ObjectiveApplicationApprovalSet,
} from "@jobcopilot/agent-protocol"
import { createPgApprovalStore } from "./pg-store.js"
import { ApprovalStoreError, assertScopeInput, protocolScope, type ApprovalReceiptResult, type IssueApprovalReceiptInput } from "./types.js"

type Client = pg.PoolClient
type Row = Record<string, unknown>
type PreparedReceipt = Omit<IssueApprovalReceiptInput, "nonce" | "projectWait" | "approvalId"> & Readonly<{ approvalId: string }>
export type ObjectiveApplicationApprovalSetIssueInput = Readonly<{
  setId: string
  sourceTurnId: string
  intentHash: string
  expiresAt: Date
  members: readonly Readonly<{ slotOrdinal: number; receipt: PreparedReceipt }>[]
  now?: Date
}>
export type ObjectiveApplicationApprovalSetIssueResult = Readonly<{
  disposition: "created" | "duplicate"
  itemId: string
  approvalSet: ObjectiveApplicationApprovalSet
}>
type ApprovalIssuer = Readonly<{
  issueInTransaction(client: Client, input: IssueApprovalReceiptInput): Promise<ApprovalReceiptResult>
}>
const MEMBER_PAYLOAD_SCHEMA = "objective-application-approval-set-member.v1"

const OPEN_SESSION = `session."status" NOT IN ('aborted', 'archived')`
const WAITABLE_TURN_STATUSES = ["queued", "in_progress", "waiting_for_dependency", "waiting_for_user"]
const ITEM_EVENT_SUFFIX = ":started"

function conflict(): ApprovalStoreError { return new ApprovalStoreError("approval_reservation_conflict", "Approval set conflicts with existing durable state") }
function invalidScope(): ApprovalStoreError { return new ApprovalStoreError("approval_scope_mismatch", "Approval set scope is invalid") }
function uniqueViolation(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "23505"
}
function dataRecord(value: unknown): Row | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return null
  const descriptors = Object.getOwnPropertyDescriptors(value)
  return Reflect.ownKeys(descriptors).every(key => typeof key === "string"
    && descriptors[key]?.enumerable === true && "value" in descriptors[key]!) ? value as Row : null
}
function sameScope(row: Row, scope: PreparedReceipt["scope"], userId: string): boolean {
  return row.userId === userId && row.sessionId === scope.sessionId && row.turnId === scope.turnId
    && row.jobId === scope.jobId && row.toolCallId === scope.toolCallId && row.type === "review_application"
    && row.revision === scope.revision && row.expiresAt instanceof Date && row.expiresAt.getTime() === scope.expiresAt.getTime()
    && row.resourceHash === scope.resourceHash && row.materialHash === scope.materialHash && row.answersHash === scope.answersHash
}
function preparedMembers(input: ObjectiveApplicationApprovalSetIssueInput, userId: string) {
  if (!Array.isArray(input.members) || input.members.length < 1 || input.members.length > 8) throw invalidScope()
  const members: Array<{ slotOrdinal: number; receipt: PreparedReceipt }> = []
  for (let index = 0; index < input.members.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(input.members, String(index))
    const member = descriptor && "value" in descriptor ? dataRecord(descriptor.value) : null
    const receipt = dataRecord(member?.receipt)
    if (!member || Reflect.ownKeys(member).length !== 2 || !("slotOrdinal" in member) || !("receipt" in member)
      || !receipt || !Number.isSafeInteger(member.slotOrdinal) || (member.slotOrdinal as number) < 1 || (member.slotOrdinal as number) > 8
      || !["approvalId", "taskId", "scope", "title", "body", "impact", "payload"].every(key => Object.hasOwn(receipt, key) || ["taskId", "impact"].includes(key))
      || Reflect.ownKeys(receipt).some(key => typeof key !== "string" || !["approvalId", "taskId", "scope", "title", "body", "impact", "payload"].includes(key))) throw invalidScope()
    const scope = dataRecord(receipt.scope)
    const requiredScopeKeys = ["userId", "sessionId", "turnId", "jobId", "toolCallId", "action", "resourceHash", "materialHash", "answersHash", "revision", "expiresAt"]
    if (!scope || Reflect.ownKeys(scope).length !== requiredScopeKeys.length || requiredScopeKeys.some(key => !Object.hasOwn(scope, key))) throw invalidScope()
    const candidate = receipt as unknown as PreparedReceipt
    let jsonSafe = true
    try { canonicalJson(candidate.payload); canonicalJson(candidate.impact ?? null) } catch { jsonSafe = false }
    if (typeof candidate.approvalId !== "string" || !candidate.approvalId.trim() || typeof candidate.title !== "string"
      || typeof candidate.body !== "string" || candidate.scope.userId !== userId
      || candidate.taskId !== undefined && candidate.taskId !== null && (typeof candidate.taskId !== "string" || !candidate.taskId.trim())
      || candidate.scope.action !== "review_application" || !candidate.scope.sessionId || !candidate.scope.turnId
      || !candidate.scope.jobId || !candidate.scope.toolCallId || !(candidate.scope.expiresAt instanceof Date)
      || ![candidate.scope.userId, candidate.scope.sessionId, candidate.scope.turnId, candidate.scope.jobId, candidate.scope.toolCallId,
        candidate.scope.resourceHash, candidate.scope.materialHash, candidate.scope.answersHash].every(value => typeof value === "string")
      || !Number.isSafeInteger(candidate.scope.revision) || candidate.scope.revision < 0 || !jsonSafe
      || candidate.scope.expiresAt.getTime() !== input.expiresAt.getTime()) throw invalidScope()
    members.push({ slotOrdinal: member.slotOrdinal as number, receipt: candidate })
  }
  members.sort((left, right) => left.slotOrdinal - right.slotOrdinal)
  const slots = new Set<number>(), approvals = new Set<string>(), jobs = new Set<string>(), calls = new Set<string>()
  const first = members[0]!.receipt.scope
  if (typeof input.sourceTurnId !== "string" || !input.sourceTurnId.trim() || input.sourceTurnId === first.turnId) throw invalidScope()
  for (const member of members) {
    const scope = member.receipt.scope
    if (slots.has(member.slotOrdinal) || approvals.has(member.receipt.approvalId) || jobs.has(scope.jobId) || calls.has(scope.toolCallId)
      || scope.sessionId !== first.sessionId || scope.turnId !== first.turnId || scope.revision !== first.revision
      || member.receipt.title.length === 0 || member.receipt.body.length === 0) throw invalidScope()
    slots.add(member.slotOrdinal); approvals.add(member.receipt.approvalId); jobs.add(scope.jobId); calls.add(scope.toolCallId)
  }
  return members
}
function setContent(input: ObjectiveApplicationApprovalSetIssueInput, members: readonly { slotOrdinal: number; receipt: PreparedReceipt }[]): ObjectiveApplicationApprovalSet {
  const content = parseObjectiveApplicationApprovalSet({
    schema: OBJECTIVE_APPLICATION_APPROVAL_SET_SCHEMA, waitKind: "approval_set", setId: input.setId,
    sourceTurnId: input.sourceTurnId, intentHash: input.intentHash, expiresAt: input.expiresAt.toISOString(),
    members: members.map(member => ({ slotOrdinal: member.slotOrdinal, approvalId: member.receipt.approvalId })),
  })
  if (!content) throw invalidScope()
  return content
}
function sameContent(left: unknown, right: ObjectiveApplicationApprovalSet): boolean {
  const parsed = parseObjectiveApplicationApprovalSet(left)
  return !!parsed && canonicalJson(parsed) === canonicalJson(right)
}
function memberPayload(input: ObjectiveApplicationApprovalSetIssueInput, member: { slotOrdinal: number; receipt: PreparedReceipt }): unknown {
  return { schema: MEMBER_PAYLOAD_SCHEMA, setId: input.setId, sourceTurnId: input.sourceTurnId,
    slotOrdinal: member.slotOrdinal, proof: member.receipt.payload }
}
function issueInput(input: ObjectiveApplicationApprovalSetIssueInput, member: { slotOrdinal: number; receipt: PreparedReceipt }): IssueApprovalReceiptInput {
  const receipt = member.receipt
  return {
    approvalId: receipt.approvalId, ...(receipt.taskId === undefined ? {} : { taskId: receipt.taskId }),
    scope: receipt.scope, title: receipt.title, body: receipt.body, impact: receipt.impact,
    payload: memberPayload(input, member), projectWait: false,
  }
}
async function verifyReplayMembers(client: Client, userId: string, input: ObjectiveApplicationApprovalSetIssueInput, members: readonly { slotOrdinal: number; receipt: PreparedReceipt }[]): Promise<void> {
  const ids = members.map(member => member.receipt.approvalId)
  const found = await client.query<Row>(`SELECT "id", "sessionId", "taskId", "userId", "turnId", "toolCallId", "jobId", "type", "status", "title", "body", "impact", "payload", "resourceHash", "materialHash", "answersHash", "scopeHash", "nonceHash", "revision", "expiresAt"
    FROM "agent_approvals" WHERE "id" = ANY($1::text[]) ORDER BY "id" FOR UPDATE`, [ids])
  if (found.rows.length !== members.length) throw conflict()
  const byId = new Map(found.rows.map(row => [row.id, row]))
  for (const member of members) {
    const receipt = member.receipt, row = byId.get(receipt.approvalId)
    if (!row || !sameScope(row, receipt.scope, userId) || row.taskId !== (receipt.taskId ?? null)
      || row.title !== receipt.title || row.body !== receipt.body || !isApprovalHash(row.scopeHash) || !isApprovalHash(row.nonceHash)
      || canonicalJson(row.payload) !== canonicalJson(memberPayload(input, member))
      || canonicalJson(row.impact ?? null) !== canonicalJson(receipt.impact ?? null)) throw conflict()
    const storedScope = protocolScope(receipt.scope, row.nonceHash)
    if (row.scopeHash !== await hashApprovalScope(storedScope)) throw conflict()
  }
}
async function appendSetItemEvent(client: Client, userId: string, sessionId: string, turnId: string, itemId: string, set: ObjectiveApplicationApprovalSet): Promise<void> {
  const next = await client.query<{ eventSequence: string | bigint | number }>(`UPDATE "agent_sessions" SET "eventSequence" = "eventSequence" + 1
    WHERE "id" = $1 AND "userId" = $2 RETURNING "eventSequence"`, [sessionId, userId])
  if (next.rows[0]?.eventSequence === undefined) throw invalidScope()
  const eventId = randomUUID(), sequence = String(next.rows[0].eventSequence)
  const idempotencyKey = `agent-wait:${itemId}${ITEM_EVENT_SUFFIX}`
  const payload = { itemId, waitKind: "approval_set", setId: set.setId, memberCount: set.members.length }
  const outboxPayload = { eventId, sessionId, turnId, itemId, taskId: null, sequence, type: "item.started", actor: "orchestrator",
    correlationId: itemId, causationId: null, idempotencyKey, payload }
  await client.query(`INSERT INTO "agent_events" ("id", "sessionId", "turnId", "itemId", "taskId", "sequence", "type", "actor", "correlationId", "causationId", "idempotencyKey", "payload")
    VALUES ($1, $2, $3, $4, NULL, $5, 'item.started', 'orchestrator', $4, NULL, $6, $7::jsonb)`,
  [eventId, sessionId, turnId, itemId, sequence, idempotencyKey, JSON.stringify(payload)])
  const outbox = await client.query(`INSERT INTO "agent_outbox" ("id", "topic", "aggregateId", "idempotencyKey", "payload")
    VALUES ($1, 'agent.session.event', $2, $3, $4::jsonb)`, [`agent-outbox-${eventId}`, sessionId, `agent-event:${eventId}`, JSON.stringify(outboxPayload)])
  if (outbox.rowCount !== 1) throw conflict()
}
async function withSavepoint<T>(client: Client, work: () => Promise<T>): Promise<T> {
  const name = `objective_approval_set_${randomUUID().replaceAll("-", "")}`
  await client.query(`SAVEPOINT ${name}`)
  try { const result = await work(); await client.query(`RELEASE SAVEPOINT ${name}`); return result }
  catch (error: unknown) {
    try { await client.query(`ROLLBACK TO SAVEPOINT ${name}`) } catch { /* Preserve the original failure. */ }
    try { await client.query(`RELEASE SAVEPOINT ${name}`) } catch { /* Preserve the original failure. */ }
    if (uniqueViolation(error)) throw conflict()
    throw error
  }
}

async function issueSet(client: Client, issuer: ApprovalIssuer, userId: string, input: ObjectiveApplicationApprovalSetIssueInput): Promise<ObjectiveApplicationApprovalSetIssueResult> {
  const now = input.now ?? new Date()
  if (!(input.expiresAt instanceof Date) || Number.isNaN(input.expiresAt.getTime())
    || !(now instanceof Date) || Number.isNaN(now.getTime())) throw invalidScope()
  const members = preparedMembers(input, userId), content = setContent(input, members)
  const firstScope = members[0]!.receipt.scope, itemId = objectiveApplicationApprovalSetItemId(input.setId)
  return withSavepoint(client, async () => {
    const session = await client.query<Row>(`SELECT "id" FROM "agent_sessions" AS session WHERE session."id" = $1 AND session."userId" = $2 AND ${OPEN_SESSION} FOR UPDATE`, [firstScope.sessionId, userId])
    if (!session.rows[0]) throw new ApprovalStoreError("approval_scope_mismatch", "Approval session is not owned by the Worker tenant")
    const turnResult = await client.query<Row>(`SELECT "id", "status", "revision" FROM "agent_turns"
      WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3 FOR UPDATE`, [firstScope.turnId, firstScope.sessionId, userId])
    const turn = turnResult.rows[0]
    if (!turn) throw new ApprovalStoreError("approval_scope_mismatch", "Approval Turn is not owned by the Worker tenant")
    const sourceTurn = await client.query<Row>(`SELECT "id" FROM "agent_turns"
      WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3 AND "status" = 'completed'`, [input.sourceTurnId, firstScope.sessionId, userId])
    if (!sourceTurn.rows[0]) throw new ApprovalStoreError("approval_scope_mismatch", "Approval source Turn is not completed in the owned Session")
    const existing = await client.query<Row>(`SELECT "id", "sessionId", "turnId", "type", "status", "revision", "content"
      FROM "agent_items" WHERE "id" = $1 FOR UPDATE`, [itemId])
    if (existing.rows[0]) {
      const item = existing.rows[0]
      if (item.sessionId !== firstScope.sessionId || item.turnId !== firstScope.turnId || item.type !== "approval_request"
        || !sameContent(item.content, content)) throw conflict()
      await verifyReplayMembers(client, userId, input, members)
      return { disposition: "duplicate", itemId, approvalSet: content }
    }
    if (input.expiresAt <= now) throw new ApprovalStoreError("approval_expired", "Approval set expiry must be in the future")
    if (!WAITABLE_TURN_STATUSES.includes(String(turn.status)) || turn.revision !== firstScope.revision) {
      throw new ApprovalStoreError("approval_revision_mismatch", "Approval Turn revision is stale")
    }
    for (const member of members) assertScopeInput(member.receipt.scope)
    for (const member of members) {
      const result = await issuer.issueInTransaction(client, issueInput(input, member))
      if (result.approval.id !== member.receipt.approvalId || result.approval.type !== "review_application") throw conflict()
    }
    const inserted = await client.query(`INSERT INTO "agent_items" ("id", "sessionId", "turnId", "type", "status", "phase", "revision", "content", "startedAt", "updatedAt")
      VALUES ($1, $2, $3, 'approval_request', 'started', 'commentary', 0, $4::jsonb, $5, $5)`,
    [itemId, firstScope.sessionId, firstScope.turnId, JSON.stringify(content), now])
    if (inserted.rowCount !== 1) throw conflict()
    const changed = await client.query(`UPDATE "agent_turns" SET "status" = 'waiting_for_approval', "revision" = "revision" + 1,
      "completedAt" = NULL, "updatedAt" = $4 WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3 AND "revision" = $5 AND "status" = $6`,
    [firstScope.turnId, firstScope.sessionId, userId, now, firstScope.revision, turn.status])
    if (changed.rowCount !== 1) throw new ApprovalStoreError("approval_revision_mismatch", "Approval Turn changed while creating the set wait")
    await appendSetItemEvent(client, userId, firstScope.sessionId, firstScope.turnId, itemId, content)
    return { disposition: "created", itemId, approvalSet: content }
  })
}

export function createPgObjectiveApplicationApprovalSetStore(pool: pg.Pool, scope: Readonly<{ userId: string }>) {
  const approvals = createPgApprovalStore(pool, scope)
  return {
    async issue(input: ObjectiveApplicationApprovalSetIssueInput): Promise<ObjectiveApplicationApprovalSetIssueResult> {
      const client = await pool.connect()
      try {
        await client.query("BEGIN")
        await client.query("SELECT set_config($1, $2, true)", ["app.user_id", scope.userId])
        const result = await issueSet(client, approvals, scope.userId, input)
        await client.query("COMMIT")
        return result
      } catch (error: unknown) {
        try { await client.query("ROLLBACK") } catch { /* Preserve the original failure. */ }
        throw error
      } finally { client.release() }
    },
    issueInTransaction(client: Client, input: ObjectiveApplicationApprovalSetIssueInput) {
      return issueSet(client, approvals, scope.userId, input)
    },
  }
}
