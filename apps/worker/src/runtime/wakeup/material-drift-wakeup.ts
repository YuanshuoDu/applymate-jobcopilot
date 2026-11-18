import { randomUUID } from "node:crypto"
import type pg from "pg"

import { persistWakeupTurnDispatchInTransaction } from "../turns/recovery-scanner.js"
import {
  readMaterialDriftRecoveryIntent,
  verifyMaterialDriftRecoveryLineage,
} from "../subagents/canonical-turn-scheduled-pipeline-context.js"
import type { AgentTurnWakeupPayload, WakeupResult } from "./types.js"

type Client = pg.PoolClient
const CLOSED_SESSION_STATUSES = new Set(["aborted", "archived"])
interface WakeupEventRow { sessionId: string; turnId: string; itemId: string | null; type: string; payload: unknown }
type TerminalWakeupErrorCode = "schema_invalid_payload" | "outbox_scope_mismatch" | "event_lineage_mismatch" | "item_lineage_mismatch" | "tool_lineage_mismatch" | "turn_revision_conflict" | "wait_scope_mismatch" | "material_drift_recovery_invalid" | "material_drift_recovery_lineage_mismatch"

export class TerminalWakeupError extends Error {
  constructor(readonly code: TerminalWakeupErrorCode, message: string) { super(message); this.name = "TerminalWakeupError" }
}

function json(value: unknown): string { return JSON.stringify(value) }
function record(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {} }

function validateWakeupPayload(payload: AgentTurnWakeupPayload): void {
  const identifiers = [payload.eventId, payload.sessionId, payload.turnId, payload.itemId, payload.waitId]
  const validToolCallId = payload.toolCallId === null || (typeof payload.toolCallId === "string" && payload.toolCallId.trim().length > 0)
  if (!identifiers.every((value) => typeof value === "string" && value.trim().length > 0) || (payload.waitKind !== "approval" && payload.waitKind !== "question") || (payload.status !== "approved" && payload.status !== "rejected" && payload.status !== "answered") || !validToolCallId || !Number.isSafeInteger(payload.nextTurnRevision) || payload.nextTurnRevision < 0) throw new TerminalWakeupError("schema_invalid_payload", "Agent wakeup payload is invalid")
}

async function assertWakeupEvent(client: Client, payload: AgentTurnWakeupPayload): Promise<void> {
  const result = await client.query<WakeupEventRow>(`SELECT "sessionId", "turnId", "itemId", "type", "payload" FROM "agent_events" WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "itemId" = $4 AND "type" = 'turn.wakeup' FOR SHARE`, [payload.eventId, payload.sessionId, payload.turnId, payload.itemId])
  const event = result.rows[0]
  const eventPayload = record(event?.payload)
  if (!event || event.itemId !== payload.itemId || event.type !== "turn.wakeup" || eventPayload.waitKind !== payload.waitKind || eventPayload.waitId !== payload.waitId || eventPayload.itemId !== payload.itemId || eventPayload.turnId !== payload.turnId || eventPayload.toolCallId !== payload.toolCallId || eventPayload.status !== payload.status || eventPayload.nextTurnRevision !== payload.nextTurnRevision) {
    throw new TerminalWakeupError("event_lineage_mismatch", "Agent wakeup event lineage does not match payload")
  }
}

async function appendResumeEvent(client: Client, payload: AgentTurnWakeupPayload, userId: string): Promise<void> {
  const sequenceResult = await client.query<{ eventSequence: string | bigint }>(
    `UPDATE "agent_sessions" AS session
     SET "eventSequence" = "eventSequence" + 1
     WHERE session."id" = $1 AND session."userId" = $2
       AND session."status" NOT IN ('aborted', 'archived')
     RETURNING "eventSequence"`,
    [payload.sessionId, userId],
  )
  const sequence = sequenceResult.rows[0]?.eventSequence
  if (sequence === undefined) throw new Error("Agent session sequence is unavailable for wakeup")
  const eventId = randomUUID()
  const eventPayload = { waitKind: payload.waitKind, waitId: payload.waitId, itemId: payload.itemId, turnId: payload.turnId, toolCallId: payload.toolCallId, status: payload.status, resumedFromEventId: payload.eventId }
  await client.query(`INSERT INTO "agent_events" ("id", "sessionId", "turnId", "itemId", "taskId", "sequence", "type", "actor", "correlationId", "causationId", "idempotencyKey", "payload") VALUES ($1, $2, $3, $4, NULL, $5, 'turn.resumed', 'system', $3, $6, $7, $8::jsonb)`, [eventId, payload.sessionId, payload.turnId, payload.itemId, String(sequence), payload.eventId, `agent-wakeup:${payload.eventId}:resumed`, json(eventPayload)])
  await client.query(`INSERT INTO "agent_outbox" ("id", "topic", "aggregateId", "idempotencyKey", "payload") VALUES ($1, 'agent.session.event', $2, $3, $4::jsonb)`, [`agent-outbox-${eventId}`, payload.sessionId, `agent-event:${eventId}`, json({
      eventId, sessionId: payload.sessionId, turnId: payload.turnId, itemId: payload.itemId,
      taskId: null, sequence: String(sequence), type: "turn.resumed", actor: "system",
      correlationId: payload.turnId, causationId: payload.eventId, idempotencyKey: `agent-wakeup:${payload.eventId}:resumed`, payload: eventPayload,
    })])
}

type WakeupTurn = {
  id: string; sessionId: string; userId: string; status: string; revision: number; source: string
  executionMode: string | null; input: unknown; rootTaskId: string | null; hasLiveLease: boolean
}

/** Resume the exact durable wait; material-drift authority is revalidated in this locked transaction. */
export async function resumeWakeupInTransaction(client: Client, payload: AgentTurnWakeupPayload): Promise<WakeupResult> {
  validateWakeupPayload(payload)
  const sessionResult = await client.query<{ userId: string; status: string }>(`SELECT "userId", "status" FROM "agent_sessions" WHERE "id" = $1 FOR UPDATE`, [payload.sessionId])
  const session = sessionResult.rows[0]
  if (!session || CLOSED_SESSION_STATUSES.has(session.status)) return { status: "ignored", sessionId: payload.sessionId, turnId: payload.turnId, itemId: payload.itemId, toolCallId: payload.toolCallId }
  await client.query(`SELECT set_config($1, $2, true)`, ["app.user_id", session.userId])
  const turnResult = await client.query<WakeupTurn>(
    `SELECT turn."id", turn."sessionId", turn."userId", turn."status", turn."revision", turn."source", turn."executionMode", turn."input", turn."rootTaskId",
       COALESCE(turn."leaseOwnerId" IS NOT NULL AND turn."leaseExpiresAt" > CURRENT_TIMESTAMP, FALSE) AS "hasLiveLease"
     FROM "agent_turns" AS turn WHERE turn."id" = $1 AND turn."sessionId" = $2 AND turn."userId" = $3 FOR UPDATE`,
    [payload.turnId, payload.sessionId, session.userId],
  )
  const turn = turnResult.rows[0]
  if (!turn) return { status: "ignored", sessionId: payload.sessionId, turnId: payload.turnId, itemId: payload.itemId, toolCallId: payload.toolCallId }
  await assertWakeupEvent(client, payload)
  if (turn.status === "queued" || turn.status === "in_progress") return { status: "already_resumed", sessionId: payload.sessionId, turnId: payload.turnId, itemId: payload.itemId, toolCallId: payload.toolCallId }
  if (turn.status !== "waiting_for_approval" && turn.status !== "waiting_for_user") return { status: "ignored", sessionId: payload.sessionId, turnId: payload.turnId, itemId: payload.itemId, toolCallId: payload.toolCallId }
  const expectedTurnStatus = payload.waitKind === "approval" ? "waiting_for_approval" : "waiting_for_user"
  if (turn.status !== expectedTurnStatus) throw new TerminalWakeupError("wait_scope_mismatch", "Agent wakeup wait kind does not match Turn status")
  if (turn.revision !== payload.nextTurnRevision) throw new TerminalWakeupError("turn_revision_conflict", "Agent Turn revision changed before wakeup")
  const itemResult = await client.query<{ status: string; taskId: string | null; content: unknown }>(
    `SELECT "status", "taskId", "content" FROM "agent_items" WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "type" = $4 FOR UPDATE`,
    [payload.itemId, payload.sessionId, payload.turnId, payload.waitKind === "approval" ? "approval_request" : "question"],
  )
  const item = itemResult.rows[0]
  if (!item || item.status !== "completed") return { status: "ignored", sessionId: payload.sessionId, turnId: payload.turnId, itemId: payload.itemId, toolCallId: payload.toolCallId }
  const content = record(item.content)
  const itemWaitId = payload.waitKind === "approval" ? content.approvalId : content.waitId ?? content.questionId
  if (content.waitKind !== payload.waitKind || itemWaitId !== payload.waitId) throw new TerminalWakeupError("item_lineage_mismatch", "Agent wait item lineage does not match wakeup")
  const itemToolCallId = typeof content.toolCallId === "string" ? content.toolCallId : null
  if (itemToolCallId !== payload.toolCallId) throw new TerminalWakeupError("tool_lineage_mismatch", "Agent wait tool lineage does not match wakeup")

  const turnInput = record(turn.input)
  const materialRead = readMaterialDriftRecoveryIntent(turn)
  const manualRecoveryCandidate = turn.source === "automation" && turn.executionMode === "canonical_task_graph" && turnInput.automationRunMode === "manual" && Object.hasOwn(turnInput, "materialDriftRecovery")
  if (materialRead.status === "invalid" && manualRecoveryCandidate) throw new TerminalWakeupError("material_drift_recovery_invalid", "Material-drift recovery intent is invalid")
  const verifiedMaterialRecovery = materialRead.status === "valid"
    ? await verifyMaterialDriftRecoveryLineage(client, turn, materialRead.intent)
    : false
  if (materialRead.status === "valid" && !verifiedMaterialRecovery) throw new TerminalWakeupError("material_drift_recovery_lineage_mismatch", "Material-drift recovery lineage is no longer eligible")
  const exactScheduledContinuationQuestion = payload.waitKind === "question" && payload.status === "answered"
    && content.answerAvailable === true && content.answer !== null && content.answer !== undefined
    && turn.source === "automation" && turn.executionMode === "canonical_task_graph"
    && turnInput.automationRunMode === "scheduled"
    && typeof turn.rootTaskId === "string" && turn.rootTaskId.length > 0
    && (item.taskId === null || item.taskId === turn.rootTaskId)
  const exactMaterialRecoveryQuestion = verifiedMaterialRecovery && payload.waitKind === "question" && payload.status === "answered"
    && content.answerAvailable === true && content.answer !== null && content.answer !== undefined
    && turn.source === "automation" && turn.executionMode === "canonical_task_graph" && turnInput.automationRunMode === "manual"
    && typeof turn.rootTaskId === "string" && turn.rootTaskId.length > 0
    && (item.taskId === null || item.taskId === turn.rootTaskId)
  if ((exactScheduledContinuationQuestion || exactMaterialRecoveryQuestion) && turn.hasLiveLease) return { status: "deferred", sessionId: payload.sessionId, turnId: payload.turnId, itemId: payload.itemId, toolCallId: payload.toolCallId }

  const updated = await client.query(
    `UPDATE "agent_turns" AS turn
     SET "status" = 'queued', "leaseOwnerId" = NULL, "leaseExpiresAt" = NULL,
         "leaseStartedAt" = NULL, "revision" = "revision" + 1,
         "completedAt" = NULL, "updatedAt" = CURRENT_TIMESTAMP
     WHERE turn."id" = $1 AND turn."sessionId" = $2 AND turn."userId" = $3
       AND turn."status" IN ('waiting_for_approval', 'waiting_for_user') AND turn."revision" = $4
       AND EXISTS (SELECT 1 FROM "agent_sessions" AS session WHERE session."id" = turn."sessionId" AND session."userId" = turn."userId" AND session."status" NOT IN ('aborted', 'archived'))`,
    [payload.turnId, payload.sessionId, session.userId, payload.nextTurnRevision],
  )
  if (updated.rowCount !== 1) return { status: "already_resumed", sessionId: payload.sessionId, turnId: payload.turnId, itemId: payload.itemId, toolCallId: payload.toolCallId }
  await client.query(`UPDATE "agent_executions" SET "status" = 'queued', "error" = NULL, "completedAt" = NULL WHERE "userId" = $1 AND "sessionId" = $2 AND "status" = 'waiting_for_user'`, [session.userId, payload.sessionId])
  await appendResumeEvent(client, payload, session.userId)
  if (!await persistWakeupTurnDispatchInTransaction(client, payload.turnId, payload.sessionId, payload.eventId)) throw new TerminalWakeupError("outbox_scope_mismatch", "Turn dispatch lineage does not match wakeup scope")
  return { status: "resumed", sessionId: payload.sessionId, turnId: payload.turnId, itemId: payload.itemId, toolCallId: payload.toolCallId }
}
