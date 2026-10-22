import { randomUUID } from "node:crypto"
import type pg from "pg"
import type { SubagentLease } from "./types.js"
import { assertLease, dateValue, DurableSubagentWaitError, object, parseIds, projectDurableSubagentWait, safeSubagentWaitJson, type DurableSubagentWaitStatus } from "./durable-subagent-wait-store.js"
import { persistGraphTransition, prepareGraphTransition } from "./task-graph-pg-lifecycle.js"

type Client = Pick<pg.PoolClient, "query">
type Row = Record<string, unknown>
const OPEN_SESSION = `session."status" NOT IN ('aborted', 'archived')`
const TERMINAL = new Set(["completed", "failed", "interrupted", "cancelled", "closed", "passed", "skipped"])
export type DurableSubagentWaitHandoffLease = Pick<SubagentLease, "id" | "userId" | "sessionId" | "turnId" | "rootTaskId" | "ownerId" | "attemptCount" | "leaseExpiresAt">
export type DurableSubagentWaitHandoffInput = Readonly<{ lease: DurableSubagentWaitHandoffLease; now: Date }>
export type DurableSubagentWaitHandoffResult = Readonly<{
  waitId: string; handoff: "suspended" | "queued"; waitStatus: DurableSubagentWaitStatus; idempotent: boolean
}>
export type DurableSubagentWaitGraphHandoffResult = DurableSubagentWaitHandoffResult | Readonly<{ blocked: true }> | undefined

function row(value: Row | undefined, message: string): Row {
  if (!value) throw new DurableSubagentWaitError("wait_scope_error", message)
  return value
}
function sameIds(left: readonly string[], right: readonly string[]): boolean { return [...left].sort().join("\u0000") === [...right].sort().join("\u0000") }
function exactIds(value: unknown, expected: readonly string[]): boolean {
  return Array.isArray(value) && value.length === expected.length && value.every(id => typeof id === "string") && sameIds(value, expected)
}
async function validateWaitCall(client: Client, lease: DurableSubagentWaitHandoffLease, wait: Row, ids: readonly string[]): Promise<void> {
  const rows = (await client.query<Row>(`SELECT call."status", call."content" FROM "agent_items" AS call
    JOIN "agent_sessions" AS session ON session."id" = call."sessionId" AND session."userId" = $5 AND ${OPEN_SESSION}
    WHERE call."sessionId" = $1 AND call."turnId" = $2 AND call."taskId" = $3 AND call."stepId" = $4
      AND call."type" = 'tool_call' AND call."content"->>'toolName' = 'wait_subagents'
    ORDER BY call."createdAt" DESC, call."id" DESC LIMIT 2 FOR SHARE OF call`,
  [lease.sessionId, lease.turnId, lease.id, wait.stepId, lease.userId])).rows
  const call = object(rows[0]?.content), input = object(call.input), request = object(object(wait.result).request)
  const timeout = input.timeoutMs
  if (rows.length !== 1 || !["started", "completed"].includes(String(rows[0]?.status))
    || typeof call.toolCallId !== "string" || !call.toolCallId.trim() || call.toolName !== "wait_subagents" || call.toolVersion !== "1"
    || Object.keys(input).sort().join(",") !== "idempotencyKey,mode,taskIds,timeoutMs"
    || input.idempotencyKey !== wait.idempotencyKey || input.mode !== wait.mode || !Number.isSafeInteger(timeout)
    || Number(timeout) < 1 || Number(timeout) > 24 * 60 * 60 * 1_000 || !exactIds(input.taskIds, ids)
    || Object.keys(request).sort().join(",") !== "mode,targetTaskIds,timeoutMs" || request.mode !== input.mode
    || request.timeoutMs !== timeout || !exactIds(request.targetTaskIds, ids)) {
    throw new DurableSubagentWaitError("wait_scope_error", "Persisted wait call does not match the registered condition")
  }
}
function dispatchOwner(ownerId?: string): string { return `${ownerId ? `${ownerId}-` : ""}child-wait-${randomUUID()}` }
async function dispatch(client: Client, task: Row, ownerId?: string): Promise<void> {
  const taskId = String(task.id), sessionId = String(task.sessionId)
  const payload = { taskId, sessionId, rootTaskId: String(task.rootTaskId), ownerId: dispatchOwner(ownerId) }
  const result = await client.query(`INSERT INTO "agent_outbox" ("id", "topic", "aggregateId", "idempotencyKey", "payload")
    SELECT $1, 'agent.subagent.dispatch', $2, $3, $4::jsonb
    WHERE EXISTS (SELECT 1 FROM "agent_sessions" AS session WHERE session."id" = $2 AND ${OPEN_SESSION})
    ON CONFLICT ("idempotencyKey") DO UPDATE SET "payload" = EXCLUDED."payload", "publishedAt" = NULL,
      "lastError" = NULL
    WHERE "agent_outbox"."topic" = 'agent.subagent.dispatch' AND "agent_outbox"."aggregateId" = EXCLUDED."aggregateId'
    RETURNING "idempotencyKey"`, [randomUUID(), sessionId, `subagent-dispatch:${taskId}`, JSON.stringify(payload)])
  if (result.rowCount !== 1) throw new DurableSubagentWaitError("wait_scope_error", "Child dispatch could not be fenced")
}

/** Atomically persists the wait handoff and releases or queues its exact child task. */
export async function handoffDurableSubagentWait(client: Client, input: DurableSubagentWaitHandoffInput): Promise<DurableSubagentWaitHandoffResult | undefined> {
  const lease = input.lease; const now = input.now
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new DurableSubagentWaitError("wait_invalid", "Handoff clock is invalid")
  const session = row((await client.query<Row>(`SELECT "id", "userId", "status" FROM "agent_sessions"
    WHERE "id" = $1 AND "userId" = $2 AND "status" NOT IN ('aborted', 'archived') FOR UPDATE`, [lease.sessionId, lease.userId])).rows[0], "Session is unavailable")
  if (String(session.id) !== lease.sessionId) throw new DurableSubagentWaitError("wait_scope_error", "Session is outside the wait scope")
  const task = row((await client.query<Row>(`SELECT task."id", task."sessionId", task."turnId", task."rootTaskId", task."status", task."attemptCount", task."leaseOwner", task."leaseExpiresAt", task."interruptRequestedAt", session."userId" AS "userId", turn."status" AS "turnStatus", root."status" AS "rootStatus"
    FROM "sub_agent_tasks" AS task JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
    JOIN "agent_turns" AS turn ON turn."id" = task."turnId" AND turn."sessionId" = task."sessionId"
    JOIN "sub_agent_tasks" AS root ON root."id" = task."rootTaskId" AND root."sessionId" = task."sessionId" AND root."turnId" = task."turnId"
    WHERE task."id" = $1 AND task."sessionId" = $2 AND task."turnId" = $3 AND task."rootTaskId" = $4 AND session."userId" = $5
      AND ${OPEN_SESSION} FOR UPDATE OF task`, [lease.id, lease.sessionId, lease.turnId, lease.rootTaskId, lease.userId])).rows[0], "Child task is unavailable")
  if (task.status === "running") assertLease(task, lease, now)
  else if (!["waiting", "queued"].includes(String(task.status)) || task.leaseOwner !== null || task.leaseExpiresAt !== null
    || Number(task.attemptCount) !== lease.attemptCount || task.interruptRequestedAt !== null) throw new DurableSubagentWaitError("wait_scope_error", "Child task lease is stale")
  if (String(task.turnStatus).match(/^(completed|failed|interrupted|cancelled|closed)$/) || String(task.rootStatus).match(/^(completed|failed|interrupted|cancelled|closed)$/)) throw new DurableSubagentWaitError("wait_scope_error", "Child task tree is closed")
  const waitRows = (await client.query<Row>(`SELECT wait."id", wait."userId", wait."sessionId", wait."turnId", wait."parentTaskId", wait."stepId", wait."idempotencyKey", wait."targetTaskIds", wait."mode", wait."status", wait."deadlineAt", wait."matchedTaskIds", wait."result", wait."suspendedAt", wait."consumedAt", step."attempt", step."ordinal", step."status" AS "stepStatus",
      (SELECT MAX(current."ordinal") FROM "agent_steps" AS current WHERE current."sessionId" = step."sessionId" AND current."turnId" = step."turnId" AND current."taskId" = step."taskId" AND current."attempt" = step."attempt") AS "latestOrdinal"
    FROM "agent_wait_conditions" AS wait JOIN "agent_steps" AS step ON step."id" = wait."stepId" AND step."sessionId" = wait."sessionId" AND step."turnId" = wait."turnId" AND step."taskId" = wait."parentTaskId"
    WHERE wait."parentTaskId" = $1 AND wait."userId" = $2 AND wait."sessionId" = $3 AND wait."turnId" = $4
      AND step."attempt" = $5 AND wait."consumedAt" IS NULL
      AND EXISTS (SELECT 1 FROM "agent_sessions" AS session WHERE session."id" = wait."sessionId" AND ${OPEN_SESSION})
    ORDER BY wait."createdAt" DESC, wait."id" DESC LIMIT 2 FOR UPDATE OF wait, step`, [lease.id, lease.userId, lease.sessionId, lease.turnId, lease.attemptCount])).rows
  if (waitRows.length === 0) return undefined
  if (waitRows.length !== 1) throw new DurableSubagentWaitError("wait_conflict", "More than one child wait matches the current attempt")
  const wait = waitRows[0]
  if (String(wait.parentTaskId) !== lease.id || String(wait.stepId).trim() === "" || Number(wait.attempt) !== lease.attemptCount
    || Number(wait.ordinal) !== Number(wait.latestOrdinal) || wait.stepStatus !== "waiting_for_tool" || !["waiting", "ready", "timed_out"].includes(String(wait.status))) {
    throw new DurableSubagentWaitError("wait_scope_error", "Wait step is stale or outside the current child attempt")
  }
  const targetIds = parseIds(wait.targetTaskIds)
  if (!targetIds.length || targetIds.length > 8 || new Set(targetIds).size !== targetIds.length
    || !(wait.mode === "any" || wait.mode === "all")) throw new DurableSubagentWaitError("wait_scope_error", "Wait targets are invalid")
  await validateWaitCall(client, lease, wait, targetIds)
  const targets = (await client.query<Row>(`SELECT task."id", task."parentTaskId", task."rootTaskId", task."turnId", task."sessionId", task."status", task."role", task."result", task."failureReason"
    FROM "sub_agent_tasks" AS task JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
    WHERE task."id" = ANY($1::text[]) AND task."sessionId" = $2 AND task."turnId" = $3 AND task."rootTaskId" = $4
      AND session."userId" = $5 AND task."parentTaskId" = $6 AND ${OPEN_SESSION}`,
  [targetIds, lease.sessionId, lease.turnId, lease.rootTaskId, lease.userId, lease.id])).rows
  if (targets.length !== targetIds.length || targets.some(target => String(target.parentTaskId) !== lease.id)) throw new DurableSubagentWaitError("wait_scope_error", "Wait target set changed")
  const matched = targets.filter(target => TERMINAL.has(String(target.status))).map(target => String(target.id)).sort()
  const deadline = dateValue(wait.deadlineAt, "deadlineAt")
  const isReady = wait.mode === "any" ? matched.length > 0 : matched.length === targetIds.length
  const suspended = wait.suspendedAt !== null && wait.suspendedAt !== undefined
  if (suspended && task.status === "waiting" && wait.status === "waiting") {
    return { waitId: String(wait.id), handoff: "suspended", waitStatus: "waiting", idempotent: true }
  }
  if (suspended && task.status === "queued" && (wait.status === "ready" && isReady || wait.status === "timed_out" && now >= deadline)
    && JSON.stringify([...parseIds(wait.matchedTaskIds)].sort()) === JSON.stringify(matched)) {
    return { waitId: String(wait.id), handoff: "queued", waitStatus: wait.status, idempotent: true }
  }
  if (task.status !== "running" || suspended) throw new DurableSubagentWaitError("wait_scope_error", "Child wait handoff is not owned")
  const priorStatus = String(wait.status)
  const status: DurableSubagentWaitStatus = priorStatus === "ready" || priorStatus === "timed_out"
    ? priorStatus
    : now >= deadline ? "timed_out" : isReady ? "ready" : "waiting"
  if (status === "ready" && !isReady || status === "timed_out" && now < deadline) throw new DurableSubagentWaitError("wait_scope_error", "Resolved child wait no longer matches its targets")
  const result = object(wait.result)
  const current = projectDurableSubagentWait({ ...wait, targetTaskIds: targetIds, deadlineAt: deadline }, targets, status, matched)
  const persistedResult = safeSubagentWaitJson({ ...result, outcome: current }, 16_384)
  const waitUpdated = await client.query(`UPDATE "agent_wait_conditions" SET "status" = $1, "matchedTaskIds" = $2::jsonb, "result" = $3::jsonb,
    "suspendedAt" = COALESCE("suspendedAt", $4), "resolvedAt" = CASE WHEN $1 = 'waiting' THEN "resolvedAt" ELSE COALESCE("resolvedAt", $4) END, "updatedAt" = $4
    WHERE "id" = $5 AND "parentTaskId" = $6 AND "stepId" = $7 AND "consumedAt" IS NULL AND "status" IN ('waiting', 'ready', 'timed_out')
      AND EXISTS (SELECT 1 FROM "agent_sessions" AS session WHERE session."id" = "agent_wait_conditions"."sessionId" AND ${OPEN_SESSION})`,
  [status, JSON.stringify(matched), JSON.stringify(persistedResult), now, wait.id, lease.id, wait.stepId])
  if (waitUpdated.rowCount !== 1) throw new DurableSubagentWaitError("wait_scope_error", "Wait condition changed during handoff")
  const taskStatus = status === "waiting" ? "waiting" : "queued"
  const updated = await client.query(`UPDATE "sub_agent_tasks" SET "status" = $1, "leaseOwner" = NULL, "leaseExpiresAt" = NULL,
    "nextAttemptAt" = NULL, "completedAt" = NULL, "updatedAt" = $2
    WHERE "id" = $3 AND "sessionId" = $4 AND "turnId" = $5 AND "rootTaskId" = $6 AND "status" = 'running'
      AND "leaseOwner" = $7 AND "attemptCount" = $8 AND "leaseExpiresAt" = $9
      AND "leaseExpiresAt" > clock_timestamp() AND "interruptRequestedAt" IS NULL
      AND EXISTS (SELECT 1 FROM "agent_sessions" AS session WHERE session."id" = "sub_agent_tasks"."sessionId" AND ${OPEN_SESSION})`,
  [taskStatus, now, lease.id, lease.sessionId, lease.turnId, lease.rootTaskId, lease.ownerId, lease.attemptCount, lease.leaseExpiresAt])
  if (updated.rowCount !== 1) throw new DurableSubagentWaitError("wait_scope_error", "Child task lease was fenced during handoff")
  if (status !== "waiting") await dispatch(client, task, input.lease.ownerId)
  return { waitId: String(wait.id), handoff: status === "waiting" ? "suspended" : "queued", waitStatus: status, idempotent: false }
}

/** Repairs only the registered wait left between tool execution and the ordinary finish handoff. */
export async function recoverExpiredDurableSubagentWaitWithGraph(
  client: pg.PoolClient,
  input: DurableSubagentWaitHandoffInput,
): Promise<DurableSubagentWaitGraphHandoffResult> {
  const lease = input.lease, now = input.now
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new DurableSubagentWaitError("wait_invalid", "Handoff clock is invalid")
  const task = (await client.query<Row>(`SELECT task."id", task."parentTaskId", task."sessionId", task."turnId", task."rootTaskId", task."status", task."attemptCount", task."leaseOwner", task."leaseExpiresAt", task."interruptRequestedAt", session."userId" AS "userId", turn."status" AS "turnStatus", root."status" AS "rootStatus"
    FROM "sub_agent_tasks" AS task JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
    JOIN "agent_turns" AS turn ON turn."id" = task."turnId" AND turn."sessionId" = task."sessionId"
    JOIN "sub_agent_tasks" AS root ON root."id" = task."rootTaskId" AND root."sessionId" = task."sessionId" AND root."turnId" = task."turnId"
    WHERE task."id" = $1 AND task."sessionId" = $2 AND task."turnId" = $3 AND task."rootTaskId" = $4 AND session."userId" = $5
      AND task."status" = 'running' AND task."leaseOwner" = $6 AND task."attemptCount" = $7 AND task."leaseExpiresAt" = $8
      AND task."leaseExpiresAt" <= clock_timestamp() AND task."interruptRequestedAt" IS NULL AND task."parentTaskId" IS NOT NULL
      AND turn."status" NOT IN ('completed', 'failed', 'interrupted', 'cancelled', 'closed')
      AND root."status" NOT IN ('completed', 'failed', 'interrupted', 'cancelled', 'closed') AND ${OPEN_SESSION} FOR UPDATE OF task`,
  [lease.id, lease.sessionId, lease.turnId, lease.rootTaskId, lease.userId, lease.ownerId, lease.attemptCount, lease.leaseExpiresAt])).rows[0]
  if (!task) return undefined
  const waits = (await client.query<Row>(`SELECT wait."id", wait."userId", wait."sessionId", wait."turnId", wait."parentTaskId", wait."stepId", wait."idempotencyKey", wait."targetTaskIds", wait."mode", wait."status", wait."deadlineAt", wait."matchedTaskIds", wait."result", wait."suspendedAt", wait."consumedAt", step."attempt", step."ordinal", step."status" AS "stepStatus",
      (SELECT MAX(current."ordinal") FROM "agent_steps" AS current WHERE current."sessionId" = step."sessionId" AND current."turnId" = step."turnId" AND current."taskId" = step."taskId" AND current."attempt" = step."attempt") AS "latestOrdinal"
    FROM "agent_wait_conditions" AS wait JOIN "agent_steps" AS step ON step."id" = wait."stepId" AND step."sessionId" = wait."sessionId" AND step."turnId" = wait."turnId" AND step."taskId" = wait."parentTaskId"
    WHERE wait."parentTaskId" = $1 AND wait."userId" = $2 AND wait."sessionId" = $3 AND wait."turnId" = $4 AND wait."status" = 'waiting'
      AND wait."suspendedAt" IS NULL AND wait."consumedAt" IS NULL AND step."attempt" = $5 AND step."status" = 'waiting_for_tool'
      AND step."ordinal" = (SELECT MAX(current."ordinal") FROM "agent_steps" AS current WHERE current."sessionId" = step."sessionId" AND current."turnId" = step."turnId" AND current."taskId" = step."taskId" AND current."attempt" = step."attempt")
      AND EXISTS (SELECT 1 FROM "agent_sessions" AS session WHERE session."id" = wait."sessionId" AND session."userId" = wait."userId" AND ${OPEN_SESSION})
    ORDER BY wait."createdAt" DESC, wait."id" DESC LIMIT 2 FOR UPDATE OF wait, step`,
  [lease.id, lease.userId, lease.sessionId, lease.turnId, lease.attemptCount])).rows
  if (!waits.length) return undefined
  if (waits.length !== 1) throw new DurableSubagentWaitError("wait_conflict", "Multiple pending registrations match the expired child attempt")
  const wait = waits[0], ids = parseIds(wait.targetTaskIds)
  if (Number(wait.attempt) !== lease.attemptCount || Number(wait.ordinal) !== Number(wait.latestOrdinal) || !String(wait.stepId).trim()
    || !(wait.mode === "any" || wait.mode === "all") || !ids.length || ids.length > 8 || new Set(ids).size !== ids.length) {
    throw new DurableSubagentWaitError("wait_scope_error", "Pending child wait is outside its current attempt")
  }
  try { await validateWaitCall(client, lease, wait, ids) }
  catch (error: unknown) {
    if (error instanceof DurableSubagentWaitError && error.code === "wait_scope_error") return undefined
    throw error
  }
  const targets = (await client.query<Row>(`SELECT task."id", task."parentTaskId", task."rootTaskId", task."turnId", task."sessionId", task."status", task."role", task."result", task."failureReason"
    FROM "sub_agent_tasks" AS task JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
    WHERE task."id" = ANY($1::text[]) AND task."sessionId" = $2 AND task."turnId" = $3 AND task."rootTaskId" = $4
      AND session."userId" = $5 AND task."parentTaskId" = $6 AND ${OPEN_SESSION} FOR SHARE OF task`,
  [ids, lease.sessionId, lease.turnId, lease.rootTaskId, lease.userId, lease.id])).rows
  if (targets.length !== ids.length || targets.some(target => String(target.parentTaskId) !== lease.id)) throw new DurableSubagentWaitError("wait_scope_error", "Pending wait targets changed scope")
  const matched = targets.filter(target => TERMINAL.has(String(target.status))).map(target => String(target.id)).sort()
  const deadline = dateValue(wait.deadlineAt, "deadlineAt"), ready = wait.mode === "any" ? matched.length > 0 : matched.length === ids.length
  const status: DurableSubagentWaitStatus = now >= deadline ? "timed_out" : ready ? "ready" : "waiting"
  const result = object(wait.result), outcome = projectDurableSubagentWait({ ...wait, targetTaskIds: ids, deadlineAt: deadline }, targets, status, matched)
  const persisted = safeSubagentWaitJson({ ...result, outcome }, 16_384)
  const graphWaiting = await prepareGraphTransition(client, { taskId: lease.id, sessionId: lease.sessionId, type: "task.waiting", attemptCount: lease.attemptCount })
  if (graphWaiting && "blocked" in graphWaiting) return { blocked: true }
  const updatedWait = await client.query(`UPDATE "agent_wait_conditions" SET "status" = $1, "matchedTaskIds" = $2::jsonb, "result" = $3::jsonb,
      "suspendedAt" = $4, "resolvedAt" = CASE WHEN $1 = 'waiting' THEN "resolvedAt" ELSE COALESCE("resolvedAt", $4) END, "updatedAt" = $4
    WHERE "id" = $5 AND "userId" = $6 AND "sessionId" = $7 AND "turnId" = $8 AND "parentTaskId" = $9 AND "stepId" = $10
      AND "status" = 'waiting' AND "suspendedAt" IS NULL AND "consumedAt" IS NULL`,
  [status, JSON.stringify(matched), JSON.stringify(persisted), now, wait.id, lease.userId, lease.sessionId, lease.turnId, lease.id, wait.stepId])
  if (updatedWait.rowCount !== 1) throw new DurableSubagentWaitError("wait_scope_error", "Pending child wait changed during recovery")
  const taskStatus = status === "waiting" ? "waiting" : "queued"
  const updatedTask = await client.query(`UPDATE "sub_agent_tasks" SET "status" = $1, "leaseOwner" = NULL, "leaseExpiresAt" = NULL,
      "nextAttemptAt" = NULL, "completedAt" = NULL, "updatedAt" = $2
    WHERE "id" = $3 AND "sessionId" = $4 AND "turnId" = $5 AND "rootTaskId" = $6 AND "status" = 'running'
      AND "leaseOwner" = $7 AND "attemptCount" = $8 AND "leaseExpiresAt" = $9 AND "leaseExpiresAt" <= clock_timestamp()
      AND "interruptRequestedAt" IS NULL AND EXISTS (SELECT 1 FROM "agent_sessions" AS session WHERE session."id" = "sub_agent_tasks"."sessionId" AND ${OPEN_SESSION})`,
  [taskStatus, now, lease.id, lease.sessionId, lease.turnId, lease.rootTaskId, lease.ownerId, lease.attemptCount, lease.leaseExpiresAt])
  if (updatedTask.rowCount !== 1) throw new DurableSubagentWaitError("wait_scope_error", "Expired child lease changed during wait recovery")
  if (taskStatus === "queued") await dispatch(client, task, lease.ownerId)
  if (graphWaiting) await persistGraphTransition(client, graphWaiting, now)
  if (taskStatus === "queued" && graphWaiting) {
    const graphQueued = await prepareGraphTransition(client, { taskId: lease.id, sessionId: lease.sessionId, type: "task.queued", attemptCount: lease.attemptCount })
    if (!graphQueued || "blocked" in graphQueued) throw new Error("child_wait_graph_resume_blocked")
    await persistGraphTransition(client, graphQueued, now)
  }
  return { waitId: String(wait.id), handoff: taskStatus === "waiting" ? "suspended" : "queued", waitStatus: status, idempotent: false }
}

/** Couples the wait handoff with its TaskGraph transitions inside the caller's transaction. */
export async function handoffDurableSubagentWaitWithGraph(client: pg.PoolClient, input: DurableSubagentWaitHandoffInput): Promise<DurableSubagentWaitGraphHandoffResult> {
  const graphWaiting = await prepareGraphTransition(client, {
    taskId: input.lease.id, sessionId: input.lease.sessionId, type: "task.waiting", attemptCount: input.lease.attemptCount,
  })
  if (graphWaiting && "blocked" in graphWaiting) return { blocked: true }
  const handoff = await handoffDurableSubagentWait(client, input)
  if (!handoff) return undefined
  if (graphWaiting) await persistGraphTransition(client, graphWaiting, input.now)
  if (handoff.handoff === "queued" && graphWaiting) {
    const graphQueued = await prepareGraphTransition(client, {
      taskId: input.lease.id, sessionId: input.lease.sessionId, type: "task.queued", attemptCount: input.lease.attemptCount,
    })
    if (!graphQueued || "blocked" in graphQueued) throw new Error("child_wait_graph_resume_blocked")
    await persistGraphTransition(client, graphQueued, input.now)
  }
  return handoff
}
