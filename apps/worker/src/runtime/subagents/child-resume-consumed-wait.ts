import type pg from "pg"
import type { SubagentLease } from "./types.js"
import { markCanonicalSubagentWaitTargetIds } from "./subagent-wait-structural-ids.js"
import { dateValue, DurableSubagentWaitError, object as waitObject, safeSubagentWaitJson, waitResult, type DurableSubagentWaitResult } from "./durable-subagent-wait-store.js"
import { resolveDurableWaitOutcome, sameIds, type DurableWaitResume } from "./child-resume-observations.js"
import { inspectChildWaitSourceLifecycle } from "./child-resume-source-wait-lifecycle.js"

type QueryClient = Pick<pg.PoolClient, "query">
type Row = Record<string, unknown>
const TERMINAL = new Set(["completed", "failed", "interrupted", "cancelled", "closed", "passed", "skipped"])
const TASK_STATUSES = new Set(["queued", "running", "retrying", "waiting", "waiting_for_user", ...TERMINAL])

function strictIds(value: unknown, min = 1): string[] | undefined {
  if (!Array.isArray(value) || value.length < min || value.length > 8
    || !value.every((id: unknown) => typeof id === "string" && !!id.trim() && id === id.trim() && id.length <= 256)
    || new Set(value).size !== value.length) return undefined
  return value as string[]
}

function exactKeys(value: Row, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort(), keys = [...expected].sort()
  return actual.length === keys.length && actual.every((key, index) => key === keys[index])
}

function validStoredOutcome(row: Row, ids: readonly string[], matched: readonly string[]): boolean {
  const stored = waitObject(row.waitResult), outcome = waitObject(stored.outcome), savedIds = strictIds(outcome.taskIds)
  const savedMatched = strictIds(outcome.matchedTaskIds, 0)
  const tasks = Array.isArray(outcome.tasks) ? outcome.tasks.map(waitObject) : []
  const taskIds = strictIds(tasks.map(task => waitObject(task).taskId))
  const terminalIds = tasks.filter(task => TERMINAL.has(String(task.status))).map(task => String(task.taskId))
  const validationRow = { id: row.waitId, status: row.status, mode: row.mode, targetTaskIds: row.targetTaskIds,
    deadlineAt: row.deadlineAt, matchedTaskIds: row.matchedTaskIds, result: row.waitResult }
  try {
    if (!exactKeys(outcome, ["waitId", "status", "taskIds", "deadlineAt", "matchedTaskIds", "tasks"])
      || !tasks.every(task => exactKeys(task, ["taskId", "status", "role", "result", "failureReason"])
        && typeof task.status === "string" && TASK_STATUSES.has(task.status)
        && typeof task.role === "string" && !!task.role.trim()
        && (task.failureReason === null || typeof task.failureReason === "string"))
      || !sameIds(terminalIds, matched)) return false
    resolveDurableWaitOutcome(validationRow, ids, terminalIds, new Date())
    return outcome.waitId === row.waitId && outcome.status === row.status && sameIds(savedIds ?? [], ids)
      && sameIds(savedMatched ?? [], matched) && !!savedMatched && savedMatched.every(id => ids.includes(id))
      && !!taskIds && sameIds(taskIds, ids)
      && dateValue(outcome.deadlineAt, "outcome.deadlineAt").getTime() === dateValue(row.deadlineAt, "deadlineAt").getTime()
  } catch { return false }
}

/** Returns only the already-persisted resolved outcome after the same validation used by resume. */
export function validatedConsumedWaitOutcome(row: Row): DurableSubagentWaitResult {
  const waitId = typeof row.waitId === "string" ? row.waitId : typeof row.id === "string" ? row.id : ""
  const result = row.waitResult ?? row.result
  const normalized = { ...row, id: waitId, waitId, waitResult: result }
  const ids = strictIds(row.targetTaskIds), matched = strictIds(row.matchedTaskIds, 0)
  if (!waitId || !ids || !matched || !validStoredOutcome(normalized, ids, matched)) {
    throw new Error("child_resume_invalid_wait_result")
  }
  return waitResult({ ...normalized, result })
}

function markInputIds(input: Record<string, unknown>, ids: readonly string[]): boolean {
  const inputIds = strictIds(input.taskIds)
  if (!inputIds || !sameIds(inputIds, ids)) return false
  const markerOutcome = { taskIds: inputIds, matchedTaskIds: [], tasks: inputIds.map(taskId => ({ taskId })) }
  return markCanonicalSubagentWaitTargetIds({ targetTaskIds: inputIds }, markerOutcome, inputIds)
}

function validReceipt(row: Row, ids: readonly string[], toolCallId: string): boolean {
  const receipt = waitObject(row.resultContent), projection = waitObject(receipt.output)
  const receiptIds = strictIds(projection.taskIds), matched = strictIds(projection.matchedTaskIds, 0)
  const tasks = Array.isArray(projection.tasks) ? projection.tasks : undefined
  const taskIds = tasks && strictIds(tasks.map(task => waitObject(task).taskId), 0)
  let deadlinesMatch = false
  try {
    deadlinesMatch = dateValue(projection.deadlineAt, "receipt.deadlineAt").getTime()
      === dateValue(row.deadlineAt, "deadlineAt").getTime()
  } catch { return false }
  return receipt.toolCallId === toolCallId && (receipt.errorCode === null || receipt.errorCode === undefined)
    && projection.waitId === row.waitId && projection.status === "waiting" && !!receiptIds && sameIds(receiptIds, ids)
    && !!matched && matched.length === 0 && !!tasks && !!taskIds && taskIds.every(id => ids.includes(id))
    && (!taskIds.length || sameIds(taskIds, ids)) && deadlinesMatch
}

/** Loads an already-consumed child wait through its exact persisted continuation. */
export async function loadChildConsumedWaitResume(client: QueryClient, lease: SubagentLease, waitId?: string): Promise<DurableWaitResume | undefined> {
  if (waitId !== undefined && (!waitId.trim() || waitId !== waitId.trim())) throw new Error("child_resume_wait_lineage")
  const waitIdParam = waitId === undefined ? "" : 'AND candidateWait."id" = $7'
  const exactWaitId = waitId === undefined ? "" : 'AND wait."id" = $7'
  const values: unknown[] = [lease.userId, lease.sessionId, lease.turnId, lease.id, lease.rootTaskId, lease.attemptCount]
  if (waitId !== undefined) values.push(waitId)
  const rows = (await client.query<Row>(`WITH latest_wait AS (
    SELECT candidateWait."id" FROM "agent_wait_conditions" AS candidateWait
    JOIN "agent_steps" AS candidateStep ON candidateStep."id" = candidateWait."stepId" AND candidateStep."sessionId" = candidateWait."sessionId" AND candidateStep."turnId" = candidateWait."turnId" AND candidateStep."taskId" = candidateWait."parentTaskId"
    WHERE candidateWait."userId" = $1 AND candidateWait."sessionId" = $2 AND candidateWait."turnId" = $3 AND candidateWait."parentTaskId" = $4
      AND candidateStep."attempt" <= $6 AND candidateWait."status" IN ('ready', 'timed_out')
      AND candidateWait."suspendedAt" IS NOT NULL AND candidateWait."consumedAt" IS NOT NULL
      AND EXISTS (SELECT 1 FROM "agent_steps" AS next WHERE next."sessionId" = candidateStep."sessionId" AND next."turnId" = candidateStep."turnId"
        AND next."taskId" = candidateStep."taskId" AND next."attempt" = candidateStep."attempt"
        AND next."ordinal" = (SELECT MIN(later."ordinal") FROM "agent_steps" AS later WHERE later."sessionId" = candidateStep."sessionId"
          AND later."turnId" = candidateStep."turnId" AND later."taskId" = candidateStep."taskId" AND later."attempt" = candidateStep."attempt"
          AND later."ordinal" > candidateStep."ordinal")
        )
      ${waitIdParam}
    ORDER BY candidateStep."attempt" DESC, candidateStep."ordinal" DESC, candidateWait."createdAt" DESC, candidateWait."id" DESC LIMIT 1
  )
    SELECT wait."id" AS "waitId", wait."stepId", wait."targetTaskIds", wait."idempotencyKey", wait."mode", wait."status", wait."deadlineAt", wait."matchedTaskIds", wait."result" AS "waitResult", step."attempt", step."ordinal", next."id" AS "continuationStepId", next."ordinal" AS "continuationOrdinal", call."content" AS "callContent", call."status" AS "callStatus", result."id" AS "sourceItemId", result."content" AS "resultContent", result."status" AS "resultStatus"
    FROM "agent_wait_conditions" AS wait
    JOIN latest_wait ON latest_wait."id" = wait."id"
    JOIN "agent_steps" AS step ON step."id" = wait."stepId" AND step."sessionId" = wait."sessionId" AND step."turnId" = wait."turnId" AND step."taskId" = wait."parentTaskId"
    JOIN "agent_steps" AS next ON next."sessionId" = step."sessionId" AND next."turnId" = step."turnId"
      AND next."taskId" = step."taskId" AND next."attempt" = step."attempt"
      AND next."ordinal" = (SELECT MIN(later."ordinal") FROM "agent_steps" AS later WHERE later."sessionId" = step."sessionId"
        AND later."turnId" = step."turnId" AND later."taskId" = step."taskId" AND later."attempt" = step."attempt"
        AND later."ordinal" > step."ordinal")
    JOIN "sub_agent_tasks" AS task ON task."id" = wait."parentTaskId" AND task."sessionId" = wait."sessionId" AND task."turnId" = wait."turnId"
    JOIN "agent_sessions" AS session ON session."id" = task."sessionId" AND session."userId" = wait."userId"
    JOIN "agent_turns" AS turn ON turn."id" = task."turnId" AND turn."sessionId" = task."sessionId" AND turn."userId" = session."userId"
    JOIN "sub_agent_tasks" AS root ON root."id" = task."rootTaskId" AND root."sessionId" = task."sessionId" AND root."turnId" = task."turnId"
    JOIN "agent_items" AS call ON call."sessionId" = step."sessionId" AND call."turnId" = step."turnId" AND call."taskId" = step."taskId" AND call."stepId" = step."id" AND call."type" = 'tool_call' AND call."content"->>'toolName' = 'wait_subagents'
    LEFT JOIN "agent_items" AS result ON result."sessionId" = call."sessionId" AND result."turnId" = call."turnId" AND result."taskId" = call."taskId" AND result."stepId" = call."stepId" AND result."type" = 'tool_result' AND result."content"->>'toolCallId' = call."content"->>'toolCallId'
    WHERE wait."userId" = $1 AND wait."sessionId" = $2 AND wait."turnId" = $3 AND wait."parentTaskId" = $4
      AND task."rootTaskId" = $5 AND step."attempt" <= $6 AND step."status" IN ('waiting_for_tool', 'completed')
      AND wait."status" IN ('ready', 'timed_out') AND wait."suspendedAt" IS NOT NULL AND wait."consumedAt" IS NOT NULL
      AND call."type" = 'tool_call' AND call."content"->>'toolName' = 'wait_subagents'
      ${exactWaitId}
    ORDER BY step."attempt" DESC, step."ordinal" DESC, wait."createdAt" DESC, wait."id" DESC LIMIT 2 FOR SHARE OF wait, step, next, call`, values)).rows
  if (rows.length === 0) return undefined
  if (rows.length !== 1) throw new Error("child_resume_wait_tool_call_conflict")
  const row = rows[0]
  if (!["started", "streaming", "completed"].includes(String(row.callStatus))
    || row.sourceItemId !== null && row.sourceItemId !== undefined && (row.callStatus !== "completed" || row.resultStatus !== "completed")) throw new Error("child_resume_wait_tool_call_conflict")
  const ids = strictIds(row.targetTaskIds)
  if (!ids || ids.includes(lease.id)) throw new Error("child_resume_wait_lineage")
  const targets = (await client.query<Row>(`SELECT task."id", task."parentTaskId", task."rootTaskId", task."sessionId", task."turnId", session."userId"
    FROM "sub_agent_tasks" AS task JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
    WHERE task."id" = ANY($1::text[]) AND task."sessionId" = $2 AND task."turnId" = $3 AND task."rootTaskId" = $4
      AND task."parentTaskId" = $5 AND session."userId" = $6 AND session."status" NOT IN ('aborted', 'archived')`,
  [ids, lease.sessionId, lease.turnId, lease.rootTaskId, lease.id, lease.userId])).rows
  const targetRows = strictIds(targets.map(target => target.id))
  if (!targetRows || targets.length !== ids.length || !sameIds(targetRows, ids) || targets.some(target => target.parentTaskId !== lease.id
    || target.rootTaskId !== lease.rootTaskId || target.sessionId !== lease.sessionId || target.turnId !== lease.turnId || target.userId !== lease.userId)) throw new Error("child_resume_wait_lineage")
  const waitRow: Row = { id: row.waitId, userId: lease.userId, sessionId: lease.sessionId, turnId: lease.turnId,
    parentTaskId: lease.id, stepId: row.stepId, idempotencyKey: row.idempotencyKey, targetTaskIds: row.targetTaskIds,
    mode: row.mode, status: row.status, deadlineAt: row.deadlineAt, matchedTaskIds: row.matchedTaskIds, result: row.waitResult }
  const matched = strictIds(row.matchedTaskIds, 0)
  if (!matched || matched.some(id => !ids.includes(id)) || !validStoredOutcome(row, ids, matched)) throw new Error("child_resume_invalid_wait_result")
  const call = waitObject(row.callContent), input = waitObject(call.input), request = waitObject(waitObject(row.waitResult).request)
  const inputIds = strictIds(input.taskIds), requestIds = strictIds(request.targetTaskIds)
  const toolCallId = typeof call.toolCallId === "string" ? call.toolCallId : ""
  if (!toolCallId || call.toolName !== "wait_subagents" || !exactKeys(input, ["idempotencyKey", "taskIds", "mode", "timeoutMs"])
    || !exactKeys(request, ["targetTaskIds", "mode", "timeoutMs"])
    || typeof input.idempotencyKey !== "string" || !input.idempotencyKey.trim() || input.idempotencyKey !== input.idempotencyKey.trim()
    || input.idempotencyKey.length > 256 || input.idempotencyKey !== row.idempotencyKey
    || !(row.mode === "any" || row.mode === "all") || input.mode !== row.mode || request.mode !== row.mode
    || !Number.isSafeInteger(input.timeoutMs) || Number(input.timeoutMs) < 1 || Number(input.timeoutMs) > 30_000
    || !Number.isSafeInteger(request.timeoutMs) || input.timeoutMs !== request.timeoutMs || !inputIds || !requestIds
    || !sameIds(requestIds, ids) || !sameIds(inputIds, ids)) throw new Error("child_resume_wait_tool_call_conflict")
  const stepId = typeof row.stepId === "string" ? row.stepId : ""
  const sourceItemId = typeof row.sourceItemId === "string" ? row.sourceItemId : `recovered-wait-result:${String(row.waitId)}`
  const attempt = Number(row.attempt), ordinal = Number(row.ordinal), continuationStepId = typeof row.continuationStepId === "string" ? row.continuationStepId : ""
  const continuationOrdinal = Number(row.continuationOrdinal)
  if (!stepId.trim() || !sourceItemId.trim() || !Number.isSafeInteger(attempt) || attempt < 1 || attempt > lease.attemptCount
    || !Number.isSafeInteger(ordinal) || ordinal < 0 || !continuationStepId.trim() || !Number.isSafeInteger(continuationOrdinal) || continuationOrdinal <= ordinal) throw new Error("child_resume_wait_lineage")
  const output = waitResult(waitRow), outputIds = strictIds(output.taskIds)
  if (output.waitId !== row.waitId || !["ready", "timed_out"].includes(output.status) || !outputIds || !sameIds(outputIds, ids)
    || !markCanonicalSubagentWaitTargetIds({ targetTaskIds: outputIds }, output, outputIds) || !markInputIds(input, ids)) throw new Error("child_resume_invalid_wait_result")
  const recoveredMarker = Object.hasOwn(waitObject(row.waitResult), "sourceLifecycleRecovery")
  if (row.sourceItemId !== null && row.sourceItemId !== undefined && !recoveredMarker && !validReceipt(row, ids, toolCallId)) {
    throw new Error("child_resume_wait_tool_call_conflict")
  }
  let lifecycle: Awaited<ReturnType<typeof inspectChildWaitSourceLifecycle>>
  try { lifecycle = await inspectChildWaitSourceLifecycle(client, lease, waitRow, stepId, output) }
  catch (error) { if (error instanceof DurableSubagentWaitError) throw new Error("child_resume_wait_tool_call_conflict"); throw error }
  if ((lifecycle.state !== "waiting" && lifecycle.state !== "recovered") || lifecycle.toolCallId !== toolCallId
    || lifecycle.resultItemId !== row.sourceItemId) throw new Error("child_resume_wait_tool_call_conflict")
  return { waitId: String(row.waitId), stepId, attempt, ordinal, toolCallId, sourceItemId,
    input: safeSubagentWaitJson(input, 8_192), output, continuationStepId, continuationOrdinal }
}
