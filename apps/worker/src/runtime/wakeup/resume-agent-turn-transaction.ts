import type pg from "pg"
import { persistWakeupTurnDispatchInTransaction } from "../turns/recovery-scanner.js"
import type { AgentTurnWakeupPayload, WakeupResult } from "./types.js"
import { appendResumeEvent, hasMatchingWakeupEvent, hasReviewedApplicationReviewIntent, wakeupLeaseDisposition } from "./resume-projection.js"
import { assertObjectiveApprovalSetItem, assertObjectiveApprovalSetWakeupEvent } from "./resume-objective-approval-set.js"
import { inspectObjectiveFinalSubmitWake } from "./resume-objective-final-submit-wait.js"

type Client = pg.PoolClient
type PoolLike = Pick<pg.Pool, "connect">
type RecordValue = Record<string, unknown>
type TerminalWakeupErrorCode = "schema_invalid_payload" | "outbox_scope_mismatch" | "event_lineage_mismatch" | "item_lineage_mismatch" | "tool_lineage_mismatch" | "turn_revision_conflict" | "wait_scope_mismatch" | "approval_set_lineage_mismatch" | "objective_final_submit_wait_mismatch"
export class TerminalWakeupError extends Error {
  constructor(readonly code: TerminalWakeupErrorCode, message: string) { super(message); this.name = "TerminalWakeupError" }
}
const CLOSED_SESSION_STATUSES = new Set(["aborted", "archived"])
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
  const reviewedReview = hasReviewedApplicationReviewIntent(turn.input)
  if (payload.waitKind === "approval_set" && reviewedReview) fail("wait_scope_mismatch", "Reviewed application approval Wait cannot resume an approval set")
  if (payload.waitKind === "approval_set") {
    await assertObjectiveApprovalSetWakeupEvent(client, payload, (code, message) => fail(code, message))
  } else if (!await hasMatchingWakeupEvent(client, payload)) {
    fail(reviewedReview ? "wait_scope_mismatch" : "event_lineage_mismatch", "Agent wakeup event lineage does not match payload")
  }
  const objectiveFinalSubmit = await inspectObjectiveFinalSubmitWake(client, payload, turn, session.userId)
  if (objectiveFinalSubmit === "mismatch") fail("objective_final_submit_wait_mismatch", "Objective submission approval wakeup evidence does not match")
  if (objectiveFinalSubmit === "acknowledge") return { status: "ignored", sessionId: payload.sessionId, turnId: payload.turnId, itemId: payload.itemId, toolCallId: payload.toolCallId }
  if (turn.status === "queued" || turn.status === "in_progress") return { status: "already_resumed", sessionId: payload.sessionId, turnId: payload.turnId, itemId: payload.itemId, toolCallId: payload.toolCallId }
  if (turn.status !== "waiting_for_approval" && turn.status !== "waiting_for_user") return { status: "ignored", sessionId: payload.sessionId, turnId: payload.turnId, itemId: payload.itemId, toolCallId: payload.toolCallId }
  const expected = payload.waitKind === "question" ? "waiting_for_user" : "waiting_for_approval"
  if (turn.status !== expected) fail("wait_scope_mismatch", "Agent wakeup wait kind does not match Turn status")
  if (turn.revision !== payload.nextTurnRevision) fail("turn_revision_conflict", "Agent Turn revision changed before wakeup")
  const itemResult = await client.query<{ status: string; taskId: string | null; content: unknown }>(
    `SELECT "status", "taskId", "content" FROM "agent_items" WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "type" = $4 FOR UPDATE`,
    [payload.itemId, payload.sessionId, payload.turnId, payload.waitKind === "question" ? "question" : "approval_request"])
  const item = itemResult.rows[0]
  if (!item || item.status !== "completed") {
    if (reviewedReview) fail("wait_scope_mismatch", "Reviewed application approval Wait is unavailable")
    return { status: "ignored", sessionId: payload.sessionId, turnId: payload.turnId, itemId: payload.itemId, toolCallId: payload.toolCallId }
  }
  if (payload.waitKind === "approval_set") {
    await assertObjectiveApprovalSetItem(client, payload, session.userId, item, (code, message) => fail(code, message))
  } else {
    const content = record(item.content) ?? {}
    const itemWaitId = payload.waitKind === "approval" ? content.approvalId : content.waitId ?? content.questionId
    if (content.waitKind !== payload.waitKind || itemWaitId !== payload.waitId) fail(reviewedReview ? "wait_scope_mismatch" : "item_lineage_mismatch", "Agent wait item lineage does not match wakeup")
    const itemToolCallId = typeof content.toolCallId === "string" ? content.toolCallId : null
    if (itemToolCallId !== payload.toolCallId) fail(reviewedReview ? "wait_scope_mismatch" : "tool_lineage_mismatch", "Agent wait tool lineage does not match wakeup")
  }
  if (payload.waitKind !== "approval_set") {
    const disposition = wakeupLeaseDisposition(payload, turn, {
      id: payload.itemId, type: payload.waitKind === "question" ? "question" : "approval_request",
      status: item.status, taskId: item.taskId, content: item.content,
    })
    if (disposition === "wait_scope_mismatch") fail("wait_scope_mismatch", "Reviewed application approval Wait does not match its typed intent")
    if (disposition === "defer") return { status: "deferred", sessionId: payload.sessionId, turnId: payload.turnId, itemId: payload.itemId, toolCallId: payload.toolCallId }
  }
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
