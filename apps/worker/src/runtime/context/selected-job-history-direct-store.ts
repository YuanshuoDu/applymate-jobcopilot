import type pg from "pg"
import { currentTaskGraph, loadTaskGraph, type GraphIdentityScope } from "../subagents/task-graph-pg-state.js"
import { projectSelectedJobMemoryNodes, parseSelectedJobMemoryNodes } from "./selected-job-memory-node-projection.js"
import type { SelectedJobMemoryNode } from "./selected-job-memory.js"
import {
  readSelectedJobHistoryFence, validateSelectedJobHistoryFenceInput, withSelectedJobHistoryTransaction,
  type SelectedJobHistoryFenceInput,
} from "./selected-job-history-fence.js"

type Pool = Pick<pg.Pool, "connect">
type Client = pg.PoolClient
type Row = Record<string, unknown>
const CANDIDATE_LIMIT = 8

export type DirectSelectedJobHistoryLoadInput = SelectedJobHistoryFenceInput
export type ValidatedSelectedJobHistoryOutcome = Readonly<{
  jobId: string
  sourceTurnId: string
  sourceRootTaskId: string
  terminalSequence: bigint
  nodes: readonly SelectedJobMemoryNode[]
}>

type Candidate = Readonly<{ turnId: string; rootTaskId: string; terminalSequence: bigint }>

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
  return selection && Reflect.ownKeys(selection).length === 1 && text(selection.jobId) && selection.jobId.length <= 256
    ? selection.jobId : undefined
}

function sequence(value: unknown): bigint | undefined {
  if (typeof value !== "string" && typeof value !== "bigint") return undefined
  try { const parsed = BigInt(value); return parsed > 0n ? parsed : undefined } catch { return undefined }
}

function validCandidate(row: Row, input: DirectSelectedJobHistoryLoadInput, before: bigint): Candidate | undefined {
  const turnId = row.turnId, rootTaskId = row.taskRootTaskId, terminalSequence = sequence(row.sequence)
  if (!text(turnId) || !text(rootTaskId) || terminalSequence === undefined || terminalSequence >= before
    || Number(row.terminalEventCount) !== 1 || row.sessionId !== input.lease.sessionId || row.userId !== input.lease.userId
    || row.rootTaskId !== rootTaskId || row.taskId !== rootTaskId || row.taskTurnId !== turnId
    || row.parentTaskId !== null || row.taskRole !== "orchestrator" || row.taskType !== "root"
    || row.turnId === input.lease.turnId || row.turnStatus !== row.taskStatus
    || !["completed", "failed", "interrupted"].includes(String(row.turnStatus))
    || selectedJob(row.input) !== input.jobId || row.eventTurnId !== turnId || row.eventTaskId !== rootTaskId
    || row.actor !== "orchestrator") return undefined

  const payload = object(row.payload)
  if (!payload || payload.turnId !== turnId || payload.taskId !== rootTaskId) return undefined
  const expectedKey = `turn:${turnId}:event:`
  if (row.turnStatus === "completed") {
    return row.type === "turn.completed" && text(payload.finalItemId) && row.itemId === payload.finalItemId
      && text(row.correlationId) && row.idempotencyKey === `${expectedKey}turn-completed`
      ? { turnId, rootTaskId, terminalSequence } : undefined
  }
  if (row.turnStatus === "failed") {
    return row.type === "turn.failed" && text(payload.errorCode)
      && (payload.finalItemId === null || text(payload.finalItemId)) && row.itemId === payload.finalItemId
      && row.correlationId === turnId && row.idempotencyKey === `${expectedKey}turn-failed:${payload.errorCode}`
      ? { turnId, rootTaskId, terminalSequence } : undefined
  }
  return row.type === "turn.interrupted" && text(payload.errorCode) && row.itemId === null
    && row.correlationId === turnId && row.idempotencyKey === `${expectedKey}turn-interrupted`
    ? { turnId, rootTaskId, terminalSequence } : undefined
}

async function candidates(client: Client, input: DirectSelectedJobHistoryLoadInput, before: bigint): Promise<Candidate[]> {
  const result = await client.query<Row>(`WITH terminal AS (
      SELECT turn."id" AS "turnId", turn."sessionId", turn."userId", turn."rootTaskId", turn."status" AS "turnStatus", turn."input",
        task."id" AS "taskId", task."turnId" AS "taskTurnId", task."rootTaskId" AS "taskRootTaskId", task."parentTaskId",
        task."role" AS "taskRole", task."taskType", task."status" AS "taskStatus",
        event."turnId" AS "eventTurnId", event."taskId" AS "eventTaskId", event."itemId", event."sequence",
        event."type", event."actor", event."correlationId", event."idempotencyKey", event."payload",
        COUNT(*) OVER (PARTITION BY turn."id", task."id") AS "terminalEventCount"
      FROM "agent_turns" AS turn
      JOIN "agent_sessions" AS session ON session."id" = turn."sessionId" AND session."userId" = $2
      JOIN "sub_agent_tasks" AS task ON task."id" = turn."rootTaskId" AND task."sessionId" = turn."sessionId"
        AND task."turnId" = turn."id" AND task."rootTaskId" = task."id"
      JOIN "agent_events" AS event ON event."sessionId" = turn."sessionId" AND event."turnId" = turn."id"
        AND event."taskId" = task."id" AND event."type" IN ('turn.completed', 'turn.failed', 'turn.interrupted')
      WHERE turn."sessionId" = $1 AND turn."userId" = $2 AND turn."id" <> $3
        AND turn."status" IN ('completed', 'failed', 'interrupted') AND task."status" = turn."status"
        AND task."parentTaskId" IS NULL AND task."role" = 'orchestrator' AND task."taskType" = 'root'
        AND turn."input"->'selectedJobPreparation' = jsonb_build_object('jobId', $4::text)
    )
    SELECT * FROM terminal WHERE "terminalEventCount" = 1 AND "sequence" < $5::bigint
      AND jsonb_typeof("payload") = 'object' AND "payload"->>'turnId' = "turnId" AND "payload"->>'taskId' = "taskId"
      AND (
        ("turnStatus" = 'completed' AND "type" = 'turn.completed' AND "actor" = 'orchestrator'
          AND jsonb_typeof("payload"->'finalItemId') = 'string' AND NULLIF(BTRIM("payload"->>'finalItemId'), '') IS NOT NULL
          AND "payload"->>'finalItemId' = BTRIM("payload"->>'finalItemId') AND "itemId" = "payload"->>'finalItemId'
          AND "correlationId" IS NOT NULL AND NULLIF(BTRIM("correlationId"), '') IS NOT NULL
          AND "correlationId" = BTRIM("correlationId") AND "idempotencyKey" = 'turn:' || "turnId" || ':event:turn-completed')
        OR ("turnStatus" = 'failed' AND "type" = 'turn.failed' AND "actor" = 'orchestrator'
          AND jsonb_typeof("payload"->'errorCode') = 'string' AND NULLIF(BTRIM("payload"->>'errorCode'), '') IS NOT NULL
          AND "payload"->>'errorCode' = BTRIM("payload"->>'errorCode')
          AND (jsonb_typeof("payload"->'finalItemId') = 'null' OR (jsonb_typeof("payload"->'finalItemId') = 'string'
            AND NULLIF(BTRIM("payload"->>'finalItemId'), '') IS NOT NULL AND "payload"->>'finalItemId' = BTRIM("payload"->>'finalItemId')))
          AND "itemId" IS NOT DISTINCT FROM "payload"->>'finalItemId' AND "correlationId" = "turnId"
          AND "idempotencyKey" = 'turn:' || "turnId" || ':event:turn-failed:' || ("payload"->>'errorCode'))
        OR ("turnStatus" = 'interrupted' AND "type" = 'turn.interrupted' AND "actor" = 'orchestrator'
          AND jsonb_typeof("payload"->'errorCode') = 'string' AND NULLIF(BTRIM("payload"->>'errorCode'), '') IS NOT NULL
          AND "payload"->>'errorCode' = BTRIM("payload"->>'errorCode') AND "itemId" IS NULL AND "correlationId" = "turnId"
          AND "idempotencyKey" = 'turn:' || "turnId" || ':event:turn-interrupted')
      )
    ORDER BY "sequence" DESC LIMIT $6`,
  [input.lease.sessionId, input.lease.userId, input.lease.turnId, input.jobId, String(before), CANDIDATE_LIMIT])
  return result.rows.flatMap(row => {
    const candidate = validCandidate(row, input, before)
    return candidate ? [candidate] : []
  })
}

function databaseError(value: unknown): boolean {
  return !!value && typeof value === "object" && "code" in value && typeof value.code === "string" && /^[0-9A-Z]{5}$/.test(value.code)
}

function graphDomainError(value: unknown): boolean {
  return value instanceof Error && !databaseError(value) && /^task_graph_[a-z0-9_]+$/.test(value.message)
}

async function projectNodes(client: Client, input: DirectSelectedJobHistoryLoadInput, source: Candidate): Promise<readonly SelectedJobMemoryNode[] | undefined> {
  const scope: GraphIdentityScope = { userId: input.lease.userId, sessionId: input.lease.sessionId,
    turnId: source.turnId, rootTaskId: source.rootTaskId, parentTaskId: source.rootTaskId }
  try {
    const graph = currentTaskGraph(await loadTaskGraph(client, scope, false))
    const projected = projectSelectedJobMemoryNodes({ jobId: input.jobId, graph })
    return projected ? parseSelectedJobMemoryNodes(projected) ?? undefined : undefined
  } catch (error: unknown) {
    if (graphDomainError(error)) return undefined
    throw error
  }
}

export function createPgDirectSelectedJobHistoryStore(pool: Pool) {
  return {
    async load(input: DirectSelectedJobHistoryLoadInput): Promise<readonly ValidatedSelectedJobHistoryOutcome[]> {
      validateSelectedJobHistoryFenceInput(input)
      return withSelectedJobHistoryTransaction(pool, input.lease.userId, async client => {
        const fence = await readSelectedJobHistoryFence(client, input)
        if (!fence) return []
        const sources = await candidates(client, input, fence.currentStartSequence)
        const outcomes: ValidatedSelectedJobHistoryOutcome[] = []
        for (const source of sources) {
          const nodes = await projectNodes(client, input, source)
          if (nodes?.length) outcomes.push({ jobId: input.jobId, sourceTurnId: source.turnId,
            sourceRootTaskId: source.rootTaskId, terminalSequence: source.terminalSequence, nodes })
        }
        return outcomes
      })
    },
  }
}
