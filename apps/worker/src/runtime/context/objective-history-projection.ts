import { createHash } from "node:crypto"
import type pg from "pg"
import { rootTaskHistoryObjectiveDigest, rootTaskHistoryOrigin } from "./root-task-history-fence.js"

type Queryable = Pick<pg.PoolClient, "query">
type Row = Record<string, unknown>
const SEMANTICS_VERSION = 1
const TERMINAL_TYPES = ["turn.completed", "turn.failed", "turn.interrupted"] as const

export type RootObjectiveHistoryIdentity = Readonly<{
  userId: string
  sessionId: string
  turnId: string
  rootTaskId: string
}>

export type RootObjectiveHistoryProjectionOptions = Readonly<{ terminalEventId?: string }>

function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.trim() === value
}

function object(value: unknown): Row | null {
  let parsed = value
  if (typeof parsed === "string") { try { parsed = JSON.parse(parsed) as unknown } catch { return null } }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
  try {
    const prototype = Object.getPrototypeOf(parsed)
    return prototype === Object.prototype || prototype === null ? parsed as Row : null
  } catch { return null }
}

function sequence(value: unknown): bigint | undefined {
  if (typeof value !== "string" && typeof value !== "bigint") return undefined
  try { const parsed = BigInt(value); return parsed > 0n ? parsed : undefined } catch { return undefined }
}

function validIdentity(value: RootObjectiveHistoryIdentity): boolean {
  return !!value && typeof value === "object"
    && [value.userId, value.sessionId, value.turnId, value.rootTaskId].every(text)
}

function validStart(row: Row, turnId: string, rootTaskId: string): bigint | undefined {
  const payload = object(row.startPayload), value = sequence(row.startSequence)
  return Number(row.startCount) === 1 && row.startTurnId === turnId && row.startTaskId === rootTaskId
    && row.startItemId === null && row.startType === "turn.started" && row.startActor === "orchestrator"
    && row.startCorrelationId === turnId && row.startIdempotencyKey === "turn:" + turnId + ":event:turn-started"
    && payload?.taskId === rootTaskId && payload.rootTaskId === rootTaskId ? value : undefined
}

function validCompletedReceipt(row: Row, turnId: string, rootTaskId: string, start: bigint, terminal: bigint): boolean {
  const stepPayload = object(row.stepPayload), stepSequence = sequence(row.stepEventSequence)
  return row.stepStatus === "completed" && row.stepSessionId === row.sessionId && row.stepTurnId === turnId
    && row.stepTaskId === rootTaskId && Number(row.stepEventCount) === 1
    && row.stepEventSessionId === row.sessionId && row.stepEventTurnId === turnId && row.stepEventTaskId === rootTaskId
    && row.stepEventItemId === null && row.stepEventType === "step.completed" && row.stepEventActor === "orchestrator"
    && row.stepEventCorrelationId === row.terminalCorrelationId
    && row.stepEventIdempotencyKey === "turn:" + turnId + ":event:step-completed:" + row.terminalCorrelationId
    && stepSequence !== undefined && stepSequence > start && stepSequence < terminal
    && !!stepPayload && Object.keys(stepPayload).sort().join(",") === "status,stepId,taskId"
    && stepPayload.stepId === row.terminalCorrelationId && stepPayload.status === "completed" && stepPayload.taskId === rootTaskId
}

function validTerminal(row: Row, identity: RootObjectiveHistoryIdentity): bigint | undefined {
  const payload = object(row.terminalPayload), value = sequence(row.terminalSequence)
  const expectedStatus = row.terminalType === "turn.completed" ? "completed"
    : row.terminalType === "turn.failed" ? "failed" : row.terminalType === "turn.interrupted" ? "interrupted" : undefined
  const lifecycleMatches = row.turnStatus === expectedStatus && row.rootStatus === expectedStatus
    || expectedStatus !== "completed" && row.turnStatus === "in_progress" && row.rootStatus === "running"
  if (!payload || !value || !expectedStatus || !lifecycleMatches || Number(row.terminalCount) !== 1
    || row.terminalTaskId !== identity.rootTaskId || row.terminalActor !== "orchestrator"
    || payload.turnId !== identity.turnId || payload.taskId !== identity.rootTaskId) return undefined
  const prefix = "turn:" + identity.turnId + ":event:"
  if (expectedStatus === "completed") {
    const start = validStart(row, identity.turnId, identity.rootTaskId)
    return row.terminalType === "turn.completed" && start !== undefined && text(payload.finalItemId)
      && row.terminalItemId === payload.finalItemId && text(row.terminalCorrelationId)
      && row.terminalIdempotencyKey === prefix + "turn-completed"
      && validCompletedReceipt(row, identity.turnId, identity.rootTaskId, start, value) ? value : undefined
  }
  if (expectedStatus === "failed") return row.terminalType === "turn.failed" && text(payload.errorCode)
    && (payload.finalItemId === null || text(payload.finalItemId)) && row.terminalItemId === payload.finalItemId
    && row.terminalCorrelationId === identity.turnId
    && row.terminalIdempotencyKey === prefix + "turn-failed:" + payload.errorCode ? value : undefined
  return expectedStatus === "interrupted" && text(payload.errorCode)
    && row.terminalItemId === null && row.terminalCorrelationId === identity.turnId
    && row.terminalIdempotencyKey === prefix + "turn-interrupted" ? value : undefined
}

async function updateObjective(client: Queryable, identity: RootObjectiveHistoryIdentity): Promise<boolean> {
  const found = await client.query<Row>(`SELECT turn."input", turn."source", root."goal", root."successCriteria"
    FROM "agent_turns" AS turn
    JOIN "sub_agent_tasks" AS root ON root."id" = turn."rootTaskId" AND root."sessionId" = turn."sessionId"
      AND root."turnId" = turn."id" AND root."rootTaskId" = root."id"
    WHERE turn."id" = $1 AND turn."sessionId" = $2 AND turn."userId" = $3 AND turn."rootTaskId" = $4
      AND root."id" = $4 AND root."parentTaskId" IS NULL AND root."role" = 'orchestrator' AND root."taskType" = 'root'
    FOR UPDATE OF turn, root`, [identity.turnId, identity.sessionId, identity.userId, identity.rootTaskId])
  if (found.rows.length !== 1) return false
  const row = found.rows[0]!
  const objectiveDigest = rootTaskHistoryObjectiveDigest(row.input, row, false) ?? null
  const crossSessionDigest = rootTaskHistoryObjectiveDigest(row.input, row, true)
  const canonicalOrigin = rootTaskHistoryOrigin(row.source, row.input)
  const canonicalOriginDigest = crossSessionDigest && canonicalOrigin
    ? createHash("sha256").update(JSON.stringify({ objectiveDigest: crossSessionDigest, canonicalOrigin })).digest("hex")
    : null
  const version = objectiveDigest ? SEMANTICS_VERSION : null
  const result = await client.query(`UPDATE "agent_turns" SET "objectiveDigest" = $1, "canonicalOriginDigest" = $2,
      "objectiveIndexSemanticsVersion" = $3 WHERE "id" = $4 AND "sessionId" = $5 AND "userId" = $6 AND "rootTaskId" = $7`,
  [objectiveDigest, canonicalOriginDigest, version, identity.turnId, identity.sessionId, identity.userId, identity.rootTaskId])
  return result.rowCount === 1
}

async function updateTerminal(client: Queryable, identity: RootObjectiveHistoryIdentity, eventId: string): Promise<boolean> {
  const found = await client.query<Row>(`SELECT turn."status" AS "turnStatus", root."status" AS "rootStatus",
      event."sessionId", event."turnId", event."taskId" AS "terminalTaskId", event."itemId" AS "terminalItemId",
      event."sequence" AS "terminalSequence", event."type" AS "terminalType", event."actor" AS "terminalActor",
      event."correlationId" AS "terminalCorrelationId", event."idempotencyKey" AS "terminalIdempotencyKey",
      event."payload" AS "terminalPayload", event."createdAt" AS "terminalAt",
      (SELECT COUNT(*) FROM "agent_events" receipt WHERE receipt."sessionId" = turn."sessionId"
        AND receipt."turnId" = turn."id" AND receipt."taskId" = turn."rootTaskId"
        AND receipt."type" IN ('turn.completed', 'turn.failed', 'turn.interrupted')) AS "terminalCount",
      started."turnId" AS "startTurnId", started."taskId" AS "startTaskId", started."itemId" AS "startItemId",
      started."sequence" AS "startSequence", started."type" AS "startType", started."actor" AS "startActor",
      started."correlationId" AS "startCorrelationId", started."idempotencyKey" AS "startIdempotencyKey",
      started."payload" AS "startPayload", started."startCount",
      step."id" AS "stepId", step."sessionId" AS "stepSessionId", step."turnId" AS "stepTurnId",
      step."taskId" AS "stepTaskId", step."status" AS "stepStatus",
      step_event."sessionId" AS "stepEventSessionId", step_event."turnId" AS "stepEventTurnId",
      step_event."taskId" AS "stepEventTaskId", step_event."itemId" AS "stepEventItemId",
      step_event."sequence" AS "stepEventSequence", step_event."type" AS "stepEventType",
      step_event."actor" AS "stepEventActor", step_event."correlationId" AS "stepEventCorrelationId",
      step_event."idempotencyKey" AS "stepEventIdempotencyKey", step_event."payload" AS "stepPayload",
      step_event."stepEventCount"
    FROM "agent_turns" AS turn
    JOIN "sub_agent_tasks" AS root ON root."id" = turn."rootTaskId" AND root."sessionId" = turn."sessionId"
      AND root."turnId" = turn."id" AND root."rootTaskId" = root."id"
    JOIN "agent_events" AS event ON event."id" = $5 AND event."sessionId" = turn."sessionId"
      AND event."turnId" = turn."id" AND event."taskId" = turn."rootTaskId"
      AND event."type" IN ('turn.completed', 'turn.failed', 'turn.interrupted')
    LEFT JOIN LATERAL (SELECT receipt."turnId", receipt."taskId", receipt."itemId", receipt."sequence", receipt."type",
      receipt."actor", receipt."correlationId", receipt."idempotencyKey", receipt."payload", COUNT(*) OVER () AS "startCount"
      FROM "agent_events" receipt WHERE receipt."sessionId" = turn."sessionId" AND receipt."turnId" = turn."id"
        AND receipt."taskId" = turn."rootTaskId" AND receipt."type" = 'turn.started'
      ORDER BY receipt."sequence" DESC LIMIT 1) started ON true
    LEFT JOIN "agent_steps" AS step ON event."type" = 'turn.completed' AND step."id" = event."correlationId"
      AND step."sessionId" = turn."sessionId" AND step."turnId" = turn."id" AND step."taskId" = turn."rootTaskId"
    LEFT JOIN LATERAL (SELECT receipt."sessionId", receipt."turnId", receipt."taskId", receipt."itemId", receipt."sequence",
      receipt."type", receipt."actor", receipt."correlationId", receipt."idempotencyKey", receipt."payload",
      COUNT(*) OVER () AS "stepEventCount" FROM "agent_events" receipt
      WHERE event."type" = 'turn.completed' AND receipt."sessionId" = turn."sessionId" AND receipt."turnId" = turn."id"
        AND receipt."taskId" = turn."rootTaskId" AND (receipt."idempotencyKey" =
          ('turn:' || turn."id" || ':event:step-completed:' || step."id")
          OR (receipt."type" = 'step.completed' AND receipt."correlationId" = step."id"))
      ORDER BY receipt."sequence" DESC LIMIT 1) step_event ON true
    WHERE turn."id" = $1 AND turn."sessionId" = $2 AND turn."userId" = $3 AND turn."rootTaskId" = $4
      AND root."id" = $4 AND root."parentTaskId" IS NULL AND root."role" = 'orchestrator' AND root."taskType" = 'root'
      AND ((turn."status" = 'in_progress' AND root."status" = 'running')
        OR (turn."status" IN ('completed', 'failed', 'interrupted') AND root."status" = turn."status'))
    FOR UPDATE OF turn, root, event`, [identity.turnId, identity.sessionId, identity.userId, identity.rootTaskId, eventId])
  if (found.rows.length !== 1) return false
  const row = found.rows[0]!, terminal = validTerminal(row, identity)
  const at = row.terminalAt instanceof Date && Number.isFinite(row.terminalAt.getTime()) ? row.terminalAt : undefined
  const start = validStart(row, identity.turnId, identity.rootTaskId)
  if (!terminal || !at || start === undefined || terminal <= start
    || (row.turnStatus === "completed" && !validCompletedReceipt(row, identity.turnId, identity.rootTaskId, start, terminal))) return false
  const result = await client.query(`UPDATE "agent_turns" SET "terminalEventSequence" = $1, "terminalEventAt" = $2
    WHERE "id" = $3 AND "sessionId" = $4 AND "userId" = $5 AND "rootTaskId" = $6 AND "status" = $7`,
  [terminal.toString(), at, identity.turnId, identity.sessionId, identity.userId, identity.rootTaskId, row.turnStatus])
  return result.rowCount === 1
}

/** Updates one projection inside the caller's transaction; terminal mode accepts only the supplied persisted receipt. */
export async function updateRootObjectiveHistoryProjection(
  client: Queryable,
  identity: RootObjectiveHistoryIdentity,
  options: RootObjectiveHistoryProjectionOptions = {},
): Promise<boolean> {
  if (!validIdentity(identity)) return false
  if (options.terminalEventId !== undefined) return text(options.terminalEventId)
    ? updateTerminal(client, identity, options.terminalEventId) : false
  return updateObjective(client, identity)
}
