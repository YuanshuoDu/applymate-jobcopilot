import type pg from "pg"
import type { TurnLease } from "../turns/lease.js"
import { lockTaskGraphScope, type GraphIdentityScope, type GraphScope } from "../subagents/task-graph-pg-state.js"
import { parseSelectedJobMemories, type SelectedJobMemoryRecord } from "./selected-job-memory.js"
import { revalidateSelectedJobHistoryGraph } from "./selected-job-history-graph.js"
import type { ValidatedSelectedJobHistory } from "./selected-job-history.js"

type Pool = Pick<pg.Pool, "connect">
type Client = pg.PoolClient
type Row = Record<string, unknown>

export type SelectedJobHistoryLoadInput = Readonly<{
  lease: TurnLease
  rootTaskId: string
  rootAttemptCount: number
  stepId: string
  jobId: string
  records: readonly SelectedJobMemoryRecord[]
  now: Date
}>

type SourceRow = Readonly<{
  turnId: string; sessionId: string; userId: string; rootTaskId: string; turnStatus: string; input: unknown
  taskId: string; taskTurnId: string; taskRootTaskId: string; parentTaskId: string | null
  role: string; taskType: string; taskStatus: string
}>

function text(value: unknown): value is string { return typeof value === "string" && !!value.trim() && value.trim() === value }
function json(value: unknown): unknown {
  if (typeof value !== "string") return value
  try { return JSON.parse(value) as unknown } catch { return undefined }
}
function object(value: unknown): Row | null {
  const parsed = json(value)
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
function pair(turnId: string, rootTaskId: string): string { return JSON.stringify([turnId, rootTaskId]) }

async function transaction<T>(pool: Pool, userId: string, work: (client: Client) => Promise<T>): Promise<T> {
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

function validateInput(input: SelectedJobHistoryLoadInput): void {
  const { lease } = input
  if (!text(lease.userId) || !text(lease.sessionId) || !text(lease.turnId) || !text(lease.ownerId)
    || !Number.isSafeInteger(lease.leaseVersion) || lease.leaseVersion < 1 || !text(input.rootTaskId)
    || !Number.isSafeInteger(input.rootAttemptCount) || input.rootAttemptCount < 1 || !text(input.stepId)
    || !text(input.jobId) || input.jobId.length > 256 || !(input.now instanceof Date) || !Number.isFinite(input.now.getTime())) {
    throw new Error("selected_job_history_input_invalid")
  }
}

function validRoot(row: Row, input: SelectedJobHistoryLoadInput): boolean {
  return row.id === input.rootTaskId && row.sessionId === input.lease.sessionId && row.turnId === input.lease.turnId
    && row.rootTaskId === input.rootTaskId && row.parentTaskId === null && row.role === "orchestrator" && row.taskType === "root"
    && row.leaseOwner === input.lease.ownerId && row.status === "running" && row.interruptRequestedAt == null
    && Number(row.attemptCount) === input.rootAttemptCount
}

async function lockCurrent(client: Client, input: SelectedJobHistoryLoadInput): Promise<boolean> {
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
  if (selectedJob(currentTurn.input) !== input.jobId) return false
  return true
}

async function currentStartSequence(client: Client, input: SelectedJobHistoryLoadInput): Promise<bigint | undefined> {
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

async function sourceRows(client: Client, input: SelectedJobHistoryLoadInput, records: readonly SelectedJobMemoryRecord[]): Promise<Map<string, SourceRow>> {
  const pairs = [...new Map(records.map(record => [pair(record.sourceTurnId, record.sourceRootTaskId), record])).values()]
  const result = await client.query<Row>(`SELECT turn."id" AS "turnId", turn."sessionId", turn."userId", turn."rootTaskId",
      turn."status" AS "turnStatus", turn."input", task."id" AS "taskId", task."turnId" AS "taskTurnId",
      task."rootTaskId" AS "taskRootTaskId", task."parentTaskId", task."role", task."taskType", task."status" AS "taskStatus"
    FROM unnest($1::text[], $2::text[]) AS expected("turnId", "rootTaskId")
    JOIN "agent_turns" AS turn ON turn."id" = expected."turnId" AND turn."sessionId" = $3
    JOIN "agent_sessions" AS session ON session."id" = turn."sessionId" AND session."userId" = $4
    JOIN "sub_agent_tasks" AS task ON task."id" = expected."rootTaskId" AND task."sessionId" = turn."sessionId"
      AND task."turnId" = turn."id" AND task."rootTaskId" = task."id"
    WHERE turn."userId" = $4 AND turn."rootTaskId" = task."id" AND turn."id" <> $5
      AND task."parentTaskId" IS NULL AND task."role" = 'orchestrator' AND task."taskType" = 'root'
      AND turn."status" IN ('completed', 'failed', 'interrupted')
      AND task."status" IN ('completed', 'failed', 'interrupted')`,
  [pairs.map(value => value.sourceTurnId), pairs.map(value => value.sourceRootTaskId), input.lease.sessionId,
    input.lease.userId, input.lease.turnId])
  return new Map(result.rows.map(row => [pair(String(row.turnId), String(row.taskRootTaskId)), {
    turnId: String(row.turnId), sessionId: String(row.sessionId), userId: String(row.userId), rootTaskId: String(row.rootTaskId),
    turnStatus: String(row.turnStatus), input: row.input, taskId: String(row.taskId), taskTurnId: String(row.taskTurnId),
    taskRootTaskId: String(row.taskRootTaskId), parentTaskId: row.parentTaskId == null ? null : String(row.parentTaskId),
    role: String(row.role), taskType: String(row.taskType), taskStatus: String(row.taskStatus),
  }]))
}

function validSource(row: SourceRow, input: SelectedJobHistoryLoadInput, record: SelectedJobMemoryRecord): boolean {
  return row.turnId === record.sourceTurnId && row.rootTaskId === record.sourceRootTaskId && row.sessionId === input.lease.sessionId
    && row.userId === input.lease.userId && row.taskId === record.sourceRootTaskId && row.taskTurnId === row.turnId
    && row.taskRootTaskId === row.taskId && row.parentTaskId === null && row.role === "orchestrator" && row.taskType === "root"
    && row.turnId !== input.lease.turnId && row.turnStatus === row.taskStatus
    && selectedJob(row.input) === input.jobId && record.jobId === input.jobId
}

async function terminalEvents(client: Client, input: SelectedJobHistoryLoadInput, rows: readonly SourceRow[]): Promise<Map<string, Row>> {
  const unique = [...new Map(rows.map(row => [pair(row.turnId, row.rootTaskId), row])).values()]
  if (!unique.length) return new Map()
  const result = await client.query<Row>(`WITH expected AS (
      SELECT * FROM unnest($1::text[], $2::text[]) AS source("turnId", "rootTaskId")
    ), matched AS (
      SELECT event."turnId", event."taskId", event."itemId", event."sequence", event."type", event."actor",
        event."correlationId", event."idempotencyKey", event."payload"
      FROM expected JOIN "agent_events" AS event ON event."turnId" = expected."turnId"
        AND event."taskId" = expected."rootTaskId" AND event."sessionId" = $3
      JOIN "agent_turns" AS turn ON turn."id" = event."turnId" AND turn."sessionId" = event."sessionId"
      JOIN "agent_sessions" AS session ON session."id" = event."sessionId"
      WHERE turn."userId" = $4 AND session."userId" = $4
        AND event."type" IN ('turn.completed', 'turn.failed', 'turn.interrupted')
    )
    SELECT matched.*, COUNT(*) OVER (PARTITION BY matched."turnId", matched."taskId") AS "eventCount"
    FROM matched`,
  [unique.map(row => row.turnId), unique.map(row => row.rootTaskId), input.lease.sessionId, input.lease.userId])
  const grouped = new Map<string, Row[]>()
  for (const row of result.rows) {
    const key = pair(String(row.turnId), String(row.taskId))
    grouped.set(key, [...(grouped.get(key) ?? []), row])
  }
  return new Map([...grouped].filter(([, events]) => events.length === 1 && Number(events[0]?.eventCount) === 1)
    .map(([key, events]) => [key, events[0]!]))
}

function terminalSequence(row: Row | undefined, source: SourceRow, currentStart: bigint, record: SelectedJobMemoryRecord): bigint | undefined {
  if (!row || row.turnId !== source.turnId || row.taskId !== source.rootTaskId || row.actor !== "orchestrator") return undefined
  const expectedType = source.turnStatus === "completed" ? "turn.completed" : source.turnStatus === "failed" ? "turn.failed"
    : source.turnStatus === "interrupted" ? "turn.interrupted" : undefined
  if (!expectedType || row.type !== expectedType) return undefined
  const payload = object(row.payload), sequenceValue = sequence(row.sequence)
  if (!payload || sequenceValue === undefined || payload.turnId !== source.turnId || payload.taskId !== source.rootTaskId
    || BigInt(record.throughSequence) >= sequenceValue || sequenceValue >= currentStart) return undefined
  if (expectedType === "turn.completed") {
    return text(payload.finalItemId) && row.itemId === payload.finalItemId && text(row.correlationId)
      && row.idempotencyKey === `turn:${source.turnId}:event:turn-completed` ? sequenceValue : undefined
  }
  if (expectedType === "turn.failed") {
    return text(payload.errorCode) && (payload.finalItemId === null || text(payload.finalItemId))
      && row.itemId === payload.finalItemId && row.correlationId === source.turnId
      && row.idempotencyKey === `turn:${source.turnId}:event:turn-failed:${payload.errorCode}` ? sequenceValue : undefined
  }
  return text(payload.errorCode) && row.itemId === null && row.correlationId === source.turnId
    && row.idempotencyKey === `turn:${source.turnId}:event:turn-interrupted` ? sequenceValue : undefined
}

async function loadHistory(client: Client, input: SelectedJobHistoryLoadInput, records: readonly SelectedJobMemoryRecord[]): Promise<ValidatedSelectedJobHistory[]> {
  if (!await lockCurrent(client, input)) return []
  const currentStart = await currentStartSequence(client, input)
  if (currentStart === undefined) return []
  const sources = await sourceRows(client, input, records)
  const rows = records.flatMap(record => {
    const source = sources.get(pair(record.sourceTurnId, record.sourceRootTaskId))
    return source && validSource(source, input, record) ? [source] : []
  })
  const events = await terminalEvents(client, input, rows)
  const validated: ValidatedSelectedJobHistory[] = []
  for (const record of records) {
    const source = sources.get(pair(record.sourceTurnId, record.sourceRootTaskId))
    if (!source || !validSource(source, input, record)) continue
    const terminal = terminalSequence(events.get(pair(source.turnId, source.rootTaskId)), source, currentStart, record)
    if (terminal === undefined) continue
    const scope: GraphIdentityScope = { userId: source.userId, sessionId: source.sessionId,
      turnId: source.turnId, rootTaskId: source.rootTaskId, parentTaskId: source.rootTaskId }
    const persisted = await revalidateSelectedJobHistoryGraph(client, scope, record)
    if (persisted && JSON.stringify(persisted) === JSON.stringify(record)) validated.push({ record, terminalSequence: terminal })
  }
  return validated
}

export function createPgSelectedJobHistoryStore(pool: Pool) {
  return {
    async load(input: SelectedJobHistoryLoadInput): Promise<readonly ValidatedSelectedJobHistory[]> {
      validateInput(input)
      const records = parseSelectedJobMemories(input.records)
      const candidates = records?.filter(record => record.jobId === input.jobId
        && record.sourceTurnId !== input.lease.turnId && record.sourceRootTaskId !== input.rootTaskId)
      if (!candidates?.length) return []
      return transaction(pool, input.lease.userId, client => loadHistory(client, input, candidates))
    },
  }
}
