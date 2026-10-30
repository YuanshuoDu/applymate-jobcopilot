import type pg from "pg"

import { assertLease, DurableSubagentWaitError } from "./durable-subagent-wait-store.js"
import { validatedConsumedWaitOutcome } from "./child-resume-consumed-wait.js"
import { inspectChildWaitSourceLifecycle, reconcileChildWaitSourceLifecycle } from "./child-resume-source-wait-lifecycle.js"
import type { SubagentLease } from "./types.js"

type Lease = Pick<SubagentLease, "id" | "userId" | "sessionId" | "turnId" | "rootTaskId" | "ownerId" | "leaseOwner"
  | "attemptCount" | "leaseExpiresAt" | "interruptRequestedAt" | "status" | "signal">
type Row = Record<string, unknown>
const MAX_CONSUMED_WAITS = 256
const TERMINAL = new Set(["completed", "failed", "interrupted", "cancelled", "closed"])

function fail(message: string): never { throw new DurableSubagentWaitError("wait_scope_error", message) }
function text(value: unknown): value is string { return typeof value === "string" && !!value.trim() && value === value.trim() }
function ids(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.length > 0 && value.length <= 8
    && value.every(text) && new Set(value).size === value.length ? value as string[] : undefined
}
function sameIds(left: readonly string[], right: readonly string[]): boolean {
  const sortedLeft = [...left].sort(), sortedRight = [...right].sort()
  return sortedLeft.length === sortedRight.length && sortedLeft.every((id, index) => id === sortedRight[index])
}

/** Repairs only exact legacy consumed waits, before either read-only resume path runs. */
export async function repairConsumedChildWaitSources(pool: pg.Pool, lease: Lease, now = new Date()): Promise<number> {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime()) || lease.status !== "running" || lease.leaseOwner !== lease.ownerId
    || lease.interruptRequestedAt !== null || lease.signal.aborted || !Number.isSafeInteger(lease.attemptCount) || lease.attemptCount < 1) {
    fail("Current child lease is unavailable for consumed wait repair")
  }
  const client = await pool.connect()
  let committed = false
  try {
    await client.query("BEGIN")
    await client.query("SELECT set_config('app.user_id', $1, true)", [lease.userId])
    const session = (await client.query<Row>(`SELECT "id" FROM "agent_sessions"
      WHERE "id" = $1 AND "userId" = $2 AND "status" NOT IN ('aborted', 'archived') FOR UPDATE`, [lease.sessionId, lease.userId])).rows[0]
    if (!session) fail("Session is unavailable for consumed wait repair")
    const task = (await client.query<Row>(`SELECT task."id", session."userId" AS "userId", task."sessionId", task."turnId", task."rootTaskId", task."parentTaskId", task."status", task."attemptCount", task."leaseOwner", task."leaseExpiresAt", task."interruptRequestedAt", turn."status" AS "turnStatus", root."status" AS "rootStatus"
      FROM "sub_agent_tasks" AS task JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
      JOIN "agent_turns" AS turn ON turn."id" = task."turnId" AND turn."sessionId" = task."sessionId" AND turn."userId" = session."userId"
      JOIN "sub_agent_tasks" AS root ON root."id" = task."rootTaskId" AND root."sessionId" = task."sessionId" AND root."turnId" = task."turnId"
      WHERE task."id" = $1 AND task."sessionId" = $2 AND task."turnId" = $3 AND task."rootTaskId" = $4
        AND session."userId" = $5 AND session."status" NOT IN ('aborted', 'archived') AND turn."status" NOT IN ('completed', 'failed', 'interrupted', 'cancelled')
        AND root."status" NOT IN ('completed', 'failed', 'interrupted', 'cancelled', 'closed') FOR UPDATE OF task`,
    [lease.id, lease.sessionId, lease.turnId, lease.rootTaskId, lease.userId])).rows[0]
    if (!task || !task.parentTaskId) fail("Current child task is unavailable for consumed wait repair")
    assertLease(task, lease, now)

    const candidates = (await client.query<Row>(`SELECT "id", "stepId" FROM "agent_wait_conditions"
      WHERE "parentTaskId" = $1 AND "consumedAt" IS NOT NULL ORDER BY "createdAt" ASC, "id" ASC LIMIT $2`,
    [lease.id, MAX_CONSUMED_WAITS + 1])).rows
    if (candidates.length > MAX_CONSUMED_WAITS) fail("Consumed child wait repair limit exceeded")
    const seenWaits = new Set<string>(), seenSteps = new Set<string>(), seenCalls = new Set<string>()
    let repaired = 0
    for (const candidate of candidates) {
      const waitId = text(candidate.id) ? candidate.id : "", stepId = text(candidate.stepId) ? candidate.stepId : ""
      if (!waitId || !stepId || seenWaits.has(waitId) || seenSteps.has(stepId)) fail("Consumed child wait identity is ambiguous")
      seenWaits.add(waitId); seenSteps.add(stepId)
      const step = (await client.query<Row>(`SELECT "id", "sessionId", "turnId", "taskId", "attempt", "ordinal", "status"
        FROM "agent_steps" WHERE "id" = $1 FOR UPDATE`, [stepId])).rows[0]
      const sourceAttempt = Number(step?.attempt), ordinal = Number(step?.ordinal)
      if (!step || step.id !== stepId || step.sessionId !== lease.sessionId || step.turnId !== lease.turnId || step.taskId !== lease.id
        || !Number.isSafeInteger(sourceAttempt) || sourceAttempt < 1 || sourceAttempt > lease.attemptCount
        || !Number.isSafeInteger(ordinal) || ordinal < 0 || !["waiting_for_tool", "completed"].includes(String(step.status))) {
        fail("Consumed child wait source step is invalid")
      }
      const continuation = (await client.query<Row>(`SELECT "id", "ordinal" FROM "agent_steps"
        WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3 AND "attempt" = $4 AND "ordinal" > $5
        ORDER BY "ordinal" ASC, "id" ASC LIMIT 2 FOR UPDATE`, [lease.sessionId, lease.turnId, lease.id, sourceAttempt, ordinal])).rows
      if (continuation.length === 0 || continuation.length > 1 && Number(continuation[0]!.ordinal) === Number(continuation[1]!.ordinal)) {
        fail("Consumed child wait continuation is missing or ambiguous")
      }
      const wait = (await client.query<Row>(`SELECT "id", "userId", "sessionId", "turnId", "parentTaskId", "stepId", "idempotencyKey", "targetTaskIds", "mode", "status", "deadlineAt", "matchedTaskIds", "result", "suspendedAt", "consumedAt"
        FROM "agent_wait_conditions" WHERE "id" = $1 FOR UPDATE`, [waitId])).rows[0]
      if (!wait || wait.id !== waitId || wait.stepId !== stepId || wait.userId !== lease.userId || wait.sessionId !== lease.sessionId
        || wait.turnId !== lease.turnId || wait.parentTaskId !== lease.id || wait.consumedAt === null || wait.consumedAt === undefined
        || wait.suspendedAt === null || wait.suspendedAt === undefined || !["ready", "timed_out"].includes(String(wait.status))
        || !["any", "all"].includes(String(wait.mode))) fail("Consumed child wait receipt is outside the current scope")
      const targetIds = ids(wait.targetTaskIds)
      if (!targetIds || targetIds.includes(lease.id)) fail("Consumed child wait targets are invalid")
      const targets = (await client.query<Row>(`SELECT task."id", task."parentTaskId", task."rootTaskId", task."sessionId", task."turnId", session."userId"
        FROM "sub_agent_tasks" AS task JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
        WHERE task."id" = ANY($1::text[]) AND task."parentTaskId" = $2 AND task."rootTaskId" = $3
          AND task."sessionId" = $4 AND task."turnId" = $5 AND session."userId" = $6 AND session."status" NOT IN ('aborted', 'archived')
        FOR SHARE OF task`, [targetIds, lease.id, lease.rootTaskId, lease.sessionId, lease.turnId, lease.userId])).rows
      if (targets.length !== targetIds.length || !sameIds(targets.map(row => String(row.id)), targetIds)) fail("Consumed child wait targets changed scope")
      const output = validatedConsumedWaitOutcome({ ...wait, waitId, waitResult: wait.result })
      const lifecycle = await inspectChildWaitSourceLifecycle(client, lease, wait, stepId, output)
      if (seenCalls.has(lifecycle.toolCallId)) fail("Consumed child wait source call is ambiguous")
      seenCalls.add(lifecycle.toolCallId)
      if (lifecycle.state === "unreconciled") {
        const repairedLifecycle = await reconcileChildWaitSourceLifecycle(pool, client, lease, wait, stepId, output, now)
        if (repairedLifecycle.state !== "recovered" || repairedLifecycle.sourceAttempt !== sourceAttempt) fail("Consumed child wait repair was not durable")
        repaired += 1
      } else if (lifecycle.state !== "waiting" && lifecycle.state !== "recovered") {
        fail("Consumed child wait source lifecycle is invalid")
      }
    }
    const stillOwned = (await client.query<Row>(`SELECT "id" FROM "sub_agent_tasks"
      WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "rootTaskId" = $4 AND "leaseOwner" = $5
        AND "attemptCount" = $6 AND "status" = 'running' AND "interruptRequestedAt" IS NULL AND "leaseExpiresAt" > clock_timestamp() FOR UPDATE`,
    [lease.id, lease.sessionId, lease.turnId, lease.rootTaskId, lease.ownerId, lease.attemptCount])).rows[0]
    if (!stillOwned || lease.signal.aborted) fail("Current child lease expired during consumed wait repair")
    await client.query("COMMIT")
    committed = true
    return repaired
  } catch (error: unknown) {
    if (!committed) await client.query("ROLLBACK").catch(() => undefined)
    throw error
  } finally { client.release() }
}
