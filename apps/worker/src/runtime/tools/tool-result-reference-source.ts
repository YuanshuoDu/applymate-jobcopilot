import type pg from "pg"

import type { ExecutionOwnerFence } from "../execution-owner.js"
import {
  MAX_TOOL_RESULT_BYTES, type CanonicalToolSourceName, prepareToolResultJson, ToolResultSanitizationError,
  type PreparedToolResult,
} from "./tool-result-reference-types.js"

type SourceClient = Pick<pg.PoolClient, "query">
export type CanonicalToolSource = {
  toolName: CanonicalToolSourceName
  taskAttemptCount: number
  role: string
  taskType: string
  ownerKind: ExecutionOwnerFence["kind"]
}
export type SourceScope = Pick<ExecutionOwnerFence, "userId" | "sessionId" | "turnId" | "taskId"> & {
  readonly stepId: string
  readonly toolCallId: string
}

export async function findCanonicalToolSource(client: SourceClient, scope: SourceScope): Promise<CanonicalToolSource | null> {
  const result = await client.query<{ toolName: string | null; taskAttemptCount: number; role: string; taskType: string; ownerKind: string }>(`SELECT item."content"->>'toolName' AS "toolName",
      task."attemptCount" AS "taskAttemptCount", task."role" AS "role", task."taskType" AS "taskType",
      CASE WHEN task."id" = task."rootTaskId" THEN 'turn' ELSE 'task' END AS "ownerKind" FROM "agent_items" AS item
    JOIN "agent_steps" AS step ON step."id" = item."stepId" AND step."sessionId" = item."sessionId" AND step."turnId" = item."turnId" AND step."taskId" = item."taskId"
    JOIN "agent_turns" AS turn ON turn."id" = item."turnId" AND turn."sessionId" = item."sessionId" JOIN "agent_sessions" AS session ON session."id" = item."sessionId" AND session."userId" = turn."userId"
    JOIN "sub_agent_tasks" AS task ON task."id" = item."taskId" AND task."sessionId" = item."sessionId" AND task."turnId" = item."turnId"
    WHERE item."sessionId" = $1 AND item."turnId" = $2 AND item."taskId" = $3 AND item."stepId" = $4 AND item."type" = 'tool_call' AND item."content"->>'toolCallId' = $5
      AND turn."userId" = $6 AND session."userId" = $6 ORDER BY item."id" LIMIT 2`,
  [scope.sessionId, scope.turnId, scope.taskId, scope.stepId, scope.toolCallId, scope.userId])
  const source = result.rows[0]
  if (result.rows.length !== 1 || typeof source?.toolName !== "string" || !Number.isSafeInteger(source.taskAttemptCount)
    || source.taskAttemptCount < 0 || typeof source.role !== "string" || typeof source.taskType !== "string"
    || (source.ownerKind !== "turn" && source.ownerKind !== "task")) return null
  return { toolName: source.toolName as CanonicalToolSourceName, taskAttemptCount: source.taskAttemptCount,
    role: source.role, taskType: source.taskType, ownerKind: source.ownerKind }
}

export type SourcePreparationErrorCode = "tool_result_too_large" | "tool_result_invalid_json" | "tool_result_corrupt"

export function prepareSourceToolResultJson(
  value: unknown,
  source: CanonicalToolSource,
  expectedTaskId: string,
  makeError: (code: SourcePreparationErrorCode) => Error,
): PreparedToolResult {
  let safe: PreparedToolResult
  try { safe = prepareToolResultJson(value, source.toolName, expectedTaskId, source.taskAttemptCount, source.ownerKind) }
  catch (error) {
    const code = error instanceof ToolResultSanitizationError ? error.code : "tool_result_invalid_json"
    throw makeError(code)
  }
  if (safe.bytes > MAX_TOOL_RESULT_BYTES) throw makeError("tool_result_too_large")
  return safe
}
