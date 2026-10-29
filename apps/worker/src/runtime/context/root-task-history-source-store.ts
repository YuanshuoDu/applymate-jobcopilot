import type pg from "pg"
import { hasSelectedJobPreparation, rootTaskHistoryIndexKeys, rootTaskHistoryObjectiveDigest, rootTaskHistoryOrigin, type RootTaskHistoryFence, type RootTaskHistoryFenceInput } from "./root-task-history-fence.js"
import { parseRootTaskHistoryChronologyXid8, readRootTaskHistoryChronologyWitness } from "./root-task-history-chronology-witness.js"
import { OBJECTIVE_HISTORY_INDEX_SEMANTICS_VERSION } from "./objective-history-projection.js"
import { isScheduledAutomationTurn, sameScheduledAutomationCriteria, scheduledAutomationCriteria, scheduledAutomationHistoryCompatibilitySql } from "../subagents/scheduled-automation-snapshot.js"
import { buildRootTaskHistoryCrossSessionWindow } from "./root-task-history-source-window.js"
import {
  isHistoryReceiptText as text,
  parseHistoryReceiptSequence as sequence,
  validateHistoryStartReceipt as validStart,
  validateHistoryTerminalReceipt as validTerminal,
} from "./root-task-history-terminal-receipts.js"

type Client = pg.PoolClient
type Row = Record<string, unknown>
const SCAN_LIMIT = 64

export type RootTaskHistoryCandidate = Readonly<{
  sessionId: string
  turnId: string
  rootTaskId: string
  terminalEventId: string
  terminalSequence: bigint
  terminalXid8?: string
  terminalWitnessEventId?: string
}>

function candidate(row: Row, input: RootTaskHistoryFenceInput, fence: RootTaskHistoryFence, indexed = false): RootTaskHistoryCandidate | undefined {
  const turnId = row.turnId, rootTaskId = row.taskRootTaskId
  const crossSession = input.crossSessionRootTaskHistoryEnabled === true
  const terminalEventId = text(row.terminalEventId) ? row.terminalEventId : undefined
  const scheduledTurn = isScheduledAutomationTurn(row.turnSource, row.input)
  const scheduledCriteria = scheduledTurn ? scheduledAutomationCriteria(row.input) : undefined
  if (!text(turnId) || !text(rootTaskId) || !text(row.sessionId) || !terminalEventId || turnId === input.lease.turnId
    || (!crossSession && row.sessionId !== input.lease.sessionId) || row.userId !== input.lease.userId
    || (crossSession && row.sessionId === input.lease.sessionId)
    || row.rootTaskId !== rootTaskId || row.taskId !== rootTaskId || row.taskTurnId !== turnId
    || row.parentTaskId !== null || row.taskRole !== "orchestrator" || row.taskType !== "root"
    || !["completed", "failed", "interrupted"].includes(String(row.turnStatus))
    || row.turnStatus !== row.taskStatus || hasSelectedJobPreparation(row.input)) return undefined
  if (fence.scheduledAutomationCriteria
    ? !scheduledTurn || !scheduledCriteria || !sameScheduledAutomationCriteria(scheduledCriteria, fence.scheduledAutomationCriteria)
    : scheduledTurn) return undefined
  if (crossSession && (row.sourceSessionUserId !== input.lease.userId || ["aborted", "archived"].includes(String(row.sourceSessionStatus))
    || rootTaskHistoryOrigin(row.turnSource, row.input) !== fence.currentOrigin)) return undefined
  const start = validStart(row, turnId, rootTaskId)
  const terminal = start === undefined ? undefined : validTerminal(row, turnId, rootTaskId, String(row.turnStatus), start)
  const terminalAt = row.terminalCreatedAt instanceof Date && Number.isFinite(row.terminalCreatedAt.getTime()) ? row.terminalCreatedAt : undefined
  const terminalXid8 = crossSession ? row.terminalWitnessXid8 : undefined
  const terminalWitnessEventId = crossSession ? row.terminalWitnessEventId : undefined
  const terminalOrder = crossSession ? parseRootTaskHistoryChronologyXid8(terminalXid8) : undefined
  const startOrder = crossSession && fence.currentStartWitness ? parseRootTaskHistoryChronologyXid8(fence.currentStartWitness.xid8) : undefined
  if (start === undefined || terminal === undefined || start >= terminal
    || (!crossSession && terminal >= fence.currentStartSequence)
    || (crossSession && (!startOrder || !terminalOrder || terminalOrder >= startOrder
      || !text(terminalWitnessEventId) || Number(row.terminalWitnessCount) !== 1))
    || rootTaskHistoryObjectiveDigest(row.input, { goal: row.goal, successCriteria: row.successCriteria }) !== fence.objectiveDigest) return undefined
  if (indexed) {
    const keys = rootTaskHistoryIndexKeys(row.turnSource, row.input, { goal: row.goal, successCriteria: row.successCriteria }, crossSession)
    if (!keys || row.turnObjectiveDigest !== keys.objectiveDigest
      || keys.objectiveDigest !== fence.objectiveHistoryIndexObjectiveDigest
      || row.turnObjectiveIndexSemanticsVersion !== OBJECTIVE_HISTORY_INDEX_SEMANTICS_VERSION
      || sequence(row.indexedTerminalSequence) !== terminal
      || !(row.indexedTerminalAt instanceof Date) || row.indexedTerminalAt.getTime() !== terminalAt?.getTime()) return undefined
    if (crossSession && (!keys.canonicalOriginDigest
      || row.turnCanonicalOriginDigest !== keys.canonicalOriginDigest
      || keys.canonicalOriginDigest !== fence.objectiveHistoryIndexCanonicalOriginDigest)) return undefined
  }
  return { sessionId: row.sessionId, turnId, rootTaskId, terminalEventId, terminalSequence: terminal,
    ...(crossSession && terminalOrder ? { terminalXid8: terminalOrder.toString(), terminalWitnessEventId: terminalWitnessEventId as string } : {}) }
}

async function objectiveHistoryIndexReady(client: Client): Promise<boolean> {
  const result = await client.query<Row>(`SELECT "indexName", "semanticsVersion", "isReady"
    FROM "agent_objective_history_index_readiness"
    WHERE "indexName" = $1 AND "semanticsVersion" = $2 AND "isReady" = TRUE
    FOR SHARE`,
  ["agent_turns_objective_history", OBJECTIVE_HISTORY_INDEX_SEMANTICS_VERSION])
  return result.rows.length === 1 && result.rows[0]?.indexName === "agent_turns_objective_history"
    && result.rows[0]?.semanticsVersion === OBJECTIVE_HISTORY_INDEX_SEMANTICS_VERSION
    && result.rows[0]?.isReady === true
}

async function readCandidateWindow(client: Client, input: RootTaskHistoryFenceInput, fence: RootTaskHistoryFence): Promise<RootTaskHistoryCandidate[]> {
  const crossSession = input.crossSessionRootTaskHistoryEnabled === true
  const canUseIndex = !crossSession && input.objectiveHistoryIndexEnabled === true
    && !!fence.objectiveHistoryIndexObjectiveDigest
  const indexed = canUseIndex && await objectiveHistoryIndexReady(client)
  const compatibilityParameter = indexed ? "$7" : "$5"
  const compatibility = scheduledAutomationHistoryCompatibilitySql(compatibilityParameter)
  const crossWindow = crossSession ? buildRootTaskHistoryCrossSessionWindow({
    currentSessionId: input.lease.sessionId, userId: input.lease.userId, currentTurnId: input.lease.turnId,
    currentStartXid8: fence.currentStartWitness!.xid8,
    scheduledCriteria: fence.scheduledAutomationCriteria ? JSON.stringify(fence.scheduledAutomationCriteria) : null,
    objectiveDigest: fence.objectiveDigest, semanticsVersion: OBJECTIVE_HISTORY_INDEX_SEMANTICS_VERSION,
    canonicalOrigin: fence.currentOrigin!, limit: SCAN_LIMIT,
  }) : undefined
  const legacyWindow = crossWindow?.sql ?? `SELECT event."id" AS "terminalEventId", event."sessionId", event."turnId", event."taskId", event."sequence",
      NULL::text AS "terminalWitnessEventId", NULL::text AS "terminalWitnessXid8", 0::bigint AS "terminalWitnessCount"
    FROM "agent_events" AS event
    JOIN "agent_turns" AS turn ON turn."id" = event."turnId" AND turn."sessionId" = event."sessionId"
    WHERE event."sessionId" = $1 AND event."sequence" < $4::bigint
      AND event."type" IN ('turn.completed', 'turn.failed', 'turn.interrupted') AND ${compatibility}
    ORDER BY event."sequence" DESC`
  const indexedWindow = `SELECT turn."sessionId", turn."id" AS "turnId", turn."rootTaskId" AS "taskId",
        turn."terminalEventSequence" AS "sequence", turn."terminalEventAt" AS "createdAt",
        NULL::text AS "terminalEventId", NULL::text AS "terminalWitnessEventId",
        NULL::text AS "terminalWitnessXid8", 0::bigint AS "terminalWitnessCount"
      FROM "agent_turns" AS turn
      WHERE turn."sessionId" = $1 AND turn."userId" = $2 AND turn."id" <> $3
        AND turn."terminalEventSequence" < $4::bigint AND turn."objectiveDigest" = $5
        AND turn."objectiveIndexSemanticsVersion" = $6
        AND ${compatibility}
      ORDER BY turn."terminalEventSequence" DESC, turn."id" DESC`
  const window = indexed ? indexedWindow : legacyWindow
  const limit = indexed ? "$8" : "$6"
  const projectionColumns = indexed ? `, turn."objectiveDigest" AS "turnObjectiveDigest",
      turn."canonicalOriginDigest" AS "turnCanonicalOriginDigest",
      turn."objectiveIndexSemanticsVersion" AS "turnObjectiveIndexSemanticsVersion",
      turn."terminalEventSequence" AS "indexedTerminalSequence", turn."terminalEventAt" AS "indexedTerminalAt"` : ""
  const locatorGuard = indexed ? `AND terminal."sequence" = roots."indexedTerminalSequence"
      AND terminal."createdAt" = roots."indexedTerminalAt"` : ""
  const scheduleCriteria = fence.scheduledAutomationCriteria ? JSON.stringify(fence.scheduledAutomationCriteria) : null
  const values: unknown[] = crossWindow ? [...crossWindow.values] : (indexed
    ? [input.lease.sessionId, input.lease.userId, input.lease.turnId, String(fence.currentStartSequence),
        fence.objectiveHistoryIndexObjectiveDigest, OBJECTIVE_HISTORY_INDEX_SEMANTICS_VERSION, scheduleCriteria, SCAN_LIMIT]
    : [input.lease.sessionId, input.lease.userId, input.lease.turnId, String(fence.currentStartSequence), scheduleCriteria, SCAN_LIMIT])
  const result = await client.query<Row>(`WITH terminal_window AS MATERIALIZED (
      ${window}
      ${crossWindow ? "" : `LIMIT ${limit}`}
    ), roots AS (
      SELECT turn."id" AS "turnId", turn."sessionId", turn."userId", turn."rootTaskId", turn."status" AS "turnStatus", turn."input",
        turn."source" AS "turnSource"${projectionColumns}, session."userId" AS "sourceSessionUserId", session."status" AS "sourceSessionStatus",
        terminal_event."terminalEventId", terminal_event."terminalWitnessEventId", terminal_event."terminalWitnessXid8", terminal_event."terminalWitnessCount",
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
      terminal."payload" AS "terminalPayload", terminal."createdAt" AS "terminalCreatedAt", terminal."id" AS "terminalEventId", terminal."terminalEventCount",
      roots."terminalWitnessEventId", roots."terminalWitnessXid8", roots."terminalWitnessCount",
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
      SELECT event."id", event."turnId", event."taskId", event."itemId", event."sequence", event."type", event."actor",
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
    WHERE ${crossSession ? 'terminal."id" = roots."terminalEventId"' : 'terminal."sequence" < $4::bigint'}
      ${locatorGuard}
      AND (terminal."type" <> 'turn.completed' OR terminal_step."id" = terminal."correlationId")
    ORDER BY ${crossSession ? '(roots."terminalWitnessXid8")::numeric DESC, roots."turnId" DESC' : 'terminal."sequence" DESC, roots."turnId" DESC'}`,
  values)
  const output: RootTaskHistoryCandidate[] = [], seen = new Set<string>()
  for (const row of result.rows) {
    const value = candidate(row, input, fence, indexed)
    if (!value) continue
    if (crossSession) {
      const witness = await readRootTaskHistoryChronologyWitness(client, { boundaryEventId: String(row.terminalEventId),
        boundary: "root_terminal", userId: input.lease.userId, sessionId: value.sessionId, turnId: value.turnId, rootTaskId: value.rootTaskId })
      if (!witness || witness.eventId !== value.terminalWitnessEventId || witness.xid8 !== value.terminalXid8) continue
    }
    const key = JSON.stringify([value.turnId, value.rootTaskId])
    if (!seen.has(key)) { seen.add(key); output.push(value) }
  }
  return output
}

export async function readRootTaskHistoryCandidates(client: Client, input: RootTaskHistoryFenceInput, fence: RootTaskHistoryFence): Promise<RootTaskHistoryCandidate[]> {
  if (input.crossSessionRootTaskHistoryEnabled !== true) return readCandidateWindow(client, input, fence)
  if (!fence.currentStartWitness || !fence.currentOrigin) return readCandidateWindow(client, { ...input, crossSessionRootTaskHistoryEnabled: false }, fence)
  const sameSession = await readCandidateWindow(client, { ...input, crossSessionRootTaskHistoryEnabled: false }, fence)
  const startXid8 = parseRootTaskHistoryChronologyXid8(fence.currentStartWitness.xid8)
  if (!startXid8) return sameSession
  const orderedSameSession: RootTaskHistoryCandidate[] = []
  let unverified = false
  for (const source of sameSession) {
    const witness = await readRootTaskHistoryChronologyWitness(client, { boundaryEventId: source.terminalEventId,
      boundary: "root_terminal", userId: input.lease.userId, sessionId: source.sessionId, turnId: source.turnId, rootTaskId: source.rootTaskId })
    const terminalXid8 = witness && parseRootTaskHistoryChronologyXid8(witness.xid8)
    if (!witness) { orderedSameSession.push(source); unverified = true; continue }
    if (!terminalXid8) { unverified = true; continue }
    if (terminalXid8 >= startXid8) continue
    orderedSameSession.push({ ...source, terminalXid8: witness.xid8, terminalWitnessEventId: witness.eventId })
  }
  if (unverified) return orderedSameSession
  const combined = [...orderedSameSession, ...await readCandidateWindow(client, input, fence)]
  return combined.sort((left, right) => {
    const leftXid = BigInt(left.terminalXid8!), rightXid = BigInt(right.terminalXid8!)
    return leftXid > rightXid ? -1 : leftXid < rightXid ? 1 : right.turnId < left.turnId ? -1 : right.turnId > left.turnId ? 1 : 0
  })
}
