import { randomUUID } from "node:crypto"
import type pg from "pg"

import { createPgApprovalStore } from "../approval/pg-store.js"
import type { ApprovalScopeMatch } from "../approval/types.js"
import type { GmailApprovalPort, GmailEvidencePort, GmailSendEvidence } from "./gmail-types.js"
import type { GmailOAuthWaitPort } from "./gmail-types.js"
import type { ToolExecutionContext } from "./types.js"
import { createGmailClient, createPgGmailCredentialPort } from "./gmail-client.js"
import type { GmailToolOptions } from "./gmail-types.js"

type PoolLike = Pick<pg.Pool, "query" | "connect">
type Client = pg.PoolClient

export function createPostgresGmailToolOptions(pool: PoolLike): GmailToolOptions {
  return {
    credentials: createPgGmailCredentialPort(pool),
    client: createGmailClient(),
    approvals: (userId) => createPgGmailApprovalPort(pool, userId),
    evidence: createPgGmailEvidencePort(pool),
    oauth: createPgGmailOAuthWaitPort(pool),
  }
}

export function createPgGmailApprovalPort(pool: PoolLike, userId: string): GmailApprovalPort {
  const approvals = createPgApprovalStore(pool as pg.Pool, { userId })
  return {
    consumeAndReserve: (approvalId: string, expected: ApprovalScopeMatch, idempotencyKey: string) => approvals.consumeAndReserve(approvalId, expected, { idempotencyKey }),
  }
}

export function createPgGmailEvidencePort(pool: PoolLike): GmailEvidencePort {
  return {
    async findSendEvidence(userId, idempotencyKey) {
      const result = await pool.query<{ payload: Record<string, unknown> }>(`SELECT event."payload" FROM "agent_events" AS event JOIN "agent_sessions" AS session ON session."id" = event."sessionId" WHERE session."userId" = $1 AND event."type" = 'gmail.sent' AND event."idempotencyKey" = $2 LIMIT 1`, [userId, `gmail-send:${idempotencyKey}:evidence`])
      return mapEvidence(result.rows[0]?.payload)
    },
    async hasSendReservation(userId, idempotencyKey) {
      const result = await pool.query(`SELECT 1 FROM "agent_action_reservations" WHERE "userId" = $1 AND "idempotencyKey" = $2 LIMIT 1`, [userId, idempotencyKey])
      return Boolean(result.rows[0])
    },
    async persistSendEvidence(input) {
      const client = await pool.connect()
      try {
        await client.query("BEGIN")
        await client.query("SELECT set_config($1, $2, true)", ["app.user_id", input.userId])
        const reservation = await client.query<{ status: string }>(`SELECT "status" FROM "agent_action_reservations" WHERE "userId" = $1 AND "idempotencyKey" = $2 FOR UPDATE`, [input.userId, input.idempotencyKey])
        if (!reservation.rows[0]) throw new Error("Gmail send reservation is unavailable")
        const existing = await client.query<{ payload: Record<string, unknown> }>(`SELECT "payload" FROM "agent_events" WHERE "sessionId" = $1 AND "idempotencyKey" = $2 LIMIT 1`, [input.sessionId, `gmail-send:${input.idempotencyKey}:evidence`])
        const already = mapEvidence(existing.rows[0]?.payload)
        if (already) { await client.query("COMMIT"); return already }

        const job = await client.query(`SELECT "id" FROM "Job" WHERE "id" = $1 AND "userId" = $2`, [input.jobId, input.userId])
        if (!job.rows[0]) throw new Error("Gmail tracking job is unavailable")
        await client.query(`INSERT INTO "gmail_messages" ("id", "user_id", "gmail_message_id", "gmail_thread_id", "kind", "subject", "received_at", "job_id", "processed_at") VALUES ($1, $2, $3, $4, 'other', $5, CURRENT_TIMESTAMP, $6, CURRENT_TIMESTAMP) ON CONFLICT ("user_id", "gmail_message_id") DO UPDATE SET "gmail_thread_id" = COALESCE("gmail_messages"."gmail_thread_id", EXCLUDED."gmail_thread_id"), "job_id" = COALESCE("gmail_messages"."job_id", EXCLUDED."job_id")`, [randomUUID(), input.userId, input.messageId, input.threadId, input.subject || "(No subject)", input.jobId])
        await client.query(`UPDATE "Job" SET "followUpAt" = NULL WHERE "id" = $1 AND "userId" = $2`, [input.jobId, input.userId])
        await client.query(`INSERT INTO "Activity" ("id", "userId", "jobId", "type", "text", "color", "createdAt") VALUES ($1, $2, $3, 'email_sent', 'Gmail follow-up sent', '#7C3AED', CURRENT_TIMESTAMP)`, [randomUUID(), input.userId, input.jobId])
        const evidenceId = randomUUID()
        const evidence: GmailSendEvidence = { evidenceId, messageId: input.messageId, threadId: input.threadId, jobId: input.jobId, idempotencyKey: input.idempotencyKey, tracked: true }
        await appendEvidenceEvent(client, input, evidence)
        await client.query(`UPDATE "agent_action_reservations" SET "status" = 'completed', "updatedAt" = CURRENT_TIMESTAMP WHERE "userId" = $1 AND "idempotencyKey" = $2 AND "status" = 'reserved'`, [input.userId, input.idempotencyKey])
        await client.query("COMMIT")
        return evidence
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined)
        throw error
      } finally { client.release() }
    },
  }
}

/** Creates a durable, tenant-bound OAuth wait without storing a token or email body. */
export function createPgGmailOAuthWaitPort(pool: PoolLike): GmailOAuthWaitPort {
  return {
    async suspend(input: { context: ToolExecutionContext; reason: "gmail_reauthorization_required" }) {
      const { context } = input
      const waitId = randomUUID()
      const itemId = `gmail-oauth:${waitId}`
      const client = await pool.connect()
      try {
        await client.query("BEGIN")
        await client.query("SELECT set_config($1, $2, true)", ["app.user_id", context.scope.userId])
        const turn = await client.query<{ revision: number }>(`SELECT "revision" FROM "agent_turns" WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3 AND "status" = 'in_progress' FOR UPDATE`, [context.turnId, context.sessionId, context.scope.userId])
        if (!turn.rows[0]) throw new Error("Gmail OAuth wait is outside the origin Turn")
        await client.query(`INSERT INTO "agent_items" ("id", "sessionId", "turnId", "stepId", "type", "status", "phase", "content", "startedAt", "updatedAt") VALUES ($1, $2, $3, $4, 'question', 'started', 'commentary', $5::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`, [itemId, context.sessionId, context.turnId, context.stepId, JSON.stringify({ waitKind: "question", oauth: true, waitId, toolCallId: context.toolCallId ?? null, reason: input.reason })])
        const sequence = await client.query<{ eventSequence: string | bigint }>(`UPDATE "agent_sessions" SET "eventSequence" = "eventSequence" + 1 WHERE "id" = $1 AND "userId" = $2 RETURNING "eventSequence"`, [context.sessionId, context.scope.userId])
        const next = sequence.rows[0]?.eventSequence
        if (next === undefined) throw new Error("Gmail OAuth wait session is unavailable")
        await client.query(`INSERT INTO "agent_events" ("id", "sessionId", "turnId", "itemId", "sequence", "type", "actor", "correlationId", "idempotencyKey", "payload") VALUES ($1, $2, $3, $4, $5, 'item.started', 'orchestrator', $4, $6, $7::jsonb)`, [randomUUID(), context.sessionId, context.turnId, itemId, String(next), `gmail-oauth:${waitId}:started`, JSON.stringify({ itemId, waitId, toolCallId: context.toolCallId ?? null })])
        await client.query("COMMIT")
        return { waitId, reconnectUrl: `/api/gmail/oauth/start?agentWaitId=${encodeURIComponent(waitId)}&returnTo=/?page=agent` }
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined)
        throw error
      } finally { client.release() }
    },
  }
}

async function appendEvidenceEvent(client: Client, input: { userId: string; sessionId: string; turnId: string; idempotencyKey: string }, evidence: GmailSendEvidence): Promise<void> {
  const sequence = await client.query<{ eventSequence: string | bigint }>(`UPDATE "agent_sessions" SET "eventSequence" = "eventSequence" + 1 WHERE "id" = $1 AND "userId" = $2 RETURNING "eventSequence"`, [input.sessionId, input.userId])
  const next = sequence.rows[0]?.eventSequence
  if (next === undefined) throw new Error("Gmail evidence session is unavailable")
  const payload = JSON.stringify(evidence)
  await client.query(`INSERT INTO "agent_events" ("id", "sessionId", "turnId", "sequence", "type", "actor", "correlationId", "idempotencyKey", "payload") VALUES ($1, $2, $3, $4, 'gmail.sent', 'orchestrator', $3, $5, $6::jsonb)`, [evidence.evidenceId, input.sessionId, input.turnId, String(next), `gmail-send:${input.idempotencyKey}:evidence`, payload])
  await client.query(`INSERT INTO "agent_outbox" ("id", "topic", "aggregateId", "idempotencyKey", "payload") VALUES ($1, 'agent.session.event', $2, $3, $4::jsonb)`, [`agent-outbox-${evidence.evidenceId}`, input.sessionId, `agent-event:${evidence.evidenceId}`, JSON.stringify({ eventId: evidence.evidenceId, sessionId: input.sessionId, turnId: input.turnId, type: "gmail.sent", actor: "orchestrator", idempotencyKey: `gmail-send:${input.idempotencyKey}:evidence`, payload: evidence })])
}

function mapEvidence(value: unknown): GmailSendEvidence | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  if (!["evidenceId", "messageId", "jobId", "idempotencyKey"].every((key) => typeof row[key] === "string" && row[key])) return null
  return { evidenceId: row.evidenceId as string, messageId: row.messageId as string, threadId: typeof row.threadId === "string" ? row.threadId : null, jobId: row.jobId as string, idempotencyKey: row.idempotencyKey as string, tracked: row.tracked === true }
}
