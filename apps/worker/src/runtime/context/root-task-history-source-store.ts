import { Buffer } from "node:buffer"
import type pg from "pg"
import { type RootTaskHistoryFence, type RootTaskHistoryFenceInput } from "./root-task-history-fence.js"
import { parseRootTaskHistoryChronologyXid8, readRootTaskHistoryChronologyWitness } from "./root-task-history-chronology-witness.js"
import { OBJECTIVE_HISTORY_INDEX_SEMANTICS_VERSION } from "./objective-history-projection.js"
import { scheduledAutomationHistoryCompatibilitySql } from "../subagents/scheduled-automation-snapshot.js"
import { buildRootTaskHistoryCrossSessionWindow, type RootTaskHistoryCrossSessionCursor } from "./root-task-history-source-window.js"
import { parseRootTaskHistoryPage, scanRootTaskHistoryPages, validateRootTaskHistoryCandidate,
  buildRootTaskHistorySameSessionPageWindow,
  type RootTaskHistoryCandidate, type RootTaskHistoryPage, type RootTaskHistorySourceCursor } from "./root-task-history-source-page.js"

type Client = pg.PoolClient
type Row = Record<string, unknown>
export type { RootTaskHistoryCandidate } from "./root-task-history-source-page.js"

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

async function readCandidateWindowPage(client: Client, input: RootTaskHistoryFenceInput, fence: RootTaskHistoryFence,
  indexed: boolean, cursor: RootTaskHistorySourceCursor | undefined, limit: number): Promise<RootTaskHistoryPage> {
  const crossSession = input.crossSessionRootTaskHistoryEnabled === true
  const compatibilityParameter = indexed ? "$7" : "$5"
  const compatibility = scheduledAutomationHistoryCompatibilitySql(compatibilityParameter)
  const crossCursor = crossSession ? cursor as RootTaskHistoryCrossSessionCursor | undefined : undefined
  const crossWindow = crossSession ? buildRootTaskHistoryCrossSessionWindow({
    currentSessionId: input.lease.sessionId, userId: input.lease.userId, currentTurnId: input.lease.turnId,
    currentStartXid8: fence.currentStartWitness!.xid8,
    scheduledCriteria: fence.scheduledAutomationCriteria ? JSON.stringify(fence.scheduledAutomationCriteria) : null,
    objectiveDigest: fence.objectiveDigest, semanticsVersion: OBJECTIVE_HISTORY_INDEX_SEMANTICS_VERSION,
    canonicalOrigin: fence.currentOrigin!, limit, ...(crossCursor ? { afterCursor: crossCursor } : {}),
  }) : undefined
  const legacyWindow = `SELECT event."id" AS "terminalEventId", event."sessionId", event."turnId", event."taskId", event."sequence",
      NULL::timestamptz AS "createdAt",
      NULL::text AS "terminalWitnessEventId", NULL::text AS "terminalWitnessXid8", 0::bigint AS "terminalWitnessCount"
    FROM "agent_events" AS event
    JOIN "agent_turns" AS turn ON turn."id" = event."turnId" AND turn."sessionId" = event."sessionId"
    WHERE event."sessionId" = $1 AND event."sequence" < $4::bigint
      AND event."type" IN ('turn.completed', 'turn.failed', 'turn.interrupted') AND ${compatibility}
      /* ROOT_HISTORY_CURSOR */
      ORDER BY event."sequence" DESC, event."turnId"::text COLLATE "C" DESC, event."id"::text COLLATE "C" DESC`
  const indexedWindow = `SELECT NULL::text AS "terminalEventId", turn."sessionId", turn."id" AS "turnId",
        turn."rootTaskId" AS "taskId", turn."terminalEventSequence" AS "sequence", turn."terminalEventAt" AS "createdAt",
        NULL::text AS "terminalWitnessEventId",
        NULL::text AS "terminalWitnessXid8", 0::bigint AS "terminalWitnessCount"
      FROM "agent_turns" AS turn
      WHERE turn."sessionId" = $1 AND turn."userId" = $2 AND turn."id" <> $3
        AND turn."terminalEventSequence" < $4::bigint AND turn."objectiveDigest" = $5
        AND turn."objectiveIndexSemanticsVersion" = $6
        AND ${compatibility}
      /* ROOT_HISTORY_CURSOR */
      ORDER BY turn."terminalEventSequence" DESC, turn."id"::text COLLATE "C" DESC`
  const sameWindow = indexed ? indexedWindow : legacyWindow
  const samePageWindow = crossWindow ? undefined : buildRootTaskHistorySameSessionPageWindow(sameWindow, indexed, cursor, limit)
  const window = crossWindow?.sql ?? samePageWindow!.sql
  const projectionColumns = indexed ? `, turn."objectiveDigest" AS "turnObjectiveDigest",
      turn."canonicalOriginDigest" AS "turnCanonicalOriginDigest",
      turn."objectiveIndexSemanticsVersion" AS "turnObjectiveIndexSemanticsVersion",
      turn."terminalEventSequence" AS "indexedTerminalSequence", turn."terminalEventAt" AS "indexedTerminalAt"` : ""
  const locatorGuard = indexed ? `AND terminal."sequence" = roots."indexedTerminalSequence"
      AND terminal."createdAt" = roots."indexedTerminalAt"` : ""
  const pageSequenceProjection = crossSession ? 'NULL::text AS "pageCursorSequence"' : 'page."pageCursorSequence"'
  const scheduleCriteria = fence.scheduledAutomationCriteria ? JSON.stringify(fence.scheduledAutomationCriteria) : null
  const values: unknown[] = crossWindow ? [...crossWindow.values] : (indexed
    ? [input.lease.sessionId, input.lease.userId, input.lease.turnId, String(fence.currentStartSequence),
        fence.objectiveHistoryIndexObjectiveDigest, OBJECTIVE_HISTORY_INDEX_SEMANTICS_VERSION, scheduleCriteria, limit,
        ...samePageWindow!.cursorValues]
    : [input.lease.sessionId, input.lease.userId, input.lease.turnId, String(fence.currentStartSequence), scheduleCriteria, limit,
        ...samePageWindow!.cursorValues])
  const result = await client.query<Row>(`WITH terminal_window AS MATERIALIZED (${window}), page_meta AS MATERIALIZED (
      SELECT ${pageSequenceProjection}, page."pageCursorXid8", page."pageCursorTurnId",
        page."pageCursorTerminalEventId", page."pageCursorWitnessEventId", page."pageRawRowCount",
        COUNT(*) OVER ()::integer AS "pageSentinelCount", current_setting('server_encoding') AS "pageServerEncoding"
      FROM terminal_window AS page WHERE page."isPageWatermark" = TRUE
    ), roots AS (
      SELECT turn."id" AS "turnId", turn."sessionId", turn."userId", turn."rootTaskId", turn."status" AS "turnStatus", turn."input",
        turn."source" AS "turnSource"${projectionColumns}, session."userId" AS "sourceSessionUserId", session."status" AS "sourceSessionStatus",
        terminal_event."terminalEventId" AS "windowTerminalEventId", terminal_event."terminalWitnessEventId",
        terminal_event."terminalWitnessXid8", terminal_event."terminalWitnessCount",
        task."id" AS "taskId", task."turnId" AS "taskTurnId", task."rootTaskId" AS "taskRootTaskId", task."parentTaskId",
        task."role" AS "taskRole", task."taskType", task."status" AS "taskStatus", task."goal", task."successCriteria"
      FROM terminal_window AS terminal_event
      JOIN "agent_turns" AS turn ON turn."id" = terminal_event."turnId" AND turn."sessionId" = terminal_event."sessionId"
      JOIN "agent_sessions" AS session ON session."id" = turn."sessionId" AND session."userId" = $2
      JOIN "sub_agent_tasks" AS task ON task."id" = turn."rootTaskId" AND task."sessionId" = turn."sessionId"
        AND task."turnId" = turn."id" AND task."rootTaskId" = task."id"
      WHERE terminal_event."isPageWatermark" = FALSE AND turn."userId" = $2 AND turn."id" <> $3
        AND terminal_event."taskId" = turn."rootTaskId"
        AND turn."status" IN ('completed', 'failed', 'interrupted')
        AND task."status" IN ('completed', 'failed', 'interrupted')
        AND task."parentTaskId" IS NULL AND task."role" = 'orchestrator' AND task."taskType" = 'root'
    ), candidates AS (
    SELECT roots.*,
      started."turnId" AS "startTurnId", started."taskId" AS "startTaskId", started."itemId" AS "startItemId",
      started."sequence" AS "startSequence", started."type" AS "startType", started."actor" AS "startActor",
      started."correlationId" AS "startCorrelationId", started."idempotencyKey" AS "startIdempotencyKey",
      started."payload" AS "startPayload", started."startEventCount",
      terminal."turnId" AS "terminalTurnId", terminal."taskId" AS "terminalTaskId", terminal."itemId" AS "terminalItemId",
      terminal."sequence" AS "terminalSequence", terminal."type" AS "terminalType", terminal."actor" AS "terminalActor",
      terminal."correlationId" AS "terminalCorrelationId", terminal."idempotencyKey" AS "terminalIdempotencyKey",
      terminal."payload" AS "terminalPayload", terminal."createdAt" AS "terminalCreatedAt", terminal."id" AS "terminalEventId", terminal."terminalEventCount",
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
    WHERE ${crossSession ? 'terminal."id" = roots."windowTerminalEventId"' : 'terminal."sequence" < $4::bigint'}
      ${locatorGuard}
      AND (terminal."type" <> 'turn.completed' OR terminal_step."id" = terminal."correlationId")
    )
    SELECT candidates.*, (candidates."turnId" IS NULL) AS "isPageWatermark",
      page_meta."pageCursorSequence", page_meta."pageCursorXid8", page_meta."pageCursorTurnId",
      page_meta."pageCursorTerminalEventId", page_meta."pageCursorWitnessEventId",
      page_meta."pageRawRowCount", page_meta."pageSentinelCount", page_meta."pageServerEncoding"
    FROM page_meta LEFT JOIN candidates ON TRUE
    ORDER BY CASE WHEN candidates."turnId" IS NULL THEN 1 ELSE 0 END,
      ${crossSession
        ? '(candidates."terminalWitnessXid8")::numeric DESC NULLS LAST, candidates."turnId"::text COLLATE "C" DESC NULLS LAST, candidates."terminalEventId"::text COLLATE "C" DESC NULLS LAST, candidates."terminalWitnessEventId"::text COLLATE "C" DESC NULLS LAST'
        : 'candidates."terminalSequence" DESC NULLS LAST, candidates."turnId"::text COLLATE "C" DESC NULLS LAST, candidates."terminalEventId"::text COLLATE "C" DESC NULLS LAST'}`,
  values)
  const page = parseRootTaskHistoryPage(result.rows, crossSession)
  if (!page) throw new Error("Root task history page metadata is invalid")
  return page
}

async function readCandidateWindow(client: Client, input: RootTaskHistoryFenceInput,
  fence: RootTaskHistoryFence): Promise<RootTaskHistoryCandidate[]> {
  const crossSession = input.crossSessionRootTaskHistoryEnabled === true
  const canUseIndex = !crossSession && input.objectiveHistoryIndexEnabled === true
    && !!fence.objectiveHistoryIndexObjectiveDigest
  const indexed = canUseIndex && await objectiveHistoryIndexReady(client)
  return scanRootTaskHistoryPages({
    crossSession,
    readPage: (cursor, limit) => readCandidateWindowPage(client, input, fence, indexed, cursor, limit),
    validate: async row => {
      const value = validateRootTaskHistoryCandidate(row, input, fence, indexed)
      if (!value || !crossSession) return value
      const witness = await readRootTaskHistoryChronologyWitness(client, { boundaryEventId: value.terminalEventId,
        boundary: "root_terminal", userId: input.lease.userId, sessionId: value.sessionId,
        turnId: value.turnId, rootTaskId: value.rootTaskId })
      return witness && witness.eventId === value.terminalWitnessEventId && witness.xid8 === value.terminalXid8 ? value : undefined
    },
    identity: value => JSON.stringify([value.turnId, value.rootTaskId]),
  })
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
    if (leftXid !== rightXid) return leftXid > rightXid ? -1 : 1
    const turnOrder = Buffer.compare(Buffer.from(right.turnId, "utf8"), Buffer.from(left.turnId, "utf8"))
    if (turnOrder !== 0) return turnOrder
    const eventOrder = Buffer.compare(Buffer.from(right.terminalEventId, "utf8"), Buffer.from(left.terminalEventId, "utf8"))
    if (eventOrder !== 0) return eventOrder
    return Buffer.compare(Buffer.from(right.terminalWitnessEventId ?? "", "utf8"), Buffer.from(left.terminalWitnessEventId ?? "", "utf8"))
  })
}
