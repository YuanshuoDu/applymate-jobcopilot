import type pg from "pg"
import { restoreToolCallState } from "../turns/persisted-tool-call-state.js"
import { validateTaskGraphReplaySources, validateTaskGraphToolEvents, type TaskGraphReplayReceipt } from "./task-graph-pg-event-validation.js"
import { canonicalTaskGraphReadObservations, validateTaskGraphVerificationItems, type TaskGraphVerificationScope } from "./task-graph-pg-verification-receipt-validation.js"

type Queryable = Pick<pg.PoolClient, "query">
type Row = Record<string, unknown>
const MAX_ITEMS = 1024
const MAX_OBSERVATIONS = 256
const MAX_TOTAL_BYTES = 2 * 1024 * 1024

export type TaskGraphVerificationReceipts = Readonly<{
  items: readonly Row[]
  outcomes: ReadonlyMap<string, "completed" | "failed">
  replayReceipts: readonly TaskGraphReplayReceipt[]
  evidenceObservations: readonly { id: string; content: Row }[]
}>

/** Reconstruct exact-attempt tool receipts and completed read observations under the caller's transaction. */
export async function loadTaskGraphVerificationReceipts(client: Queryable, scope: TaskGraphVerificationScope): Promise<TaskGraphVerificationReceipts> {
  const itemResult = await client.query(`SELECT item."id", item."sessionId", item."turnId", item."taskId", item."stepId",
      item."type", item."status", item."revision", item."content", step."id" AS "joinedStepId", step."status" AS "stepStatus",
      step."attempt" AS "attempt", step."ordinal" AS "ordinal", task."rootTaskId" AS "rootTaskId", turn."rootTaskId" AS "turnRootTaskId"
    FROM "agent_items" AS item
    JOIN "agent_steps" AS step ON step."id" = item."stepId" AND step."sessionId" = item."sessionId"
      AND step."turnId" = item."turnId" AND step."taskId" = item."taskId"
    JOIN "sub_agent_tasks" AS task ON task."id" = item."taskId" AND task."sessionId" = item."sessionId" AND task."turnId" = item."turnId"
    JOIN "agent_sessions" AS session ON session."id" = item."sessionId"
    JOIN "agent_turns" AS turn ON turn."id" = item."turnId" AND turn."sessionId" = item."sessionId"
    WHERE item."taskId" = $1 AND item."sessionId" = $2 AND item."turnId" = $3 AND task."rootTaskId" = $4 AND turn."rootTaskId" = $4
      AND task."parentTaskId" = $5 AND session."userId" = $6 AND turn."userId" = $6
      AND step."attempt" = $7 AND item."type" IN ('tool_call', 'tool_result')
    ORDER BY step."attempt" ASC, step."ordinal" ASC, item."createdAt" ASC, item."id" ASC LIMIT ${MAX_ITEMS + 1}`,
  [scope.taskId, scope.sessionId, scope.turnId, scope.rootTaskId, scope.parentTaskId, scope.userId, scope.attemptCount])
  if (itemResult.rows.length > MAX_ITEMS) throw new Error("task_graph_verification_item_limit")
  const items = validateTaskGraphVerificationItems(itemResult.rows, scope)
  const callIds = items.filter(item => item.type === "tool_call").map(item => String(item.id))
  const eventResult = callIds.length === 0 ? { rows: [] as Row[] } : await client.query(`SELECT event."id", event."itemId", event."taskId", event."correlationId", event."type", event."payload", event."sequence"
    FROM "agent_events" AS event
    JOIN "agent_sessions" AS session ON session."id" = event."sessionId"
    JOIN "agent_turns" AS turn ON turn."id" = event."turnId" AND turn."sessionId" = event."sessionId"
    WHERE event."sessionId" = $1 AND event."turnId" = $2 AND session."userId" = $3 AND turn."userId" = $3
      AND event."itemId" = ANY($4::text[])
      AND event."type" IN ('tool_call.started', 'tool_call.completed', 'tool_call.failed')
    ORDER BY event."sequence" ASC LIMIT ${MAX_ITEMS * 3 + 1}`,
  [scope.sessionId, scope.turnId, scope.userId, callIds])
  if (eventResult.rows.length > MAX_ITEMS * 3) throw new Error("task_graph_verification_event_limit")
  const validation = validateTaskGraphToolEvents(eventResult.rows, items, scope)
  let replayReceipts: readonly TaskGraphReplayReceipt[] = []
  if (validation.replays.length > 0) {
    const resultIds = validation.replays.map(replay => replay.source.resultItemId)
    const sourceRows = await client.query(`SELECT result."sessionId" AS "sourceSessionId", result."turnId" AS "sourceTurnId", result."taskId" AS "sourceTaskId",
        task."rootTaskId" AS "sourceRootTaskId", task."parentTaskId" AS "sourceParentTaskId", turn."rootTaskId" AS "sourceTurnRootTaskId", session."userId" AS "sourceUserId",
        call."id" AS "sourceCallItemId", call."stepId" AS "sourceCallStepId", call."type" AS "sourceCallType",
        call."status" AS "sourceCallStatus", call."revision" AS "sourceCallRevision", call."content" AS "sourceCallContent",
        callStep."attempt" AS "sourceCallAttempt", callStep."ordinal" AS "sourceCallOrdinal",
        result."id" AS "sourceResultItemId", result."stepId" AS "sourceResultStepId", result."type" AS "sourceResultType",
        result."status" AS "sourceResultStatus", result."revision" AS "sourceResultRevision", result."content" AS "sourceResultContent",
        resultStep."attempt" AS "sourceResultAttempt", resultStep."ordinal" AS "sourceResultOrdinal"
      FROM "agent_items" AS result
      JOIN "agent_steps" AS resultStep ON resultStep."id" = result."stepId" AND resultStep."sessionId" = result."sessionId"
        AND resultStep."turnId" = result."turnId" AND resultStep."taskId" = result."taskId"
      JOIN "agent_items" AS call ON call."stepId" = result."stepId" AND call."sessionId" = result."sessionId"
        AND call."turnId" = result."turnId" AND call."taskId" = result."taskId" AND call."type" = 'tool_call'
        AND call."content"->>'toolCallId' = result."content"->>'toolCallId'
      JOIN "agent_steps" AS callStep ON callStep."id" = call."stepId" AND callStep."sessionId" = call."sessionId"
        AND callStep."turnId" = call."turnId" AND callStep."taskId" = call."taskId"
      JOIN "sub_agent_tasks" AS task ON task."id" = result."taskId" AND task."sessionId" = result."sessionId" AND task."turnId" = result."turnId"
      JOIN "agent_sessions" AS session ON session."id" = result."sessionId"
      JOIN "agent_turns" AS turn ON turn."id" = result."turnId" AND turn."sessionId" = result."sessionId"
      WHERE result."id" = ANY($7::text[]) AND result."type" = 'tool_result' AND result."taskId" = $1 AND result."sessionId" = $2
        AND result."turnId" = $3 AND task."rootTaskId" = $4 AND turn."rootTaskId" = $4 AND task."parentTaskId" = $5
        AND session."userId" = $6 AND turn."userId" = $6 AND resultStep."attempt" >= 1 AND resultStep."attempt" < $8
      ORDER BY result."id" LIMIT ${MAX_ITEMS + 1}`,
    [scope.taskId, scope.sessionId, scope.turnId, scope.rootTaskId, scope.parentTaskId, scope.userId, resultIds, scope.attemptCount])
    if (sourceRows.rows.length > MAX_ITEMS) throw new Error("task_graph_verification_replay_limit")
    const sourceCallIds = sourceRows.rows.map(row => String((row as Row).sourceCallItemId))
    const sourceEvents = sourceCallIds.length === 0 ? { rows: [] as Row[] } : await client.query(`SELECT event."id", session."userId" AS "userId", event."sessionId", event."turnId", event."itemId", event."taskId", event."correlationId", event."type", event."payload", event."sequence"
      FROM "agent_events" AS event JOIN "agent_sessions" AS session ON session."id" = event."sessionId"
      JOIN "agent_turns" AS turn ON turn."id" = event."turnId" AND turn."sessionId" = event."sessionId"
      WHERE event."sessionId" = $1 AND event."turnId" = $2 AND session."userId" = $3 AND turn."userId" = $3
        AND event."itemId" = ANY($4::text[]) AND event."taskId" = $5
        AND event."type" IN ('tool_call.started', 'tool_call.completed', 'tool_call.failed')
      ORDER BY event."sequence" ASC LIMIT ${MAX_ITEMS * 3 + 1}`,
    [scope.sessionId, scope.turnId, scope.userId, sourceCallIds, scope.taskId])
    if (sourceEvents.rows.length > MAX_ITEMS * 3) throw new Error("task_graph_verification_replay_event_limit")
    replayReceipts = validateTaskGraphReplaySources(validation.replays, sourceRows.rows, sourceEvents.rows, items, scope)
  }
  const restored = restoreToolCallState(items, eventResult.rows)
  if (restored.pending.length > 0 || restored.observations.length > MAX_OBSERVATIONS) throw new Error("task_graph_verification_observation_limit")
  const restoredBytes = JSON.stringify(restored.observations)
  if (restoredBytes === undefined || Buffer.byteLength(restoredBytes, "utf8") > MAX_TOTAL_BYTES) throw new Error("task_graph_verification_observation_limit")
  return { items, outcomes: validation.outcomes, replayReceipts, evidenceObservations: canonicalTaskGraphReadObservations(items, validation.outcomes) }
}
