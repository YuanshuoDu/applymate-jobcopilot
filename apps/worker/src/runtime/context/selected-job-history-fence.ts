import type pg from "pg"
import type { TurnLease } from "../turns/lease.js"
import { lockTaskGraphScope, type GraphScope } from "../subagents/task-graph-pg-state.js"

type Client = pg.PoolClient
type Row = Record<string, unknown>

export type SelectedJobHistoryFenceInput = Readonly<{
  lease: TurnLease
  rootTaskId: string
  rootAttemptCount: number
  stepId: string
  jobId: string
  now: Date
}>

export type SelectedJobHistoryFence = Readonly<{ currentStartSequence: bigint }>

type Pool = Pick<pg.Pool, "connect">
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
  const prototype = Object.getPrototypeOf(parsed)
  return prototype === Object.prototype || prototype === null ? parsed as Row : null
}

function selectedJob(value: unknown): string | undefined {
  const input = object(value), selection = object(input?.selectedJobPreparation)
  if (!selection || Reflect.ownKeys(selection).length !== 1 || !text(selection.jobId)
    || selection.jobId.length > 256) return undefined
  return selection.jobId
}

function sequence(value: unknown): bigint | undefined {
  if (typeof value !== "string" && typeof value !== "bigint") return undefined
  try {
    const parsed = BigInt(value)
    return parsed > 0n ? parsed : undefined
  } catch { return undefined }
}

export function validateSelectedJobHistoryFenceInput(input: SelectedJobHistoryFenceInput): void {
  const { lease } = input
  if (!text(lease.userId) || !text(lease.sessionId) || !text(lease.turnId) || !text(lease.ownerId)
    || !Number.isSafeInteger(lease.leaseVersion) || lease.leaseVersion < 1 || !text(input.rootTaskId)
    || !Number.isSafeInteger(input.rootAttemptCount) || input.rootAttemptCount < 1 || !text(input.stepId)
    || !text(input.jobId) || input.jobId.length > 256 || !(input.now instanceof Date) || !Number.isFinite(input.now.getTime())) {
    throw new Error("selected_job_history_input_invalid")
  }
}

function validRoot(row: Row, input: SelectedJobHistoryFenceInput): boolean {
  return row.id === input.rootTaskId && row.sessionId === input.lease.sessionId && row.turnId === input.lease.turnId
    && row.rootTaskId === input.rootTaskId && row.parentTaskId === null && row.role === "orchestrator" && row.taskType === "root"
    && row.leaseOwner === input.lease.ownerId && row.status === "running" && row.interruptRequestedAt == null
    && Number(row.attemptCount) === input.rootAttemptCount
}

async function lockCurrent(client: Client, input: SelectedJobHistoryFenceInput): Promise<boolean> {
  const { lease } = input
  const readScope: Omit<GraphScope, "stepId"> = {
    userId: lease.userId, sessionId: lease.sessionId, turnId: lease.turnId, rootTaskId: input.rootTaskId,
    parentTaskId: input.rootTaskId, turnLeaseOwner: lease.ownerId, turnLeaseVersion: lease.leaseVersion,
    parentLeaseOwner: lease.ownerId, parentAttemptCount: input.rootAttemptCount,
  }
  const root = await lockTaskGraphScope(client, { ...readScope, stepId: input.stepId }, false)
  if (!validRoot(root, input)) throw new Error("selected_job_history_current_root_fenced")

  const step = await client.query<Row>(`SELECT "id", "sessionId", "turnId", "taskId", "attempt", "status"
    FROM "agent_steps" WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 FOR UPDATE`,
  [input.stepId, lease.sessionId, lease.turnId])
  const currentStep = step.rows[0]
  if (step.rows.length !== 1 || !currentStep || currentStep.taskId !== input.rootTaskId
    || Number(currentStep.attempt) !== 1 || currentStep.status !== "streaming") {
    throw new Error("selected_job_history_current_step_fenced")
  }

  const turn = await client.query<Row>(`SELECT "id", "sessionId", "userId", "rootTaskId", "status", "input"
    FROM "agent_turns" WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3 AND "rootTaskId" = $4
      AND "leaseOwnerId" = $5 AND "leaseVersion" = $6 AND "status" = 'in_progress' FOR UPDATE`,
  [lease.turnId, lease.sessionId, lease.userId, input.rootTaskId, lease.ownerId, lease.leaseVersion])
  const currentTurn = turn.rows[0]
  if (turn.rows.length !== 1 || !currentTurn) throw new Error("selected_job_history_current_turn_fenced")
  return selectedJob(currentTurn.input) === input.jobId
}

async function readCurrentStartSequence(client: Queryable, input: SelectedJobHistoryFenceInput): Promise<bigint | undefined> {
  const { lease } = input
  const result = await client.query<Row>(`SELECT event."sequence"
    FROM "agent_events" AS event JOIN "agent_turns" AS turn
      ON turn."id" = event."turnId" AND turn."sessionId" = event."sessionId"
    JOIN "agent_sessions" AS session ON session."id" = event."sessionId"
    WHERE event."sessionId" = $1 AND event."turnId" = $2 AND event."taskId" = $3
      AND event."itemId" IS NULL AND event."type" = 'turn.started' AND event."actor" = 'orchestrator'
      AND event."correlationId" = $2 AND event."idempotencyKey" = $4
      AND event."payload"->>'taskId' = $3 AND event."payload"->>'rootTaskId' = $3
      AND turn."userId" = $5 AND session."userId" = $5`,
  [lease.sessionId, lease.turnId, input.rootTaskId, `turn:${lease.turnId}:event:turn-started`, lease.userId])
  return result.rows.length === 1 ? sequence(result.rows[0]?.sequence) : undefined
}

/** Revalidates current lease, canonical Root Step, server selection, and durable start event on one locked client. */
export async function readSelectedJobHistoryFence(
  client: Client,
  input: SelectedJobHistoryFenceInput,
): Promise<SelectedJobHistoryFence | undefined> {
  if (!await lockCurrent(client, input)) return undefined
  const currentStartSequence = await readCurrentStartSequence(client, input)
  return currentStartSequence === undefined ? undefined : { currentStartSequence }
}

export async function withSelectedJobHistoryTransaction<T>(
  pool: Pool,
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
