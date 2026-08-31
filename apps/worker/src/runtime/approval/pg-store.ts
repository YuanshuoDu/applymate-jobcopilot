import { randomUUID } from "node:crypto"
import type pg from "pg"
import {
  createApprovalNonce,
  hashApprovalNonce,
  hashApprovalScope,
  schemaVersion,
  type AgentApproval,
  type ApprovalScope,
  type ApprovalType,
} from "@jobcopilot/agent-protocol"

import {
  ApprovalStoreError,
  assertScopeInput,
  protocolScope,
  type ApprovalConsumeResult,
  type ApprovalDecision,
  type ApprovalReceiptResult,
  type ApprovalReservationInput,
  type ApprovalScopeMatch,
  type IssueApprovalReceiptInput,
} from "./types.js"

type Client = pg.PoolClient
type RowValue = Date | string | null
interface ApprovalRow {
  id: string; sessionId: string; taskId: string | null; userId: string; turnId: string | null; toolCallId: string | null; jobId: string | null
  type: string; status: string; title: string; body: string; payload: unknown; resourceHash: string | null; materialHash: string | null
  answersHash: string | null; scopeHash: string | null; nonceHash: string | null; revision: number; expiresAt: RowValue; decidedAt: RowValue; consumedAt: RowValue; createdAt: RowValue
}

const SELECT_APPROVAL = `SELECT "id", "sessionId", "taskId", "userId", "turnId", "toolCallId", "jobId", "type", "status", "title", "body", "payload", "resourceHash", "materialHash", "answersHash", "scopeHash", "nonceHash", "revision", "expiresAt", "decidedAt", "consumedAt", "createdAt" FROM "agent_approvals"`

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "23505"
}

function date(value: RowValue): Date | null {
  if (!value) return null
  const parsed = value instanceof Date ? value : new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

function auditPayload(approvalId: string, action: string, scopeHash: string, revision: number): Record<string, unknown> {
  return { approvalId, action, scopeHash, revision }
}

function scopeFromRow(row: ApprovalRow): ApprovalScope {
  const expiresAt = date(row.expiresAt)
  if (!row.turnId || !row.toolCallId || !row.jobId || !row.resourceHash || !row.materialHash || !row.answersHash || !row.scopeHash || !row.nonceHash || !expiresAt) {
    throw new ApprovalStoreError("approval_integrity_error", "Approval receipt is missing its immutable scope")
  }
  return protocolScope({
    userId: row.userId, sessionId: row.sessionId, turnId: row.turnId, jobId: row.jobId, toolCallId: row.toolCallId,
    action: row.type as ApprovalType, resourceHash: row.resourceHash, materialHash: row.materialHash, answersHash: row.answersHash,
    revision: row.revision, expiresAt,
  }, row.nonceHash)
}

function mapApproval(row: ApprovalRow): AgentApproval {
  const scope = scopeFromRow(row)
  return {
    schemaVersion, id: row.id, type: row.type as ApprovalType, status: row.status as AgentApproval["status"], title: row.title, body: row.body,
    scope, scopeHash: row.scopeHash as string, payload: row.payload,
    decidedAt: date(row.decidedAt)?.toISOString() ?? null, consumedAt: date(row.consumedAt)?.toISOString() ?? null,
    createdAt: date(row.createdAt)?.toISOString() ?? new Date(0).toISOString(),
  }
}

async function load(client: Client, id: string, userId: string, forUpdate = false): Promise<ApprovalRow> {
  const result = await client.query<ApprovalRow>(`${SELECT_APPROVAL} WHERE "id" = $1 AND "userId" = $2${forUpdate ? " FOR UPDATE" : ""}`, [id, userId])
  const row = result.rows[0]
  if (!row) throw new ApprovalStoreError("approval_not_found", "Approval receipt was not found")
  return row
}

async function assertScope(row: ApprovalRow, expected: ApprovalScopeMatch, now: Date): Promise<ApprovalScope> {
  if (row.status === "consumed") throw new ApprovalStoreError("approval_already_consumed", "Approval receipt has already been consumed")
  if (row.status !== "approved") throw new ApprovalStoreError("approval_not_approved", "Approval receipt is not approved")
  const expiry = date(row.expiresAt)
  if (expiry && expiry <= now) throw new ApprovalStoreError("approval_expired", "Approval receipt has expired")
  const actual = scopeFromRow(row)
  if (row.scopeHash !== await hashApprovalScope(actual)) throw new ApprovalStoreError("approval_integrity_error", "Approval receipt scope integrity check failed")
  const nonceHash = await hashApprovalNonce(expected.nonce)
  if (row.nonceHash !== nonceHash) throw new ApprovalStoreError("approval_nonce_mismatch", "Approval receipt nonce does not match")
  if (row.scopeHash !== await hashApprovalScope(protocolScope(expected, nonceHash))) {
    if (row.revision !== expected.revision) throw new ApprovalStoreError("approval_revision_mismatch", "Approval receipt revision is stale")
    throw new ApprovalStoreError("approval_scope_mismatch", "Approval receipt scope does not match the requested action")
  }
  return actual
}

async function appendAudit(client: Client, input: { sessionId: string; turnId: string; itemId?: string | null; taskId: string | null; type: string; actor: "user" | "orchestrator" | "system"; approvalId: string; payload: Record<string, unknown>; key: string }): Promise<void> {
  const session = await client.query<{ id: string }>(`SELECT "id" FROM "agent_sessions" WHERE "id" = $1 FOR UPDATE`, [input.sessionId])
  if (!session.rows[0]) throw new ApprovalStoreError("approval_scope_mismatch", "Approval session does not exist")
  const sequence = await client.query<{ eventSequence: bigint | string }>(`UPDATE "agent_sessions" SET "eventSequence" = "eventSequence" + 1 WHERE "id" = $1 RETURNING "eventSequence"`, [input.sessionId])
  const next = sequence.rows[0]?.eventSequence
  if (next === undefined) throw new ApprovalStoreError("approval_scope_mismatch", "Approval session sequence is unavailable")
  const eventId = randomUUID()
  const eventSequence = BigInt(next)
  await client.query(`INSERT INTO "agent_events" ("id", "sessionId", "turnId", "itemId", "taskId", "sequence", "type", "actor", "correlationId", "causationId", "idempotencyKey", "payload") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NULL, $10, $11::jsonb)`, [eventId, input.sessionId, input.turnId, input.itemId ?? null, input.taskId, eventSequence.toString(), input.type, input.actor, input.approvalId, input.key, JSON.stringify(input.payload)])
  await client.query(`INSERT INTO "agent_outbox" ("id", "topic", "aggregateId", "idempotencyKey", "payload") VALUES ($1, 'agent.session.event', $2, $3, $4::jsonb)`, [`agent-outbox-${eventId}`, input.sessionId, `agent-event:${eventId}`, JSON.stringify({ eventId, sessionId: input.sessionId, turnId: input.turnId, itemId: input.itemId ?? null, taskId: input.taskId, sequence: eventSequence.toString(), type: input.type, actor: input.actor, correlationId: input.approvalId, causationId: null, idempotencyKey: input.key, payload: input.payload })])
}

async function projectApprovalWait(client: Client, input: IssueApprovalReceiptInput, approvalId: string, scopeHash: string): Promise<string> {
  const session = await client.query<{ id: string }>(`SELECT "id" FROM "agent_sessions" WHERE "id" = $1 AND "userId" = $2 FOR UPDATE`, [input.scope.sessionId, input.scope.userId])
  if (!session.rows[0]) throw new ApprovalStoreError("approval_scope_mismatch", "Approval session is not owned by the Worker tenant")
  const turnResult = await client.query<{ id: string; status: string; revision: number }>(
    `SELECT "id", "status", "revision" FROM "agent_turns" WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3 FOR UPDATE`,
    [input.scope.turnId, input.scope.sessionId, input.scope.userId],
  )
  const turn = turnResult.rows[0]
  if (!turn || !["queued", "in_progress", "waiting_for_dependency"].includes(turn.status) || turn.revision !== input.scope.revision) {
    throw new ApprovalStoreError("approval_revision_mismatch", "Approval Turn revision is stale")
  }
  const itemId = `agent-wait:approval:${approvalId}`
  await client.query(
    `INSERT INTO "agent_items" ("id", "sessionId", "turnId", "type", "status", "phase", "revision", "content", "startedAt", "updatedAt") VALUES ($1, $2, $3, 'approval_request', 'started', 'commentary', 0, $4::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [itemId, input.scope.sessionId, input.scope.turnId, JSON.stringify({ waitKind: "approval", approvalId, toolCallId: input.scope.toolCallId, action: input.scope.action, title: input.title, body: input.body, impact: input.impact ?? null, scopeHash, receiptRevision: input.scope.revision, expiresAt: input.scope.expiresAt.toISOString(), decision: null })],
  )
  const updated = await client.query(`UPDATE "agent_turns" SET "status" = 'waiting_for_approval', "revision" = "revision" + 1, "completedAt" = NULL, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = $1 AND "sessionId" = $2 AND "revision" = $3`, [input.scope.turnId, input.scope.sessionId, input.scope.revision])
  if (updated.rowCount !== 1) throw new ApprovalStoreError("approval_revision_mismatch", "Approval Turn changed while creating the wait")
  await appendAudit(client, { sessionId: input.scope.sessionId, turnId: input.scope.turnId, itemId, taskId: input.taskId ?? null, type: "item.started", actor: "orchestrator", approvalId: itemId, payload: { itemId, waitKind: "approval", approvalId, toolCallId: input.scope.toolCallId }, key: `agent-wait:${itemId}:started` })
  return itemId
}

async function withTransaction<T>(pool: pg.Pool, userId: string, work: (client: Client) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    await client.query("SELECT set_config($1, $2, true)", ["app.user_id", userId])
    const result = await work(client)
    await client.query("COMMIT")
    return result
  } catch (error: unknown) {
    await client.query("ROLLBACK")
    throw error
  } finally {
    client.release()
  }
}

export function createPgApprovalStore(pool: pg.Pool, scope: { userId: string }) {
  const ensureTenant = (userId: string) => { if (userId !== scope.userId) throw new ApprovalStoreError("approval_scope_mismatch", "Approval user scope does not match the Worker tenant") }

  return {
    async issue(input: IssueApprovalReceiptInput): Promise<ApprovalReceiptResult> {
      ensureTenant(input.scope.userId)
      assertScopeInput(input.scope)
      const nonce = input.nonce ?? createApprovalNonce()
      const nonceHash = await hashApprovalNonce(nonce)
      const approvalScope = protocolScope(input.scope, nonceHash)
      const scopeHash = await hashApprovalScope(approvalScope)
      const id = input.approvalId ?? randomUUID()
      try {
        const row = await withTransaction(pool, scope.userId, async (client) => {
          const session = await client.query(`SELECT "id" FROM "agent_sessions" WHERE "id" = $1 AND "userId" = $2`, [input.scope.sessionId, scope.userId])
          if (!session.rows[0]) throw new ApprovalStoreError("approval_scope_mismatch", "Approval session is not owned by the Worker tenant")
          const turn = await client.query(`SELECT "id" FROM "agent_turns" WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3`, [input.scope.turnId, input.scope.sessionId, scope.userId])
          if (!turn.rows[0]) throw new ApprovalStoreError("approval_scope_mismatch", "Approval turn is not owned by the session")
          const job = await client.query(`SELECT "id" FROM "Job" WHERE "id" = $1 AND "userId" = $2`, [input.scope.jobId, scope.userId])
          if (!job.rows[0]) throw new ApprovalStoreError("approval_scope_mismatch", "Approval job is not owned by the Worker tenant")
          const result = await client.query<ApprovalRow>(`INSERT INTO "agent_approvals" ("id", "sessionId", "taskId", "userId", "turnId", "toolCallId", "jobId", "type", "status", "title", "body", "impact", "payload", "resourceHash", "materialHash", "answersHash", "scopeHash", "nonceHash", "revision", "expiresAt") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', $9, $10, $11::jsonb, $12::jsonb, $13, $14, $15, $16, $17, $18, $19) RETURNING *`, [id, input.scope.sessionId, input.taskId ?? null, scope.userId, input.scope.turnId, input.scope.toolCallId, input.scope.jobId, input.scope.action, input.title, input.body, JSON.stringify(input.impact ?? null), JSON.stringify(input.payload), input.scope.resourceHash, input.scope.materialHash, input.scope.answersHash, scopeHash, nonceHash, input.scope.revision, input.scope.expiresAt])
          await projectApprovalWait(client, input, id, scopeHash)
          await appendAudit(client, { sessionId: input.scope.sessionId, turnId: input.scope.turnId, taskId: input.taskId ?? null, type: "approval.requested", actor: "orchestrator", approvalId: id, payload: auditPayload(id, input.scope.action, scopeHash, input.scope.revision), key: `approval:${id}:requested` })
          return result.rows[0]
        })
        return { approval: mapApproval(row), nonce }
      } catch (error: unknown) {
        if (isUniqueViolation(error)) throw new ApprovalStoreError("approval_reservation_conflict", "Approval nonce or id is already in use")
        throw error
      }
    },

    async validate(id: string, expected: ApprovalScopeMatch, now = new Date()): Promise<AgentApproval> {
      ensureTenant(expected.userId)
      assertScopeInput(expected)
      return withTransaction(pool, scope.userId, async (client) => mapApproval(await load(client, id, scope.userId).then(async (row) => { await assertScope(row, expected, now); return row })))
    },

    async resolve(input: { id: string; sessionId: string; decision: ApprovalDecision; now?: Date }): Promise<void> {
      ensureTenant(scope.userId)
      const now = input.now ?? new Date()
      await withTransaction(pool, scope.userId, async (client) => {
        const row = await load(client, input.id, scope.userId, true)
        if (row.sessionId !== input.sessionId) throw new ApprovalStoreError("approval_scope_mismatch", "Approval session does not match")
        if (!row.turnId || row.status !== "pending") throw new ApprovalStoreError(row.status === "consumed" ? "approval_already_consumed" : "approval_not_approved", "Approval receipt is no longer pending")
        const expiry = date(row.expiresAt)
        if (!expiry || expiry <= now) throw new ApprovalStoreError("approval_expired", "Approval receipt has expired")
        const result = await client.query(`UPDATE "agent_approvals" SET "status" = $1, "decidedAt" = $2 WHERE "id" = $3 AND "userId" = $4 AND "sessionId" = $5 AND "status" = 'pending'`, [input.decision, now, input.id, scope.userId, input.sessionId])
        if (result.rowCount !== 1) throw new ApprovalStoreError("approval_not_approved", "Approval receipt resolution raced with another decision")
        await appendAudit(client, { sessionId: row.sessionId, turnId: row.turnId, taskId: row.taskId, type: "approval.resolved", actor: "user", approvalId: row.id, payload: auditPayload(row.id, row.type, row.scopeHash ?? "legacy", row.revision), key: `approval:${row.id}:resolved:${input.decision}` })
      })
    },

    async consume(id: string, expected: ApprovalScopeMatch, now = new Date()): Promise<ApprovalConsumeResult> {
      return this.consumeAndReserve(id, expected, null, now)
    },

    async consumeAndReserve(id: string, expected: ApprovalScopeMatch, reservation: ApprovalReservationInput | null, now = new Date()): Promise<ApprovalConsumeResult> {
      ensureTenant(expected.userId)
      assertScopeInput(expected)
      try {
        return await withTransaction(pool, scope.userId, async (client) => {
          const row = await load(client, id, scope.userId, true)
          const approvalScope = await assertScope(row, expected, now)
          const consumed = await client.query(`UPDATE "agent_approvals" SET "status" = 'consumed', "consumedAt" = $1 WHERE "id" = $2 AND "userId" = $3 AND "status" = 'approved' AND "revision" = $4 AND "scopeHash" = $5 AND "nonceHash" = $6 AND "expiresAt" > $1`, [now, id, scope.userId, expected.revision, row.scopeHash, row.nonceHash])
          if (consumed.rowCount !== 1) throw new ApprovalStoreError("approval_already_consumed", "Approval receipt was consumed by another request")
          let reservationId: string | null = null
          if (reservation) {
            reservationId = randomUUID()
            await client.query(`INSERT INTO "agent_action_reservations" ("id", "approvalId", "userId", "sessionId", "turnId", "jobId", "toolCallId", "action", "resourceHash", "idempotencyKey", "status") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'reserved')`, [reservationId, id, scope.userId, approvalScope.sessionId, approvalScope.turnId, approvalScope.jobId, approvalScope.toolCallId, approvalScope.action, approvalScope.resourceHash, reservation.idempotencyKey])
          }
          await appendAudit(client, { sessionId: approvalScope.sessionId, turnId: approvalScope.turnId, taskId: row.taskId, type: "approval.consumed", actor: "system", approvalId: id, payload: auditPayload(id, approvalScope.action, row.scopeHash as string, approvalScope.revision), key: `approval:${id}:consumed` })
          if (reservation && reservationId) await appendAudit(client, { sessionId: approvalScope.sessionId, turnId: approvalScope.turnId, taskId: row.taskId, type: "external_action.reserved", actor: "system", approvalId: id, payload: { approvalId: id, reservationId, action: approvalScope.action, resourceHash: approvalScope.resourceHash }, key: `reservation:${reservation.idempotencyKey}:reserved` })
          return { approvalId: id, reservationId, consumedAt: now }
        })
      } catch (error: unknown) {
        if (isUniqueViolation(error)) throw new ApprovalStoreError("approval_reservation_conflict", "External action reservation already exists")
        throw error
      }
    },
  }
}
