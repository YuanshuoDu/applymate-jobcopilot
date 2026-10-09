import { Buffer } from "node:buffer"
import type pg from "pg"
import { resolveRootTaskObjective, rootTaskObjectiveDigest } from "./root-task-objective.js"
import { hasSelectedJobPreparation, rootTaskHistoryOrigin, type RootTaskHistoryFence, type RootTaskHistoryFenceInput } from "./root-task-history-fence.js"

type Client = pg.PoolClient
type Row = Record<string, unknown>
const SCAN_LIMIT = 64

export type RootTaskHistoryCandidate = Readonly<{
  sessionId: string
  turnId: string
  rootTaskId: string
  terminalSequence: bigint
  terminalAt?: Date
}>

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

function validTerminal(row: Row, turnId: string, rootTaskId: string, status: string, startSequence: bigint): bigint | undefined {
  const payload = object(row.terminalPayload), value = sequence(row.terminalSequence)
  if (!payload || !value || Number(row.terminalEventCount) !== 1 || row.terminalTurnId !== turnId
    || row.terminalTaskId !== rootTaskId || row.terminalActor !== "orchestrator"
    || payload.turnId !== turnId || payload.taskId !== rootTaskId) return undefined
  const prefix = `turn:${turnId}:event:`
  if (status === "completed") {
    const stepPayload = object(row.terminalStepEventPayload), stepSequence = sequence(row.terminalStepEventSequence)
    const exactStepPayload = !!stepPayload && Object.keys(stepPayload).sort().join(",") === "status,stepId,taskId"
    return row.terminalType === "turn.completed" && text(payload.finalItemId) && row.terminalItemId === payload.finalItemId
      && text(row.terminalCorrelationId) && row.terminalStepId === row.terminalCorrelationId
      && row.terminalStepSessionId === row.sessionId && row.terminalStepTurnId === turnId
      && row.terminalStepTaskId === rootTaskId && row.terminalStepStatus === "completed"
      && Number(row.terminalStepEventCount) === 1 && row.terminalStepEventSessionId === row.sessionId
      && row.terminalStepEventTurnId === turnId && row.terminalStepEventTaskId === rootTaskId
      && row.terminalStepEventItemId === null && row.terminalStepEventType === "step.completed"
      && row.terminalStepEventActor === "orchestrator" && row.terminalStepEventCorrelationId === row.terminalStepId
      && row.terminalStepEventIdempotencyKey === `${prefix}step-completed:${row.terminalStepId}`
      && stepSequence !== undefined && stepSequence > startSequence && stepSequence < value
      && exactStepPayload && stepPayload?.stepId === row.terminalStepId && stepPayload.status === "completed" && stepPayload.taskId === rootTaskId
      && row.terminalIdempotencyKey === `${prefix}turn-completed` ? value : undefined
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

function candidate(row: Row, input: RootTaskHistoryFenceInput, fence: RootTaskHistoryFence): RootTaskHistoryCandidate | undefined {
  const turnId = row.turnId, rootTaskId = row.taskRootTaskId
  const crossSession = input.crossSessionRootTaskHistoryEnabled === true
  if (!text(turnId) || !text(rootTaskId) || !text(row.sessionId) || turnId === input.lease.turnId
    || (!crossSession && row.sessionId !== input.lease.sessionId) || row.userId !== input.lease.userId
    || row.rootTaskId !== rootTaskId || row.taskId !== rootTaskId || row.taskTurnId !== turnId
    || row.parentTaskId !== null || row.taskRole !== "orchestrator" || row.taskType !== "root"
    || !["completed", "failed", "interrupted"].includes(String(row.turnStatus))
    || row.turnStatus !== row.taskStatus || hasSelectedJobPreparation(row.input)) return undefined
  if (crossSession && (row.sourceSessionUserId !== input.lease.userId || ["aborted", "archived"].includes(String(row.sourceSessionStatus))
    || rootTaskHistoryOrigin(row.turnSource, row.input) !== fence.currentOrigin)) return undefined
  const start = validStart(row, turnId, rootTaskId)
  const terminal = start === undefined ? undefined : validTerminal(row, turnId, rootTaskId, String(row.turnStatus), start)
  const terminalAt = row.terminalCreatedAt instanceof Date && Number.isFinite(row.terminalCreatedAt.getTime()) ? row.terminalCreatedAt : undefined
  if (start === undefined || terminal === undefined || start >= terminal
    || (!crossSession && terminal >= fence.currentStartSequence)
    || (crossSession && (!fence.currentStartCreatedAt || !terminalAt
      || terminalAt.getTime() >= fence.currentStartCreatedAt.getTime()))
    || objectiveDigest(row.input, row.goal, row.successCriteria) !== fence.objectiveDigest) return undefined
  return { sessionId: row.sessionId, turnId, rootTaskId, terminalSequence: terminal, ...(crossSession && terminalAt ? { terminalAt } : {}) }
}

export async function readRootTaskHistoryCandidates(client: Client, input: RootTaskHistoryFenceInput, fence: RootTaskHistoryFence): Promise<RootTaskHistoryCandidate[]> {
  const crossSession = input.crossSessionRootTaskHistoryEnabled === true
  if (crossSession && (!(fence.currentStartCreatedAt instanceof Date)
    || !Number.isFinite(fence.currentStartCreatedAt.getTime()) || !fence.currentOrigin)) return []
  const window = crossSession
    ? `SELECT event."sessionId", event."turnId", event."taskId", event."sequence", event."createdAt"
      FROM "agent_events" AS event
      JOIN "agent_sessions" AS current_session ON current_session."id" = $1 AND current_session."userId" = $2
        AND current_session."status" NOT IN ('aborted', 'archived')
      JOIN "agent_sessions" AS source_session ON source_session."id" = event."sessionId"
        AND source_session."userId" = $2 AND source_session."status" NOT IN ('aborted', 'archived')
      WHERE event."createdAt" < $4::timestamptz AND event."type" IN ('turn.completed', 'turn.failed', 'turn.interrupted')
      ORDER BY event."createdAt" DESC, event."turnId" DESC`
    : `SELECT event."sessionId", event."turnId", event."taskId", event."sequence"
      FROM "agent_events" AS event WHERE event."sessionId" = $1 AND event."sequence" < $4::bigint
        AND event."type" IN ('turn.completed', 'turn.failed', 'turn.interrupted')
      ORDER BY event."sequence" DESC`
  const result = await client.query<Row>(`WITH terminal_window AS MATERIALIZED (
      ${window}
      LIMIT $5
    ), roots AS (
      SELECT turn."id" AS "turnId", turn."sessionId", turn."userId", turn."rootTaskId", turn."status" AS "turnStatus", turn."input",
        turn."source" AS "turnSource", session."userId" AS "sourceSessionUserId", session."status" AS "sourceSessionStatus",
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
      terminal."payload" AS "terminalPayload", terminal."createdAt" AS "terminalCreatedAt", terminal."terminalEventCount",
      terminal_step."id" AS "terminalStepId", terminal_step."sessionId" AS "terminalStepSessionId",
      terminal_step."turnId" AS "terminalStepTurnId", terminal_step."taskId" AS "terminalStepTaskId",
      terminal_step."status" AS "terminalStepStatus",
      terminal_step_event."sessionId" AS "terminalStepEventSessionId", terminal_step_event."turnId" AS "terminalStepEventTurnId",
      terminal_step_event."taskId" AS "terminalStepEventTaskId", terminal_step_event."itemId" AS "terminalStepEventItemId",
      terminal_step_event."sequence" AS "terminalStepEventSequence", terminal_step_event."type" AS "terminalStepEventType",
      terminal_step_event."actor" AS "terminalStepEventActor", terminal_step_event."correlationId" AS "terminalStepEventCorrelationId",
      terminal_step_event."idempotencyKey" AS "terminalStepEventIdempotencyKey", terminal_step_event."payload" AS "terminalStepEventPayload",
      terminal_step_event."stepCompletedEventCount" AS "terminalStepEventCount"
    FROM roots
    JOIN LATERAL (
      SELECT event."turnId", event."taskId", event."itemId", event."sequence", event."type", event."actor",
        event."correlationId", event."idempotencyKey", event."payload", event."createdAt", COUNT(*) OVER () AS "terminalEventCount"
      FROM "agent_events" AS event WHERE event."sessionId" = roots."sessionId" AND event."turnId" = roots."turnId"
        AND event."taskId" = roots."rootTaskId" AND event."type" IN ('turn.completed', 'turn.failed', 'turn.interrupted')
      ORDER BY event."sequence" DESC LIMIT 1
    ) AS terminal ON true
    LEFT JOIN LATERAL (
      SELECT step."id", step."sessionId", step."turnId", step."taskId", step."status"
      FROM "agent_steps" AS step
      WHERE terminal."type" = 'turn.completed'
        AND step."id" = terminal."correlationId"
        AND step."sessionId" = roots."sessionId"
        AND step."turnId" = roots."turnId"
        AND step."taskId" = roots."rootTaskId"
      LIMIT 1
    ) AS terminal_step ON true
    LEFT JOIN LATERAL (
      SELECT event."sessionId", event."turnId", event."taskId", event."itemId", event."sequence", event."type", event."actor",
        event."correlationId", event."idempotencyKey", event."payload", COUNT(*) OVER () AS "stepCompletedEventCount"
      FROM "agent_events" AS event
      WHERE terminal."type" = 'turn.completed' AND event."sessionId" = roots."sessionId"
        AND event."turnId" = roots."turnId" AND event."taskId" = roots."rootTaskId"
        AND (event."idempotencyKey" = ('turn:' || roots."turnId" || ':event:step-completed:' || terminal_step."id")
          OR (event."type" = 'step.completed' AND event."correlationId" = terminal_step."id"))
      ORDER BY event."sequence" DESC LIMIT 1
    ) AS terminal_step_event ON true
    LEFT JOIN LATERAL (
      SELECT event."turnId", event."taskId", event."itemId", event."sequence", event."type", event."actor",
        event."correlationId", event."idempotencyKey", event."payload", COUNT(*) OVER () AS "startEventCount"
      FROM "agent_events" AS event WHERE event."sessionId" = roots."sessionId" AND event."turnId" = roots."turnId"
        AND event."taskId" = roots."rootTaskId" AND event."type" = 'turn.started'
      ORDER BY event."sequence" DESC LIMIT 1
    ) AS started ON true
    WHERE ${crossSession ? 'terminal."createdAt" < $4::timestamptz' : 'terminal."sequence" < $4::bigint'}
      AND (terminal."type" <> 'turn.completed' OR terminal_step."id" = terminal."correlationId")
    ORDER BY ${crossSession ? 'terminal."createdAt" DESC, roots."turnId" DESC' : 'terminal."sequence" DESC, roots."turnId" DESC'}`,
  [input.lease.sessionId, input.lease.userId, input.lease.turnId,
    crossSession ? fence.currentStartCreatedAt : String(fence.currentStartSequence), SCAN_LIMIT])
  const output: RootTaskHistoryCandidate[] = [], seen = new Set<string>()
  for (const row of result.rows) {
    const value = candidate(row, input, fence)
    if (!value) continue
    const key = JSON.stringify([value.turnId, value.rootTaskId])
    if (!seen.has(key)) { seen.add(key); output.push(value) }
  }
  return output
}
