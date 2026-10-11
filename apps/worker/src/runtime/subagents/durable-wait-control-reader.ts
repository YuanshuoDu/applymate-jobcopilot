import type pg from "pg"
import type { DurableWaitControl, DurableWaitControlInvocation, DurableWaitControlReader } from "../tools/coordination-types.js"

type Pool = Pick<pg.Pool, "connect">
type Queryable = Pick<pg.PoolClient, "query">
type Row = Record<string, unknown>
export type DurableWaitReplayMatcher = (row: Row, input: DurableWaitControlInvocation) => boolean
const ACTIVE_TASKS = new Set(["queued", "running", "retrying", "waiting", "waiting_for_user"])
const INVOCATION_KEYS = "idempotencyKey,leaseVersion,mode,now,ownerId,rootTaskId,sessionId,stepId,targetTaskIds,taskId,timeoutMs,turnId,userId"

function record(value: unknown): Row | null { return value && typeof value === "object" && !Array.isArray(value) ? value as Row : null }
function text(value: unknown): value is string { return typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= 256 }
function valid(input: DurableWaitControlInvocation): boolean {
  const row = record(input)
  if (!row || Object.getPrototypeOf(row) !== Object.prototype || Reflect.ownKeys(row).some(key => typeof key !== "string")
    || (Reflect.ownKeys(row) as string[]).sort().join(",") !== INVOCATION_KEYS
    || INVOCATION_KEYS.split(",").some(key => { const descriptor = Object.getOwnPropertyDescriptor(row, key); return !descriptor?.enumerable || !("value" in descriptor) })) return false
  const targets = input.targetTaskIds
  return text(input.userId) && text(input.sessionId) && text(input.turnId) && text(input.stepId)
    && text(input.taskId) && input.taskId === input.rootTaskId && text(input.ownerId)
    && Number.isSafeInteger(input.leaseVersion) && input.leaseVersion >= 0 && input.now instanceof Date && Number.isFinite(input.now.getTime())
    && text(input.idempotencyKey) && (input.mode === "any" || input.mode === "all")
    && Number.isSafeInteger(input.timeoutMs) && input.timeoutMs >= 1 && input.timeoutMs <= 30_000
    && Array.isArray(targets) && targets.length >= 1 && targets.length <= 8
    && Array.from({ length: targets.length }, (_, index) => targets[index]).every(text)
    && new Set(targets).size === targets.length && !targets.includes(input.taskId)
}

async function read(client: Queryable, input: DurableWaitControlInvocation, matchesReplay: DurableWaitReplayMatcher): Promise<DurableWaitControl | null> {
  if (!valid(input)) return null
  const session = (await client.query<Row>(`SELECT "id" FROM "agent_sessions"
    WHERE "id" = $1 AND "userId" = $2 AND "status" NOT IN ('aborted', 'archived')`, [input.sessionId, input.userId])).rows[0]
  if (!session) return null
  const turn = (await client.query<Row>(`SELECT "rootTaskId" FROM "agent_turns"
    WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3 AND "status" = 'in_progress'
      AND "leaseOwnerId" = $4 AND "leaseVersion" = $5 AND "leaseExpiresAt" > $6`,
  [input.turnId, input.sessionId, input.userId, input.ownerId, input.leaseVersion, input.now])).rows[0]
  if (!turn || String(turn.rootTaskId ?? "") !== input.rootTaskId) return null
  const parent = (await client.query<Row>(`SELECT task."id", task."rootTaskId", task."turnId", task."status"
    FROM "sub_agent_tasks" AS task JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
    WHERE task."id" = $1 AND task."sessionId" = $2 AND session."userId" = $3
      AND session."status" NOT IN ('aborted', 'archived')`, [input.rootTaskId, input.sessionId, input.userId])).rows[0]
  if (!parent || String(parent.rootTaskId ?? parent.id) !== input.rootTaskId || String(parent.turnId ?? "") !== input.turnId
    || !ACTIVE_TASKS.has(String(parent.status))) return null
  const step = (await client.query<Row>(`SELECT "taskId" FROM "agent_steps"
    WHERE "id" = $1 AND "turnId" = $2 AND "sessionId" = $3 AND "status" IN ('running', 'waiting_for_tool')
      AND ("taskId" = $4 OR "taskId" IS NULL)`, [input.stepId, input.turnId, input.sessionId, input.rootTaskId])).rows[0]
  if (!step) return null
  const targets = await client.query<Row>(`SELECT task."id", task."rootTaskId", task."turnId"
    FROM "sub_agent_tasks" AS task JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
    WHERE task."id" = ANY($1::text[]) AND task."sessionId" = $2 AND session."userId" = $3
      AND session."status" NOT IN ('aborted', 'archived')`, [input.targetTaskIds, input.sessionId, input.userId])
  if (targets.rows.length !== input.targetTaskIds.length || targets.rows.some(target =>
    String(target.rootTaskId ?? target.id) !== input.rootTaskId || String(target.turnId ?? "") !== input.turnId)) return null
  const waits = await client.query<Row>(`SELECT wait."id", wait."userId", wait."sessionId", wait."turnId", wait."parentTaskId",
      wait."stepId", wait."idempotencyKey", wait."targetTaskIds", wait."mode", wait."status", wait."deadlineAt", wait."createdAt", wait."result"->'request' AS "request"
    FROM "agent_wait_conditions" AS wait JOIN "agent_sessions" AS session ON session."id" = wait."sessionId"
    WHERE wait."parentTaskId" = $1 AND wait."idempotencyKey" = $2 AND wait."userId" = $3 AND wait."sessionId" = $4
      AND wait."turnId" = $5 AND wait."stepId" = $6 AND session."userId" = $3
      AND session."status" NOT IN ('aborted', 'archived')`,
  [input.rootTaskId, input.idempotencyKey, input.userId, input.sessionId, input.turnId, input.stepId])
  const row = waits.rows[0]
  if (!row || waits.rows.length !== 1 || !["waiting", "ready", "timed_out", "interrupted"].includes(String(row.status))
    || String(row.idempotencyKey) !== input.idempotencyKey || !matchesReplay({ ...row, result: { request: row.request } }, input)) return null
  return { waitId: String(row.id), status: row.status as DurableWaitControl["status"] }
}

/** The store's waitReplay matcher is injected so the read cannot drift from idempotency semantics. */
export function createPgDurableWaitControlReader(pool: Pool, matchesReplay: DurableWaitReplayMatcher): DurableWaitControlReader {
  return { async readByInvocation(input) {
    const client = await pool.connect()
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY")
      await client.query("SELECT set_config('app.user_id', $1, true)", [input.userId])
      const control = await read(client, input, matchesReplay)
      await client.query("COMMIT")
      return control
    } catch (error: unknown) {
      await client.query("ROLLBACK").catch(() => undefined)
      throw error
    } finally { client.release() }
  } }
}
