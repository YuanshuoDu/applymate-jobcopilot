import { createHash } from "node:crypto"
import type pg from "pg"
import { TaskGraphCommandError } from "./task-graph-command-port.js"
import { appendInternalAcceptedInterrupt } from "./task-interrupt-outbox.js"
import { readTaskGraphConfirmedLocationSteer } from "./task-graph-confirmed-location-steer.js"
import { readSteeringReconciliationState } from "./steering-reconciliation-read.js"
import { lockTaskGraphScope, loadTaskGraph } from "./task-graph-pg-state.js"
import { taskGraphItemId } from "./task-graph-snapshot.js"
import { appendTaskGraphReceiptWithIdentity } from "./task-graph-pg-events.js"
import { buildTaskGraphSupersededScoutRetirementPlan } from "./task-graph-pg-scout-retirement-plan.js"
import { parseTaskGraphSupersededScoutRetirementReceipt, taskGraphScoutRetirementIdempotencyKey,
  TASK_GRAPH_SUPERSEDED_SCOUT_RETIREMENT_EVENT_TYPE, type TaskGraphScoutRetirementInput,
  type TaskGraphScoutRetirementResult, type TaskGraphSupersededScoutRetirementReceipt } from "./task-graph-scout-retirement-contract.js"
import type { Queryable } from "./pg-store-persistence.js"
import type { PgSubagentPool } from "./types.js"
import { transaction } from "./pg-store-persistence.js"

type Row = Record<string, unknown>
function unavailable(): never { throw new TaskGraphCommandError("task_graph_scout_retirement_unavailable", "The requested Scout cannot be retired") }
function id(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value }
function interruptKey(sessionId: string, taskId: string, at: string): string {
  const intentId = `internal-${createHash("sha256").update(`${sessionId}\0${taskId}\0${at}`).digest("hex")}`
  return `agent-task-interrupt:${intentId}:${taskId}:accepted`
}
function requestError(code: string, message: string, revision?: number): TaskGraphCommandError {
  return new TaskGraphCommandError(code, message, revision)
}

export function requestSupersededScoutRetirement(pool: PgSubagentPool, input: TaskGraphScoutRetirementInput): Promise<TaskGraphScoutRetirementResult> {
  return transaction(pool, client => requestInTransaction(client, input))
}

async function requestInTransaction(client: Queryable, input: TaskGraphScoutRetirementInput): Promise<TaskGraphScoutRetirementResult> {
  const { scope, taskId, expectedRevision } = input
  const idempotencyKey = taskGraphScoutRetirementIdempotencyKey(input)
  if (!idempotencyKey) unavailable()
  await client.query(`SELECT set_config('app.user_id', $1, true)`, [scope.userId])
  await lockTaskGraphScope(client, scope, true)
  const prior = await readPrior(client, input, idempotencyKey)
  if (prior) {
    await requireInterruptRequest(client, input, prior.receipt)
    return { status: "duplicate", taskId, receiptEventId: prior.id, receipt: prior.receipt }
  }
  const loaded = await loadTaskGraph(client, scope, true, { includeSourceProvenance: true, currentStepId: scope.stepId, currentStepAttempt: 1 })
  const revision = loaded.item?.revision ?? 0
  if (revision !== expectedRevision) throw requestError("revision_mismatch", "TaskGraph revision is stale", revision)
  const reconciliation = await readSteeringReconciliationState(client, scope)
  const through = reconciliation.decisionInputThroughSequence
  if (through === null) unavailable()
  const confirmed = await readTaskGraphConfirmedLocationSteer(client, {
    userId: scope.userId, sessionId: scope.sessionId, turnId: scope.turnId, rootTaskId: scope.rootTaskId,
  }, through)
  if (confirmed.kind !== "confirmed") unavailable()
  const plan = await buildTaskGraphSupersededScoutRetirementPlan({ ...input, client, loaded, reconciliation, confirmed })
  if (!plan) unavailable()
  const nodeKey = plan.nodeKey
  const task = await lockRetirementTarget(client, input)
  const stored = loaded.tasks.get(taskId)
  if (!task || !stored || task.status !== stored.status || task.role !== stored.role || task.taskType !== stored.taskType
    || Number(task.attemptCount) !== Number(stored.attemptCount) || task.failureReason !== stored.failureReason
    || task.status !== "running" || task.failureReason !== null || !Number.isSafeInteger(task.attemptCount) || Number(task.attemptCount) < 1
    || !id(task.leaseOwner) || task.interruptRequestedAt !== null || task.leaseValid !== true || task.hasChild === true) unavailable()
  const updated = await client.query<Row>(`UPDATE "sub_agent_tasks" SET "interruptRequestedAt" = clock_timestamp(), "updatedAt" = clock_timestamp()
    WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "rootTaskId" = $4 AND "parentTaskId" = $4
      AND "status" = 'running' AND "attemptCount" = $5 AND "leaseOwner" = $6 AND "interruptRequestedAt" IS NULL
      AND "leaseExpiresAt" > clock_timestamp() RETURNING "interruptRequestedAt", "attemptCount"`,
  [taskId, scope.sessionId, scope.turnId, scope.rootTaskId, task.attemptCount, task.leaseOwner])
  const requestedAt = timestamp(updated.rows[0]?.interruptRequestedAt)
  if (updated.rowCount !== 1 || !requestedAt || Number(updated.rows[0]?.attemptCount) !== Number(task.attemptCount)) {
    throw requestError("revision_mismatch", "The live Scout changed before retirement", revision)
  }
  await appendInternalAcceptedInterrupt(client, scope.userId, { sessionId: scope.sessionId, turnId: scope.turnId, taskId, interruptRequestedAt: requestedAt })
  const receipt: TaskGraphSupersededScoutRetirementReceipt = { ...plan, attempt: Number(task.attemptCount), interruptRequestedAt: requestedAt }
  const identity = await appendTaskGraphReceiptWithIdentity(client, { scope, itemId: taskGraphItemId(scope.rootTaskId), taskId,
    type: TASK_GRAPH_SUPERSEDED_SCOUT_RETIREMENT_EVENT_TYPE, actor: "system", causationId: scope.stepId,
    idempotencyKey, payload: receipt })
  return { status: "requested", taskId, receiptEventId: identity.id, receipt }
}

function timestamp(value: unknown): string | null {
  const date = value instanceof Date ? value : typeof value === "string" ? new Date(value) : null
  return date && Number.isFinite(date.getTime()) ? date.toISOString() : null
}

async function readPrior(client: Queryable, input: TaskGraphScoutRetirementInput, idempotencyKey: string): Promise<Readonly<{
  id: string; receipt: TaskGraphSupersededScoutRetirementReceipt
}> | null> {
  const { scope, taskId } = input
  const result = await client.query<Row>(`SELECT event."id", event."type", event."actor", event."itemId", event."taskId",
      event."correlationId", event."causationId", event."idempotencyKey", event."payload",
      EXISTS (SELECT 1 FROM "agent_outbox" outbox WHERE outbox."idempotencyKey" = 'agent-event:' || event."id") AS "hasOutbox"
    FROM "agent_events" event JOIN "agent_sessions" session ON session."id" = event."sessionId"
      AND session."userId" = $5 JOIN "agent_turns" turn ON turn."id" = event."turnId" AND turn."sessionId" = event."sessionId"
      AND turn."userId" = $5
    WHERE event."sessionId" = $1 AND event."turnId" = $2 AND event."idempotencyKey" = $3
      AND event."itemId" = $4 LIMIT 2`, [scope.sessionId, scope.turnId, idempotencyKey, taskGraphItemId(scope.rootTaskId), scope.userId])
  if (!result.rows.length) return null
  if (result.rows.length !== 1) throw requestError("idempotency_conflict", "Retirement command identity is ambiguous")
  const row = result.rows[0]!, receipt = parseTaskGraphSupersededScoutRetirementReceipt(row.payload,
    { sessionId: scope.sessionId, turnId: scope.turnId, rootTaskId: scope.rootTaskId, taskId })
  if (!receipt || !id(row.id) || row.type !== TASK_GRAPH_SUPERSEDED_SCOUT_RETIREMENT_EVENT_TYPE || row.actor !== "system"
    || row.itemId !== taskGraphItemId(scope.rootTaskId) || row.taskId !== taskId || row.correlationId !== scope.turnId
    || row.causationId !== scope.stepId || row.idempotencyKey !== taskGraphScoutRetirementIdempotencyKey(input) || row.hasOutbox !== false) {
    throw requestError("idempotency_conflict", "Retirement command identity conflicts with its stored receipt")
  }
  return { id: row.id, receipt }
}

async function requireInterruptRequest(client: Queryable, input: TaskGraphScoutRetirementInput,
  receipt: TaskGraphSupersededScoutRetirementReceipt): Promise<void> {
  const key = interruptKey(input.scope.sessionId, input.taskId, receipt.interruptRequestedAt)
  const result = await client.query<Row>(`SELECT "id", "type", "actor", "taskId", "idempotencyKey", "payload" FROM "agent_events"
    WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3 AND "idempotencyKey" = $4 LIMIT 2`,
  [input.scope.sessionId, input.scope.turnId, input.taskId, key])
  const event = result.rows[0]!, payload = event && typeof event.payload === "object" ? event.payload as Row : null
  if (result.rows.length !== 1 || !id(event.id) || event.type !== "task.interrupt.accepted" || event.actor !== "system"
    || event.taskId !== input.taskId || event.idempotencyKey !== key || payload?.status !== "accepted" || payload.taskId !== input.taskId) {
    throw requestError("idempotency_conflict", "The accepted interrupt request is missing")
  }
}

async function lockRetirementTarget(client: Queryable, input: TaskGraphScoutRetirementInput): Promise<Row | null> {
  const { scope, taskId } = input
  const result = await client.query<Row>(`WITH live AS MATERIALIZED (SELECT clock_timestamp() AS "at")
    SELECT task."id", task."parentTaskId", task."rootTaskId", task."status", task."role", task."taskType", task."attemptCount",
      task."leaseOwner", task."interruptRequestedAt", task."failureReason", task."leaseExpiresAt" > live."at" AS "leaseValid",
      EXISTS (SELECT 1 FROM "sub_agent_tasks" child WHERE child."sessionId" = task."sessionId"
        AND child."turnId" = task."turnId" AND child."rootTaskId" = task."rootTaskId" AND child."parentTaskId" = task."id") AS "hasChild"
    FROM live JOIN "sub_agent_tasks" task ON task."id" = $1 AND task."sessionId" = $2 AND task."turnId" = $3
      AND task."rootTaskId" = $4 AND task."parentTaskId" = $4 JOIN "agent_sessions" session
      ON session."id" = task."sessionId" AND session."userId" = $5 FOR UPDATE OF task`,
  [taskId, scope.sessionId, scope.turnId, scope.rootTaskId, scope.userId])
  return result.rows.length === 1 ? result.rows[0]! : null
}
