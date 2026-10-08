import { Buffer } from "node:buffer"
import type pg from "pg"
import { currentTaskGraph, loadTaskGraph, type GraphIdentityScope } from "../subagents/task-graph-pg-state.js"
import type { TaskGraphCurrentState } from "../subagents/task-graph-command-port.js"
import type { ValidatedRootTaskHistoryOutcome } from "./root-task-history.js"
import { resolveRootTaskObjective, rootTaskObjectiveDigest } from "./root-task-objective.js"
import {
  hasSelectedJobPreparation, readRootTaskHistoryFence, validateRootTaskHistoryFenceInput, withRootTaskHistoryTransaction,
  type RootTaskHistoryFenceInput,
} from "./root-task-history-fence.js"

type Pool = Pick<pg.Pool, "connect">
type Client = pg.PoolClient
type Row = Record<string, unknown>
const SCAN_LIMIT = 64
const GRAPH_LOAD_LIMIT = 8

export type DirectRootTaskHistoryLoadInput = RootTaskHistoryFenceInput

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
  try {
    const prototype = Object.getPrototypeOf(parsed)
    return prototype === Object.prototype || prototype === null ? parsed as Row : null
  } catch { return null }
}

function sequence(value: unknown): bigint | undefined {
  if (typeof value !== "string" && typeof value !== "bigint") return undefined
  try { const parsed = BigInt(value); return parsed > 0n ? parsed : undefined } catch { return undefined }
}

function objectiveDigest(turnInput: unknown, goal: unknown, successCriteria: unknown): string | undefined {
  const resolved = resolveRootTaskObjective(turnInput, { goal, successCriteria })
  if (!resolved.goal || resolved.turnGoalConflict || !resolved.criteriaValid || !resolved.criteria.length
    || resolved.criteria.some(requirement => Buffer.byteLength(requirement, "utf8") > 2_000)) return undefined
  return rootTaskObjectiveDigest({ goal: resolved.goal, criteria: resolved.criteria.map((requirement, index) => ({
    criterionId: `criterion-${index + 1}`, requirement,
  })) })
}

function validStart(row: Row, turnId: string, rootTaskId: string): bigint | undefined {
  const payload = object(row.startPayload), value = sequence(row.startSequence)
  return Number(row.startEventCount) === 1 && row.startTurnId === turnId && row.startTaskId === rootTaskId
    && row.startItemId === null && row.startType === "turn.started" && row.startActor === "orchestrator"
    && row.startCorrelationId === turnId && row.startIdempotencyKey === `turn:${turnId}:event:turn-started`
    && payload?.taskId === rootTaskId && payload.rootTaskId === rootTaskId ? value : undefined
}

function validTerminal(row: Row, turnId: string, rootTaskId: string, status: string): bigint | undefined {
  const payload = object(row.terminalPayload), value = sequence(row.terminalSequence)
  if (!payload || !value || Number(row.terminalEventCount) !== 1 || row.terminalTurnId !== turnId
    || row.terminalTaskId !== rootTaskId || row.terminalActor !== "orchestrator"
    || payload.turnId !== turnId || payload.taskId !== rootTaskId) return undefined
  const prefix = `turn:${turnId}:event:`
  if (status === "completed") {
    return row.terminalType === "turn.completed" && text(payload.finalItemId) && row.terminalItemId === payload.finalItemId
      && text(row.terminalCorrelationId) && row.terminalStepId === row.terminalCorrelationId
      && row.terminalStepSessionId === row.sessionId && row.terminalStepTurnId === turnId
      && row.terminalStepTaskId === rootTaskId && row.terminalIdempotencyKey === `${prefix}turn-completed` ? value : undefined
  }
  if (status === "failed") {
    return row.terminalType === "turn.failed" && text(payload.errorCode)
      && (payload.finalItemId === null || text(payload.finalItemId)) && row.terminalItemId === payload.finalItemId
      && row.terminalCorrelationId === turnId
      && row.terminalIdempotencyKey === `${prefix}turn-failed:${payload.errorCode}` ? value : undefined
  }
  return status === "interrupted" && row.terminalType === "turn.interrupted" && text(payload.errorCode)
    && row.terminalItemId === null && row.terminalCorrelationId === turnId
    && row.terminalIdempotencyKey === `${prefix}turn-interrupted` ? value : undefined
}

function candidate(row: Row, input: RootTaskHistoryFenceInput, fence: NonNullable<Awaited<ReturnType<typeof readRootTaskHistoryFence>>>): Candidate | undefined {
  const turnId = row.turnId, rootTaskId = row.taskRootTaskId
  if (!text(turnId) || !text(rootTaskId) || turnId === input.lease.turnId
    || row.sessionId !== input.lease.sessionId || row.userId !== input.lease.userId
    || row.rootTaskId !== rootTaskId || row.taskId !== rootTaskId || row.taskTurnId !== turnId
    || row.parentTaskId !== null || row.taskRole !== "orchestrator" || row.taskType !== "root"
    || !["completed", "failed", "interrupted"].includes(String(row.turnStatus))
    || row.turnStatus !== row.taskStatus || hasSelectedJobPreparation(row.input)) return undefined
  const start = validStart(row, turnId, rootTaskId)
  const terminal = validTerminal(row, turnId, rootTaskId, String(row.turnStatus))
  if (start === undefined || terminal === undefined || start >= terminal || terminal >= fence.currentStartSequence
    || objectiveDigest(row.input, row.goal, row.successCriteria) !== fence.objectiveDigest) return undefined
  return { turnId, rootTaskId, terminalSequence: terminal }
}

async function candidates(client: Client, input: RootTaskHistoryFenceInput, fence: NonNullable<Awaited<ReturnType<typeof readRootTaskHistoryFence>>>): Promise<Candidate[]> {
  const result = await client.query<Row>(`WITH terminal_window AS MATERIALIZED (
      SELECT event."sessionId", event."turnId", event."taskId", event."sequence"
      FROM "agent_events" AS event
      WHERE event."sessionId" = $1 AND event."sequence" < $4::bigint
        AND event."type" IN ('turn.completed', 'turn.failed', 'turn.interrupted')
      ORDER BY event."sequence" DESC
      LIMIT $5
    ), roots AS (
      SELECT turn."id" AS "turnId", turn."sessionId", turn."userId", turn."rootTaskId", turn."status" AS "turnStatus", turn."input",
        task."id" AS "taskId", task."turnId" AS "taskTurnId", task."rootTaskId" AS "taskRootTaskId", task."parentTaskId",
        task."role" AS "taskRole", task."taskType", task."status" AS "taskStatus", task."goal", task."successCriteria"
      FROM terminal_window AS terminal_event
      JOIN "agent_turns" AS turn ON turn."id" = terminal_event."turnId" AND turn."sessionId" = terminal_event."sessionId"
      JOIN "agent_sessions" AS session ON session."id" = turn."sessionId" AND session."userId" = $2
      JOIN "sub_agent_tasks" AS task ON task."id" = turn."rootTaskId" AND task."sessionId" = turn."sessionId"
        AND task."turnId" = turn."id" AND task."rootTaskId" = task."id"
      WHERE turn."userId" = $2 AND turn."id" <> $3 AND terminal_event."taskId" = turn."rootTaskId"
        AND turn."status" IN ('completed', 'failed', 'interrupted')
        AND task."status" IN ('completed', 'failed', 'interrupted')
        AND task."parentTaskId" IS NULL AND task."role" = 'orchestrator' AND task."taskType" = 'root'
    )
    SELECT roots.*,
      started."turnId" AS "startTurnId", started."taskId" AS "startTaskId", started."itemId" AS "startItemId",
      started."sequence" AS "startSequence", started."type" AS "startType", started."actor" AS "startActor",
      started."correlationId" AS "startCorrelationId", started."idempotencyKey" AS "startIdempotencyKey",
      started."payload" AS "startPayload", started."startEventCount",
      terminal."turnId" AS "terminalTurnId", terminal."taskId" AS "terminalTaskId", terminal."itemId" AS "terminalItemId",
      terminal."sequence" AS "terminalSequence", terminal."type" AS "terminalType", terminal."actor" AS "terminalActor",
      terminal."correlationId" AS "terminalCorrelationId", terminal."idempotencyKey" AS "terminalIdempotencyKey",
      terminal."payload" AS "terminalPayload", terminal."terminalEventCount",
      terminal_step."id" AS "terminalStepId", terminal_step."sessionId" AS "terminalStepSessionId",
      terminal_step."turnId" AS "terminalStepTurnId", terminal_step."taskId" AS "terminalStepTaskId"
    FROM roots
    JOIN LATERAL (
      SELECT event."turnId", event."taskId", event."itemId", event."sequence", event."type", event."actor",
        event."correlationId", event."idempotencyKey", event."payload", COUNT(*) OVER () AS "terminalEventCount"
      FROM "agent_events" AS event WHERE event."sessionId" = roots."sessionId" AND event."turnId" = roots."turnId"
        AND event."taskId" = roots."rootTaskId" AND event."type" IN ('turn.completed', 'turn.failed', 'turn.interrupted')
      ORDER BY event."sequence" DESC LIMIT 1
    ) AS terminal ON true
    LEFT JOIN LATERAL (
      SELECT step."id", step."sessionId", step."turnId", step."taskId"
      FROM "agent_steps" AS step
      WHERE terminal."type" = 'turn.completed'
        AND step."id" = terminal."correlationId"
        AND step."sessionId" = roots."sessionId"
        AND step."turnId" = roots."turnId"
        AND step."taskId" = roots."rootTaskId"
      LIMIT 1
    ) AS terminal_step ON true
    LEFT JOIN LATERAL (
      SELECT event."turnId", event."taskId", event."itemId", event."sequence", event."type", event."actor",
        event."correlationId", event."idempotencyKey", event."payload", COUNT(*) OVER () AS "startEventCount"
      FROM "agent_events" AS event WHERE event."sessionId" = roots."sessionId" AND event."turnId" = roots."turnId"
        AND event."taskId" = roots."rootTaskId" AND event."type" = 'turn.started'
      ORDER BY event."sequence" DESC LIMIT 1
    ) AS started ON true
    WHERE terminal."sequence" < $4::bigint
      AND (terminal."type" <> 'turn.completed' OR terminal_step."id" = terminal."correlationId")
    ORDER BY terminal."sequence" DESC, roots."turnId" DESC`,
  [input.lease.sessionId, input.lease.userId, input.lease.turnId, String(fence.currentStartSequence), SCAN_LIMIT])
  const output: Candidate[] = [], seen = new Set<string>()
  for (const row of result.rows) {
    const value = candidate(row, input, fence)
    if (!value) continue
    const key = JSON.stringify([value.turnId, value.rootTaskId])
    if (!seen.has(key)) { seen.add(key); output.push(value) }
  }
  return output
}

function databaseError(value: unknown): boolean {
  return !!value && typeof value === "object" && "code" in value && typeof value.code === "string"
    && /^[0-9A-Z]{5}$/.test(value.code)
}

const SCOPE_ERRORS = new Set([
  "task_graph_scope_invalid", "task_graph_session_fenced", "task_graph_turn_fenced",
  "task_graph_parent_fenced", "task_graph_step_fenced", "task_graph_task_scope_invalid",
])

function graphEvidenceError(value: unknown): boolean {
  return value instanceof Error && !databaseError(value) && !SCOPE_ERRORS.has(value.message)
    && /^task_graph_[a-z0-9_]+$/.test(value.message)
}

async function graphForCandidate(client: Client, input: RootTaskHistoryFenceInput, source: Candidate): Promise<TaskGraphCurrentState | undefined> {
  const scope: GraphIdentityScope = { userId: input.lease.userId, sessionId: input.lease.sessionId,
    turnId: source.turnId, rootTaskId: source.rootTaskId, parentTaskId: source.rootTaskId }
  try {
    const loaded = await loadTaskGraph(client, scope, false)
    if (!loaded.item || !loaded.snapshot || !loaded.state) return undefined
    const graph = currentTaskGraph(loaded)
    return graph.nodes.length ? graph : undefined
  } catch (error: unknown) {
    if (graphEvidenceError(error)) return undefined
    throw error
  }
}

export function createPgDirectRootTaskHistoryStore(pool: Pool) {
  return {
    async load(input: DirectRootTaskHistoryLoadInput): Promise<readonly ValidatedRootTaskHistoryOutcome[]> {
      validateRootTaskHistoryFenceInput(input)
      return withRootTaskHistoryTransaction(pool, input.lease.userId, async client => {
        const fence = await readRootTaskHistoryFence(client, input)
        if (!fence) return []
        const sources = await candidates(client, input, fence)
        const outcomes: ValidatedRootTaskHistoryOutcome[] = []
        let graphLoads = 0
        for (const source of sources) {
          if (graphLoads >= GRAPH_LOAD_LIMIT) break
          graphLoads += 1
          const taskGraph = await graphForCandidate(client, input, source)
          if (taskGraph) outcomes.push({ sourceTurnId: source.turnId, sourceRootTaskId: source.rootTaskId,
            terminalSequence: source.terminalSequence, taskGraph })
        }
        return outcomes
      })
    },
  }
}
