import { Buffer } from "node:buffer"
import type pg from "pg"
import type { TurnLease } from "../turns/lease.js"
import { lockTaskGraphScope, type GraphScope } from "../subagents/task-graph-pg-state.js"
import { resolveRootTaskObjective, rootTaskObjectiveDigest } from "./root-task-objective.js"

type Client = pg.PoolClient
type Row = Record<string, unknown>

export type RootTaskHistoryFenceInput = Readonly<{
  lease: TurnLease
  rootTaskId: string
  rootAttemptCount: number
  stepId: string
  now: Date
}>

export type RootTaskHistoryFence = Readonly<{ currentStartSequence: bigint; objectiveDigest: string }>

type Queryable = Pick<pg.PoolClient, "query">

function text(value: unknown): value is string {
  return typeof value === "string" && !!value.trim() && value.trim() === value
}

function object(value: unknown): Row | null {
  let parsed = value
  if (typeof parsed === "string") {
    try { parsed = JSON.parse(parsed) as unknown } catch { return null }
  }
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

export function hasSelectedJobPreparation(turnInput: unknown): boolean {
  const input = object(turnInput)
  if (!input) return false
  if (Object.hasOwn(input, "selectedJobPreparation")) return true
  const nested = object(input.input)
  return Boolean(nested && Object.keys(nested).length > 0 && Object.hasOwn(nested, "selectedJobPreparation"))
}

export function validateRootTaskHistoryFenceInput(input: RootTaskHistoryFenceInput): void {
  const { lease } = input
  if (!text(lease.userId) || !text(lease.sessionId) || !text(lease.turnId) || !text(lease.ownerId)
    || !Number.isSafeInteger(lease.leaseVersion) || lease.leaseVersion < 1 || !text(input.rootTaskId)
    || !Number.isSafeInteger(input.rootAttemptCount) || input.rootAttemptCount < 1 || !text(input.stepId)
    || !(input.now instanceof Date) || !Number.isFinite(input.now.getTime())) {
    throw new Error("root_task_history_input_invalid")
  }
}

function validRoot(row: Row, input: RootTaskHistoryFenceInput): boolean {
  return row.id === input.rootTaskId && row.userId === input.lease.userId
    && row.sessionId === input.lease.sessionId && row.turnId === input.lease.turnId
    && row.rootTaskId === input.rootTaskId && row.parentTaskId === null
    && row.role === "orchestrator" && row.taskType === "root" && row.status === "running"
    && row.leaseOwner === input.lease.ownerId && Number(row.attemptCount) === input.rootAttemptCount
    && row.interruptRequestedAt == null
}

function verifierObjectiveDigest(turnInput: unknown, root: Row): string | undefined {
  const resolved = resolveRootTaskObjective(turnInput, { goal: root.goal, successCriteria: root.successCriteria })
  if (!resolved.goal || resolved.turnGoalConflict || !resolved.criteriaValid || !resolved.criteria.length
    || resolved.criteria.some(requirement => Buffer.byteLength(requirement, "utf8") > 2_000)) return undefined
  return rootTaskObjectiveDigest({ goal: resolved.goal, criteria: resolved.criteria.map((requirement, index) => ({
    criterionId: `criterion-${index + 1}`, requirement,
  })) })
}

async function currentStartSequence(client: Queryable, input: RootTaskHistoryFenceInput): Promise<bigint | undefined> {
  const { lease } = input
  const result = await client.query<Row>(`SELECT event."sessionId", event."turnId", event."taskId", event."itemId", event."sequence",
      event."type", event."actor", event."correlationId", event."idempotencyKey", event."payload",
      COUNT(*) OVER () AS "startEventCount"
    FROM "agent_events" AS event
    JOIN "agent_turns" AS turn ON turn."id" = event."turnId" AND turn."sessionId" = event."sessionId"
    JOIN "agent_sessions" AS session ON session."id" = event."sessionId"
    WHERE event."sessionId" = $1 AND event."turnId" = $2 AND event."taskId" = $3
      AND event."type" = 'turn.started' AND turn."rootTaskId" = $3
      AND turn."userId" = $4 AND session."userId" = $4`,
  [lease.sessionId, lease.turnId, input.rootTaskId, lease.userId])
  if (result.rows.length !== 1 || Number(result.rows[0]?.startEventCount) !== 1) return undefined
  const row = result.rows[0]!, payload = object(row.payload), value = sequence(row.sequence)
  return row.sessionId === lease.sessionId && row.turnId === lease.turnId && row.taskId === input.rootTaskId
    && row.itemId === null && row.type === "turn.started" && row.actor === "orchestrator"
    && row.correlationId === lease.turnId && row.idempotencyKey === `turn:${lease.turnId}:event:turn-started`
    && payload?.taskId === input.rootTaskId && payload.rootTaskId === input.rootTaskId
    ? value : undefined
}

/** Locks and validates the live ordinary Root, its current Step, Turn lease, objective, and unique start receipt. */
export async function readRootTaskHistoryFence(
  client: Client,
  input: RootTaskHistoryFenceInput,
): Promise<RootTaskHistoryFence | undefined> {
  const { lease } = input
  const scope: Omit<GraphScope, "stepId"> = {
    userId: lease.userId, sessionId: lease.sessionId, turnId: lease.turnId, rootTaskId: input.rootTaskId,
    parentTaskId: input.rootTaskId, turnLeaseOwner: lease.ownerId, turnLeaseVersion: lease.leaseVersion,
    parentLeaseOwner: lease.ownerId, parentAttemptCount: input.rootAttemptCount,
  }
  const root = await lockTaskGraphScope(client, { ...scope, stepId: input.stepId }, false)
  if (!validRoot(root, input)) throw new Error("root_task_history_current_root_fenced")

  const step = await client.query<Row>(`SELECT "id", "sessionId", "turnId", "taskId", "attempt", "status"
    FROM "agent_steps" WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 FOR UPDATE`,
  [input.stepId, lease.sessionId, lease.turnId])
  const currentStep = step.rows[0]
  if (step.rows.length !== 1 || !currentStep || currentStep.taskId !== input.rootTaskId
    || Number(currentStep.attempt) !== 1 || currentStep.status !== "streaming") {
    throw new Error("root_task_history_current_step_fenced")
  }

  const turn = await client.query<Row>(`SELECT "id", "sessionId", "userId", "rootTaskId", "status", "input"
    FROM "agent_turns" WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3 AND "rootTaskId" = $4
      AND "leaseOwnerId" = $5 AND "leaseVersion" = $6 AND "status" = 'in_progress' FOR UPDATE`,
  [lease.turnId, lease.sessionId, lease.userId, input.rootTaskId, lease.ownerId, lease.leaseVersion])
  const currentTurn = turn.rows[0]
  if (turn.rows.length !== 1 || !currentTurn) throw new Error("root_task_history_current_turn_fenced")
  if (hasSelectedJobPreparation(currentTurn.input)) return undefined
  const objectiveDigest = verifierObjectiveDigest(currentTurn.input, root)
  if (!objectiveDigest) return undefined
  const start = await currentStartSequence(client, input)
  return start === undefined ? undefined : { currentStartSequence: start, objectiveDigest }
}

export async function withRootTaskHistoryTransaction<T>(
  pool: Pick<pg.Pool, "connect">,
  userId: string,
  work: (client: Client) => Promise<T>,
): Promise<T> {
  const client = await pool.connect()
  let committed = false
  try {
    await client.query("BEGIN")
    await client.query("SELECT set_config($1, $2, true)", ["app.user_id", userId])
    const result = await work(client)
    await client.query("COMMIT")
    committed = true
    return result
  } catch (error: unknown) {
    if (!committed) await client.query("ROLLBACK").catch(() => undefined)
    throw error
  } finally { client.release() }
}
