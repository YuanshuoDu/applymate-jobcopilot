import { isDeepStrictEqual } from "node:util"
import type pg from "pg"
import type { SubagentLease } from "./types.js"
import { dateValue, object, projectDurableSubagentWait, safeSubagentWaitJson } from "./durable-subagent-wait-store.js"

type Client = Pick<pg.PoolClient, "query">
type Lease = Pick<SubagentLease, "id" | "userId" | "sessionId" | "turnId" | "rootTaskId" | "ownerId" | "attemptCount" | "leaseExpiresAt">
type Row = Record<string, unknown>
const TERMINAL_TARGET = new Set(["completed", "failed", "interrupted", "cancelled", "closed", "passed", "skipped"])

function strictIds(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.some(id => typeof id !== "string" || !id.trim() || id !== id.trim() || id.length > 256)) return undefined
  const ids = value as string[]
  return new Set(ids).size === ids.length ? ids : undefined
}
function sameIds(left: readonly string[], right: readonly string[]): boolean { return [...left].sort().join("\u0000") === [...right].sort().join("\u0000") }
function exact(row: Row, fields: Record<string, unknown>): boolean { return Object.entries(fields).every(([key, value]) => row[key] === value) }

const WAIT_SQL = `SELECT wait.*, task."status" AS "repairTaskStatus", task."leaseOwner" AS "repairLeaseOwner", task."attemptCount" AS "repairTaskAttempt", task."leaseExpiresAt" AS "repairLeaseExpiresAt", task."interruptRequestedAt" AS "repairInterruptAt", task."nextAttemptAt" AS "repairNextAttemptAt", session."userId" AS "repairUserId", session."status" AS "repairSessionStatus", turn."status" AS "repairTurnStatus", root."status" AS "repairRootStatus", root."interruptRequestedAt" AS "repairRootInterruptAt", step."attempt" AS "repairAttempt", step."ordinal" AS "repairOrdinal", step."status" AS "repairStepStatus",
  (SELECT MAX(current."ordinal") FROM "agent_steps" AS current WHERE current."taskId" = task."id" AND current."sessionId" = task."sessionId" AND current."turnId" = task."turnId" AND current."attempt" = task."attemptCount") AS "repairLatestOrdinal",
  (SELECT continuation."status" FROM "agent_steps" AS continuation WHERE continuation."taskId" = task."id" AND continuation."sessionId" = task."sessionId" AND continuation."turnId" = task."turnId" AND continuation."attempt" = task."attemptCount" AND continuation."ordinal" = (SELECT MIN(later."ordinal") FROM "agent_steps" AS later WHERE later."taskId" = task."id" AND later."sessionId" = task."sessionId" AND later."turnId" = task."turnId" AND later."attempt" = task."attemptCount" AND later."ordinal" > step."ordinal")) AS "repairNextStatus",
  (SELECT continuation."ordinal" FROM "agent_steps" AS continuation WHERE continuation."taskId" = task."id" AND continuation."sessionId" = task."sessionId" AND continuation."turnId" = task."turnId" AND continuation."attempt" = task."attemptCount" AND continuation."ordinal" = (SELECT MIN(later."ordinal") FROM "agent_steps" AS later WHERE later."taskId" = task."id" AND later."sessionId" = task."sessionId" AND later."turnId" = task."turnId" AND later."attempt" = task."attemptCount" AND later."ordinal" > step."ordinal")) AS "repairNextOrdinal"
FROM "agent_wait_conditions" AS wait JOIN "sub_agent_tasks" AS task ON task."id" = wait."parentTaskId" AND task."sessionId" = wait."sessionId" AND task."turnId" = wait."turnId"
JOIN "agent_sessions" AS session ON session."id" = task."sessionId" AND session."userId" = wait."userId"
JOIN "agent_turns" AS turn ON turn."id" = wait."turnId" AND turn."sessionId" = wait."sessionId" AND turn."userId" = wait."userId" AND turn."rootTaskId" = task."rootTaskId"
JOIN "sub_agent_tasks" AS root ON root."id" = task."rootTaskId" AND root."sessionId" = task."sessionId" AND root."turnId" = task."turnId"
JOIN "agent_steps" AS step ON step."id" = wait."stepId" AND step."taskId" = task."id" AND step."sessionId" = task."sessionId" AND step."turnId" = task."turnId"
WHERE task."id" = $1 AND task."sessionId" = $2 AND wait."userId" = $3 AND task."turnId" = $4 AND task."rootTaskId" = $5
  AND task."status" = 'running' AND task."parentTaskId" IS NOT NULL AND task."leaseOwner" = $6 AND task."attemptCount" = $7 AND task."leaseExpiresAt" = $8 AND task."leaseExpiresAt" <= $9
  AND task."interruptRequestedAt" IS NULL AND (task."nextAttemptAt" IS NULL OR task."nextAttemptAt" <= $9) AND session."status" NOT IN ('aborted', 'archived')
  AND turn."status" NOT IN ('completed', 'failed', 'interrupted', 'cancelled', 'closed') AND root."status" NOT IN ('completed', 'failed', 'interrupted', 'cancelled', 'closed')
  AND root."interruptRequestedAt" IS NULL AND wait."status" IN ('ready', 'timed_out') AND wait."suspendedAt" IS NOT NULL AND wait."consumedAt" IS NULL
  AND step."attempt" = task."attemptCount" AND step."status" IN ('waiting_for_tool', 'completed')
  AND ((step."status" = 'waiting_for_tool' AND step."ordinal" = (SELECT MAX(current."ordinal") FROM "agent_steps" AS current WHERE current."taskId" = task."id" AND current."sessionId" = task."sessionId" AND current."turnId" = task."turnId" AND current."attempt" = task."attemptCount'))
    OR (step."status" = 'completed' AND EXISTS (SELECT 1 FROM "agent_steps" AS continuation WHERE continuation."taskId" = task."id" AND continuation."sessionId" = task."sessionId" AND continuation."turnId" = task."turnId" AND continuation."attempt" = task."attemptCount" AND continuation."ordinal" = (SELECT MIN(later."ordinal") FROM "agent_steps" AS later WHERE later."taskId" = task."id" AND later."sessionId" = task."sessionId" AND later."turnId" = task."turnId" AND later."attempt" = task."attemptCount" AND later."ordinal" > step."ordinal") AND continuation."status" = 'streaming' AND continuation."ordinal" = (SELECT MAX(current."ordinal") FROM "agent_steps" AS current WHERE current."taskId" = task."id" AND current."sessionId" = task."sessionId" AND current."turnId" = task."turnId" AND current."attempt" = task."attemptCount')))
  AND wait."id" = (SELECT latest."id" FROM "agent_wait_conditions" AS latest JOIN "agent_steps" AS latestStep ON latestStep."id" = latest."stepId" AND latestStep."sessionId" = latest."sessionId" AND latestStep."turnId" = latest."turnId" AND latestStep."taskId" = task."id" AND latestStep."attempt" = task."attemptCount"
    WHERE latest."parentTaskId" = task."id" AND latest."sessionId" = task."sessionId" AND latest."turnId" = task."turnId" ORDER BY latestStep."ordinal" DESC, latest."createdAt" DESC, latest."id" DESC LIMIT 1)
ORDER BY wait."createdAt" DESC, wait."id" DESC LIMIT 2 FOR UPDATE OF wait, step`

const CALL_SQL = `SELECT call."id" AS "callId", call."sessionId" AS "callSessionId", call."turnId" AS "callTurnId", call."taskId" AS "callTaskId", call."stepId" AS "callStepId", call."status", call."content",
    started."id" AS "eventId", started."sessionId" AS "eventSessionId", started."turnId" AS "eventTurnId", started."taskId" AS "eventTaskId", started."itemId" AS "eventItemId", started."correlationId" AS "eventCorrelationId", started."createdAt" AS "eventCreatedAt"
  FROM "agent_items" AS call JOIN "agent_events" AS started ON started."itemId" = call."id" AND started."sessionId" = call."sessionId" AND started."turnId" = call."turnId" AND started."taskId" = call."taskId"
  WHERE call."sessionId" = $1 AND call."turnId" = $2 AND call."taskId" = $3 AND call."stepId" = $4 AND call."type" = 'tool_call'
    AND call."content"->>'toolName' = 'wait_subagents' AND started."type" = 'tool_call.started' AND started."turnId" = $2
    AND NOT EXISTS (SELECT 1 FROM "agent_events" AS settled WHERE settled."sessionId" = started."sessionId" AND settled."taskId" = started."taskId" AND settled."correlationId" = started."correlationId" AND settled."type" IN ('tool_call.completed', 'tool_call.failed', 'tool_call.interrupted'))
    AND NOT EXISTS (SELECT 1 FROM "agent_items" AS result WHERE result."sessionId" = call."sessionId" AND result."turnId" = call."turnId" AND result."taskId" = call."taskId" AND result."stepId" = call."stepId" AND result."type" = 'tool_result' AND result."content"->>'toolCallId' = call."content"->>'toolCallId')
  ORDER BY started."createdAt" DESC, started."id" DESC LIMIT 2 FOR UPDATE OF call, started`

const TARGETS_SQL = `SELECT child."id", child."parentTaskId", child."rootTaskId", child."turnId", child."sessionId", child."status", child."role", child."result", child."failureReason", session."userId" AS "userId"
  FROM "sub_agent_tasks" AS child JOIN "agent_sessions" AS session ON session."id" = child."sessionId"
  WHERE child."id" = ANY($1::text[]) AND child."parentTaskId" = $2 AND child."rootTaskId" = $3 AND child."sessionId" = $4 AND child."turnId" = $5
    AND session."userId" = $6 AND session."status" NOT IN ('aborted', 'archived') FOR SHARE OF child`

/** Repair only a stale projection for the owner's current, unconsumed wait after its canonical evidence validates. */
export async function repairStaleWaitProjection(client: Client, lease: Lease, now: Date): Promise<boolean> {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime()) || !Number.isSafeInteger(lease.attemptCount) || lease.attemptCount < 1) return false
  const rows = await client.query<Row>(WAIT_SQL, [lease.id, lease.sessionId, lease.userId, lease.turnId, lease.rootTaskId, lease.ownerId, lease.attemptCount, lease.leaseExpiresAt, now])
  if (rows.rows.length !== 1) return false
  const wait = rows.rows[0]!, ids = strictIds(wait.targetTaskIds), matched = strictIds(wait.matchedTaskIds)
  const saved = wait.result && typeof wait.result === "object" && !Array.isArray(wait.result) ? wait.result as Row : undefined
  if (!ids || ids.length < 1 || ids.length > 8 || !matched || matched.some(id => !ids.includes(id)) || !saved
    || !(wait.mode === "any" || wait.mode === "all") || !(wait.status === "ready" || wait.status === "timed_out")
    || !exact(wait, { userId: lease.userId, sessionId: lease.sessionId, turnId: lease.turnId, parentTaskId: lease.id })
    || typeof wait.id !== "string" || !wait.id.trim() || typeof wait.stepId !== "string" || !wait.stepId.trim()
    || typeof wait.idempotencyKey !== "string" || !wait.idempotencyKey.trim() || wait.consumedAt != null || wait.suspendedAt == null || wait.resolvedAt == null
    || !exact(wait, { repairTaskStatus: "running", repairLeaseOwner: lease.ownerId, repairTaskAttempt: lease.attemptCount,
      repairUserId: lease.userId, repairAttempt: lease.attemptCount })
    || typeof wait.repairStepStatus !== "string" || !["waiting_for_tool", "completed"].includes(wait.repairStepStatus)
    || typeof wait.repairSessionStatus !== "string" || ["aborted", "archived"].includes(wait.repairSessionStatus)
    || wait.repairStepStatus === "waiting_for_tool" && Number(wait.repairOrdinal) !== Number(wait.repairLatestOrdinal)
    || wait.repairStepStatus === "completed" && (wait.repairNextStatus !== "streaming" || Number(wait.repairNextOrdinal) !== Number(wait.repairLatestOrdinal))
    || wait.repairInterruptAt != null || wait.repairRootInterruptAt != null
    || ["completed", "failed", "interrupted", "cancelled", "closed"].includes(String(wait.repairTurnStatus))
    || ["completed", "failed", "interrupted", "cancelled", "closed"].includes(String(wait.repairRootStatus))) return false
  try {
    const ownerExpiry = dateValue(wait.repairLeaseExpiresAt, "task.leaseExpiresAt")
    if (ownerExpiry.getTime() !== lease.leaseExpiresAt.getTime() || ownerExpiry > now
      || wait.repairNextAttemptAt != null && dateValue(wait.repairNextAttemptAt, "task.nextAttemptAt") > now) return false
  } catch { return false }
  let createdAt: Date, deadlineAt: Date
  try { createdAt = dateValue(wait.createdAt, "wait.createdAt"); deadlineAt = dateValue(wait.deadlineAt, "wait.deadlineAt") } catch { return false }
  const timeoutMs = deadlineAt.getTime() - createdAt.getTime()
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 86_400_000) return false
  const targetsResult = await client.query<Row>(TARGETS_SQL, [ids, lease.id, lease.rootTaskId, lease.sessionId, lease.turnId, lease.userId])
  const targets = targetsResult.rows
  if (targets.length !== ids.length || targets.some(target => !ids.includes(String(target.id)) || target.parentTaskId !== lease.id
    || target.rootTaskId !== lease.rootTaskId || target.sessionId !== lease.sessionId || target.turnId !== lease.turnId
    || target.userId !== lease.userId || typeof target.status !== "string" || typeof target.role !== "string")) return false
  const currentMatched = targets.filter(target => TERMINAL_TARGET.has(String(target.status))).map(target => String(target.id))
  if (!sameIds(matched, currentMatched) || wait.status === "ready" && (wait.mode === "any" ? !matched.length : matched.length !== ids.length)) return false
  const request = { targetTaskIds: ids, mode: wait.mode, timeoutMs }
  const outcome = projectDurableSubagentWait({ ...wait, deadlineAt }, targets, wait.status, matched)
  const calls = await client.query<Row>(CALL_SQL, [lease.sessionId, lease.turnId, lease.id, wait.stepId])
  const projectionMatches = isDeepStrictEqual(saved.request, request) && isDeepStrictEqual(saved.outcome, outcome)
  if (calls.rows.length > 1 || calls.rows.length === 0 && !projectionMatches) return false
  if (calls.rows.length === 0) return true
  const callRow = calls.rows[0]!, call = object(callRow.content), input = object(call.input), callIds = strictIds(input.taskIds)
  try {
    if (dateValue(callRow.eventCreatedAt, "event.createdAt") > now) return false
  } catch { return false }
  if (callRow.callSessionId !== lease.sessionId || callRow.callTurnId !== lease.turnId || callRow.callTaskId !== lease.id
    || callRow.callStepId !== wait.stepId || callRow.eventSessionId !== lease.sessionId || callRow.eventTurnId !== lease.turnId
    || callRow.eventTaskId !== lease.id || callRow.eventItemId !== callRow.callId || callRow.eventCorrelationId !== call.toolCallId
    || !callRow.eventId || !["started", "completed"].includes(String(callRow.status))
    || call.toolName !== "wait_subagents" || call.toolVersion !== "1" || typeof call.toolCallId !== "string" || !call.toolCallId.trim()
    || Object.keys(input).sort().join(",") !== "idempotencyKey,mode,taskIds,timeoutMs" || input.idempotencyKey !== wait.idempotencyKey
    || input.mode !== wait.mode || input.timeoutMs !== timeoutMs || !callIds || !sameIds(callIds, ids)) return false
  if (projectionMatches) return true
  const canonical = { request, outcome }, persisted = safeSubagentWaitJson(canonical, 16_384)
  if (!isDeepStrictEqual(persisted, canonical)) return false
  const updated = await client.query(`UPDATE "agent_wait_conditions" AS wait SET "result" = $1::jsonb
    WHERE wait."id" = $2 AND wait."userId" = $3 AND wait."sessionId" = $4 AND wait."turnId" = $5 AND wait."parentTaskId" = $6 AND wait."stepId" = $7
      AND wait."idempotencyKey" = $8 AND wait."targetTaskIds" = $9::jsonb AND wait."matchedTaskIds" = $10::jsonb AND wait."mode" = $11
      AND wait."deadlineAt" = $12 AND wait."createdAt" = $13 AND wait."resolvedAt" = $14 AND wait."result" = $15::jsonb
      AND wait."status" IN ('ready', 'timed_out') AND wait."suspendedAt" IS NOT NULL AND wait."consumedAt" IS NULL
      AND EXISTS (SELECT 1 FROM "sub_agent_tasks" AS task WHERE task."id" = wait."parentTaskId" AND task."sessionId" = wait."sessionId" AND task."turnId" = wait."turnId" AND task."rootTaskId" = $16 AND task."status" = 'running' AND task."leaseOwner" = $17 AND task."attemptCount" = $18 AND task."leaseExpiresAt" = $19 AND task."leaseExpiresAt" <= clock_timestamp() AND task."interruptRequestedAt" IS NULL)
    RETURNING wait."id"`, [JSON.stringify(persisted), wait.id, lease.userId, lease.sessionId, lease.turnId, lease.id,
    wait.stepId, wait.idempotencyKey, JSON.stringify(ids), JSON.stringify(matched), wait.mode, deadlineAt, createdAt, wait.resolvedAt, JSON.stringify(saved),
    lease.rootTaskId, lease.ownerId, lease.attemptCount, lease.leaseExpiresAt])
  return updated.rowCount === 1
}
