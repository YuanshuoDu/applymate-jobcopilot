import type pg from "pg"
import type { ContextSeedBlock } from "../context/step-context-builder.js"
import type { TurnResumeState } from "../turns/turn-engine-types.js"
import type { SubagentLease } from "./types.js"
import { buildChildResumeObservations, countChildResumeToolCalls, mergeDurableWaitObservation, type DurableWaitResume } from "./child-resume-observations.js"
import { object as waitObject, parseIds, safeSubagentWaitJson, waitResult } from "./durable-subagent-wait-store.js"
type QueryClient = Pick<pg.PoolClient, "query" | "release">
type ResumePool = Pick<pg.Pool, "connect">
type Row = Record<string, unknown>
export type ChildAttemptResume = {
  readonly resume: TurnResumeState
  readonly observations: readonly ContextSeedBlock[]
  readonly durableWait?: DurableWaitResume
}
export type ChildResumeLoader = (lease: SubagentLease) => Promise<ChildAttemptResume | undefined>

const TERMINAL_TURN_STATUSES = "('completed', 'failed', 'interrupted', 'cancelled')"
const TERMINAL_ROOT_STATUSES = "('completed', 'failed', 'interrupted', 'cancelled', 'closed')"
const MAX_PRIOR_STEPS = 256; const MAX_PRIOR_ITEMS = 1024
function text(row: Row, key: string): string {
  const value = row[key]
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`child_resume_invalid_${key}`)
  return value
}
function integer(row: Row, key: string, minimum = 0): number {
  const value = typeof row[key] === "number" ? row[key] : Number(row[key])
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`child_resume_invalid_${key}`)
  return value
}

function amount(row: Row, key: string): number {
  const value = typeof row[key] === "number" ? row[key] : Number(row[key])
  if (!Number.isFinite(value) || value < 0) throw new Error(`child_resume_invalid_${key}`)
  return value
}

function sequence(row: Row, key: string): bigint {
  try {
    const value = BigInt(row[key] as string | number | bigint)
    if (value < 0n) throw new Error()
    return value
  } catch { throw new Error(`child_resume_invalid_${key}`) }
}

function ids(row: Row): readonly string[] {
  if (!Array.isArray(row.consumedInputIds)) throw new Error("child_resume_invalid_consumedInputIds")
  return row.consumedInputIds.map(value => {
    if (typeof value !== "string" || value.trim().length === 0) throw new Error("child_resume_invalid_consumedInputIds")
    return value
  })
}

function currentTaskSql(): string {
  return `SELECT task."id", task."sessionId", task."turnId", task."rootTaskId", task."status", task."leaseOwner", task."attemptCount", task."leaseExpiresAt", task."interruptRequestedAt", session."userId" AS "userId", turn."status" AS "turnStatus", root."status" AS "rootStatus"
    FROM "sub_agent_tasks" AS task JOIN "agent_sessions" AS session ON session."id" = task."sessionId" JOIN "agent_turns" AS turn ON turn."id" = task."turnId" AND turn."sessionId" = task."sessionId" JOIN "sub_agent_tasks" AS root ON root."id" = task."rootTaskId" AND root."sessionId" = task."sessionId" AND root."turnId" = task."turnId"
    WHERE task."id" = $1 AND task."sessionId" = $2 AND task."turnId" = $3 AND task."rootTaskId" = $4 AND session."userId" = $5 AND task."status" = 'running' AND task."leaseOwner" = $6 AND task."attemptCount" = $7 AND task."leaseExpiresAt" > CURRENT_TIMESTAMP AND task."interruptRequestedAt" IS NULL AND session."status" NOT IN ('aborted', 'archived') AND turn."status" NOT IN ${TERMINAL_TURN_STATUSES} AND root."status" NOT IN ${TERMINAL_ROOT_STATUSES} FOR SHARE`
}
function stepsSql(): string {
  return `SELECT step."id", step."sessionId", step."turnId", step."taskId", step."ordinal", step."attempt", step."status", step."inputThroughSequence", step."consumedInputIds", step."inputTokens", step."outputTokens", step."estimatedCostUsd", task."rootTaskId" AS "rootTaskId"
    FROM "agent_steps" AS step JOIN "sub_agent_tasks" AS task ON task."id" = step."taskId" AND task."sessionId" = step."sessionId" AND task."turnId" = step."turnId" JOIN "agent_sessions" AS session ON session."id" = step."sessionId" JOIN "agent_turns" AS turn ON turn."id" = step."turnId" AND turn."sessionId" = step."sessionId" JOIN "sub_agent_tasks" AS root ON root."id" = task."rootTaskId" AND root."sessionId" = task."sessionId" AND root."turnId" = task."turnId"
    WHERE step."taskId" = $1 AND step."sessionId" = $2 AND step."turnId" = $3 AND session."userId" = $4 AND task."rootTaskId" = $5 AND step."attempt" >= 1 AND step."attempt" < $6 ORDER BY step."attempt" ASC, step."ordinal" ASC, step."id" ASC LIMIT ${MAX_PRIOR_STEPS + 1}`
}

function waitResumeStepsSql(): string {
  return `SELECT step."id", step."sessionId", step."turnId", step."taskId", step."ordinal", step."attempt", step."status", step."inputThroughSequence", step."consumedInputIds", step."inputTokens", step."outputTokens", step."estimatedCostUsd", task."rootTaskId" AS "rootTaskId"
    FROM "agent_steps" AS step JOIN "sub_agent_tasks" AS task ON task."id" = step."taskId" AND task."sessionId" = step."sessionId" AND task."turnId" = step."turnId" JOIN "agent_sessions" AS session ON session."id" = step."sessionId" JOIN "agent_turns" AS turn ON turn."id" = step."turnId" AND turn."sessionId" = step."sessionId" JOIN "sub_agent_tasks" AS root ON root."id" = task."rootTaskId" AND root."sessionId" = task."sessionId" AND root."turnId" = task."turnId"
    WHERE step."taskId" = $1 AND step."sessionId" = $2 AND step."turnId" = $3 AND session."userId" = $4 AND task."rootTaskId" = $5
      AND step."attempt" = $6 AND step."ordinal" <= $7 ORDER BY step."ordinal" ASC, step."id" ASC LIMIT ${MAX_PRIOR_STEPS + 1}`
}

function itemsSql(): string {
  return `SELECT item."id", item."sessionId", item."turnId", item."taskId", item."stepId", item."type", item."status", item."content", step."attempt", step."ordinal", task."rootTaskId" AS "rootTaskId"
    FROM "agent_items" AS item JOIN "agent_steps" AS step ON step."id" = item."stepId" AND step."sessionId" = item."sessionId" AND step."turnId" = item."turnId" AND step."taskId" = item."taskId" JOIN "sub_agent_tasks" AS task ON task."id" = item."taskId" AND task."sessionId" = item."sessionId" AND task."turnId" = item."turnId" JOIN "agent_sessions" AS session ON session."id" = item."sessionId" JOIN "agent_turns" AS turn ON turn."id" = item."turnId" AND turn."sessionId" = item."sessionId"
    WHERE item."taskId" = $1 AND item."sessionId" = $2 AND item."turnId" = $3 AND session."userId" = $4 AND task."rootTaskId" = $5 AND step."attempt" >= 1 AND step."attempt" < $6 ORDER BY step."attempt" ASC, step."ordinal" ASC, item."createdAt" ASC, item."id" ASC LIMIT ${MAX_PRIOR_ITEMS + 1}`
}

function waitResumeItemsSql(): string {
  return `SELECT item."id", item."sessionId", item."turnId", item."taskId", item."stepId", item."type", item."status", item."content", step."attempt", step."ordinal", task."rootTaskId" AS "rootTaskId"
    FROM "agent_items" AS item JOIN "agent_steps" AS step ON step."id" = item."stepId" AND step."sessionId" = item."sessionId" AND step."turnId" = item."turnId" AND step."taskId" = item."taskId" JOIN "sub_agent_tasks" AS task ON task."id" = item."taskId" AND task."sessionId" = item."sessionId" AND task."turnId" = item."turnId" JOIN "agent_sessions" AS session ON session."id" = item."sessionId" JOIN "agent_turns" AS turn ON turn."id" = item."turnId" AND turn."sessionId" = item."sessionId"
    WHERE item."taskId" = $1 AND item."sessionId" = $2 AND item."turnId" = $3 AND session."userId" = $4 AND task."rootTaskId" = $5
      AND (step."attempt" < $6 OR (step."attempt" = $6 AND step."ordinal" <= $7))
    ORDER BY step."attempt" ASC, step."ordinal" ASC, item."createdAt" ASC, item."id" ASC LIMIT ${MAX_PRIOR_ITEMS + 1}`
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return [...left].sort().join("\u0000") === [...right].sort().join("\u0000")
}
async function loadConsumedWaitResume(client: QueryClient, lease: SubagentLease): Promise<DurableWaitResume | undefined> {
  const rows = (await client.query<Row>(`WITH latest_wait AS (
    SELECT candidateWait."id" FROM "agent_wait_conditions" AS candidateWait
    JOIN "agent_steps" AS candidateStep ON candidateStep."id" = candidateWait."stepId" AND candidateStep."sessionId" = candidateWait."sessionId" AND candidateStep."turnId" = candidateWait."turnId" AND candidateStep."taskId" = candidateWait."parentTaskId"
    WHERE candidateWait."userId" = $1 AND candidateWait."sessionId" = $2 AND candidateWait."turnId" = $3 AND candidateWait."parentTaskId" = $4
      AND candidateStep."attempt" <= $6 AND candidateWait."status" IN ('ready', 'timed_out')
      AND candidateWait."suspendedAt" IS NOT NULL AND candidateWait."consumedAt" IS NOT NULL
      AND EXISTS (SELECT 1 FROM "agent_steps" AS next WHERE next."sessionId" = candidateStep."sessionId" AND next."turnId" = candidateStep."turnId"
        AND next."taskId" = candidateStep."taskId" AND next."attempt" = candidateStep."attempt" AND next."ordinal" = candidateStep."ordinal" + 1
        AND (candidateStep."attempt" < $6 OR next."ordinal" = (SELECT MAX(latest."ordinal") FROM "agent_steps" AS latest
          WHERE latest."sessionId" = candidateStep."sessionId" AND latest."turnId" = candidateStep."turnId" AND latest."taskId" = candidateStep."taskId" AND latest."attempt" = candidateStep."attempt")))
    ORDER BY candidateStep."attempt" DESC, candidateStep."ordinal" DESC, candidateWait."createdAt" DESC, candidateWait."id" DESC LIMIT 1
  )
    SELECT wait."id" AS "waitId", wait."stepId", wait."targetTaskIds", wait."idempotencyKey", wait."mode", wait."status", wait."deadlineAt", wait."matchedTaskIds", wait."result" AS "waitResult", step."attempt", step."ordinal", next."id" AS "continuationStepId", next."ordinal" AS "continuationOrdinal", (SELECT MAX(latest."ordinal") FROM "agent_steps" AS latest WHERE latest."sessionId" = step."sessionId" AND latest."turnId" = step."turnId" AND latest."taskId" = step."taskId" AND latest."attempt" = step."attempt") AS "continuationLatestOrdinal", call."content" AS "callContent", call."status" AS "callStatus", result."id" AS "sourceItemId", result."content" AS "resultContent", result."status" AS "resultStatus"
    FROM "agent_wait_conditions" AS wait
    JOIN latest_wait ON latest_wait."id" = wait."id"
    JOIN "agent_steps" AS step ON step."id" = wait."stepId" AND step."sessionId" = wait."sessionId" AND step."turnId" = wait."turnId" AND step."taskId" = wait."parentTaskId"
    JOIN "agent_steps" AS next ON next."sessionId" = step."sessionId" AND next."turnId" = step."turnId" AND next."taskId" = step."taskId" AND next."attempt" = step."attempt" AND next."ordinal" = step."ordinal" + 1
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
    ORDER BY step."attempt" DESC, step."ordinal" DESC, wait."createdAt" DESC, wait."id" DESC LIMIT 2 FOR SHARE OF wait, step, next, call`,
  [lease.userId, lease.sessionId, lease.turnId, lease.id, lease.rootTaskId, lease.attemptCount])).rows
  if (rows.length === 0) return undefined
  if (rows.length !== 1) throw new Error("child_resume_wait_tool_call_conflict")
  const row = rows[0]
  if (!["started", "streaming", "completed"].includes(String(row.callStatus))
    || row.sourceItemId !== null && row.sourceItemId !== undefined && (row.callStatus !== "completed" || row.resultStatus !== "completed")) {
    throw new Error("child_resume_wait_tool_call_conflict")
  }
  const ids = parseIds(row.targetTaskIds)
  if (ids.length < 1 || ids.length > 8 || new Set(ids).size !== ids.length || ids.includes(lease.id)) throw new Error("child_resume_wait_lineage")
  const targets = (await client.query<Row>(`SELECT task."id", task."parentTaskId", task."rootTaskId", task."sessionId", task."turnId", session."userId"
    FROM "sub_agent_tasks" AS task JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
    WHERE task."id" = ANY($1::text[]) AND task."sessionId" = $2 AND task."turnId" = $3 AND task."rootTaskId" = $4
      AND task."parentTaskId" = $5 AND session."userId" = $6 AND session."status" NOT IN ('aborted', 'archived')`,
  [ids, lease.sessionId, lease.turnId, lease.rootTaskId, lease.id, lease.userId])).rows
  if (targets.length !== ids.length || targets.some(target => !ids.includes(String(target.id)) || target.parentTaskId !== lease.id
    || target.rootTaskId !== lease.rootTaskId || target.sessionId !== lease.sessionId || target.turnId !== lease.turnId || target.userId !== lease.userId)) {
    throw new Error("child_resume_wait_lineage")
  }
  const waitRow: Row = { id: row.waitId, targetTaskIds: row.targetTaskIds, status: row.status, deadlineAt: row.deadlineAt,
    matchedTaskIds: row.matchedTaskIds, result: row.waitResult }
  const output = waitResult(waitRow)
  if (output.waitId !== row.waitId || !["ready", "timed_out"].includes(output.status) || output.tasks.length !== ids.length || !sameIds(output.taskIds, ids)) {
    throw new Error("child_resume_invalid_wait_result")
  }
  const call = waitObject(row.callContent); const input = waitObject(call.input); const request = waitObject(waitObject(row.waitResult).request)
  const toolCallId = typeof call.toolCallId === "string" ? call.toolCallId : ""
  if (!toolCallId || call.toolName !== "wait_subagents" || input.idempotencyKey !== row.idempotencyKey || input.mode !== row.mode
    || request.mode !== row.mode || Number(input.timeoutMs) !== Number(request.timeoutMs) || !sameIds(parseIds(request.targetTaskIds), ids)
    || !sameIds(parseIds(input.taskIds), ids)) throw new Error("child_resume_wait_tool_call_conflict")
  if (row.sourceItemId !== null && row.sourceItemId !== undefined) {
    const receipt = waitObject(row.resultContent); const projection = waitObject(receipt.output)
    const receiptDeadline = Date.parse(String(projection.deadlineAt)); const waitDeadline = Date.parse(String(row.deadlineAt))
    if (receipt.toolCallId !== toolCallId || receipt.errorCode !== null && receipt.errorCode !== undefined || projection.waitId !== row.waitId
      || projection.status !== "waiting" || !sameIds(parseIds(projection.taskIds), ids) || parseIds(projection.matchedTaskIds).length !== 0
      || !Number.isFinite(receiptDeadline) || receiptDeadline !== waitDeadline) throw new Error("child_resume_wait_tool_call_conflict")
  }
  const stepId = typeof row.stepId === "string" ? row.stepId : ""
  const sourceItemId = typeof row.sourceItemId === "string" ? row.sourceItemId : `recovered-wait-result:${String(row.waitId)}`
  const attempt = Number(row.attempt); const ordinal = Number(row.ordinal); const continuationStepId = typeof row.continuationStepId === "string" ? row.continuationStepId : ""
  const continuationOrdinal = Number(row.continuationOrdinal); const continuationLatestOrdinal = Number(row.continuationLatestOrdinal)
  if (!stepId.trim() || !sourceItemId.trim() || !Number.isSafeInteger(attempt) || attempt < 1 || attempt > lease.attemptCount
    || !Number.isSafeInteger(ordinal) || ordinal < 0 || !continuationStepId.trim() || continuationOrdinal !== ordinal + 1
    || attempt === lease.attemptCount && continuationLatestOrdinal !== continuationOrdinal) throw new Error("child_resume_wait_lineage")
  return { waitId: String(row.waitId), stepId, attempt, ordinal, toolCallId, sourceItemId,
    input: safeSubagentWaitJson(input, 8_192), output }
}

function assertTask(row: Row, lease: SubagentLease, now: Date): void {
  if (text(row, "id") !== lease.id || text(row, "userId") !== lease.userId || text(row, "sessionId") !== lease.sessionId
    || text(row, "turnId") !== lease.turnId || text(row, "rootTaskId") !== lease.rootTaskId || text(row, "leaseOwner") !== lease.ownerId
    || integer(row, "attemptCount", 1) !== lease.attemptCount || row.status !== "running" || row.turnStatus === undefined
    || row.rootStatus === undefined || row.interruptRequestedAt !== null
    || typeof row.turnStatus !== "string" || TERMINAL_TURN_STATUSES.includes(`'${row.turnStatus}'`)
    || typeof row.rootStatus !== "string" || TERMINAL_ROOT_STATUSES.includes(`'${row.rootStatus}'`)) throw new Error("child_resume_owner_mismatch")
  const expires = row.leaseExpiresAt instanceof Date ? row.leaseExpiresAt : new Date(String(row.leaseExpiresAt))
  if (!Number.isFinite(expires.getTime()) || expires.getTime() <= now.getTime()) throw new Error("child_resume_lease_expired")
  if (lease.interruptRequestedAt !== null || lease.leaseExpiresAt.getTime() <= now.getTime()) throw new Error("child_resume_lease_expired")
}

export async function loadChildAttemptResume(pool: ResumePool, lease: SubagentLease, now = new Date(), durableWait?: DurableWaitResume): Promise<ChildAttemptResume | undefined> {
  const client: QueryClient = await pool.connect()
  let committed = false
  try {
    await client.query("BEGIN")
    await client.query("SELECT set_config($1, $2, true)", ["app.user_id", lease.userId])
    const current = await client.query<Row>(currentTaskSql(), [lease.id, lease.sessionId, lease.turnId, lease.rootTaskId, lease.userId, lease.ownerId, lease.attemptCount])
    if (!current.rows[0]) throw new Error("child_resume_owner_mismatch")
    assertTask(current.rows[0], lease, now)
    if (durableWait && durableWait.attempt !== lease.attemptCount) throw new Error("child_resume_wait_step_lineage")
    const waitResume = durableWait ?? await loadConsumedWaitResume(client, lease)
    const currentAttemptWait = waitResume?.attempt === lease.attemptCount ? waitResume : undefined
    const prior = await client.query<Row>(stepsSql(), [lease.id, lease.sessionId, lease.turnId, lease.userId, lease.rootTaskId, lease.attemptCount])
    const sameAttempt = currentAttemptWait
      ? await client.query<Row>(waitResumeStepsSql(), [lease.id, lease.sessionId, lease.turnId, lease.userId, lease.rootTaskId, lease.attemptCount, currentAttemptWait.ordinal])
      : { rows: [] as Row[] }
    const steps = [...prior.rows, ...sameAttempt.rows]
    if (steps.length > MAX_PRIOR_STEPS) throw new Error("child_resume_step_limit")
    if (currentAttemptWait && (!currentAttemptWait.stepId.trim() || !currentAttemptWait.toolCallId.trim()
      || !Number.isSafeInteger(currentAttemptWait.ordinal) || currentAttemptWait.ordinal < 0
      || !sameAttempt.rows.some(row => String(row.id) === currentAttemptWait.stepId && Number(row.attempt) === currentAttemptWait.attempt
        && Number(row.ordinal) === currentAttemptWait.ordinal && ["waiting_for_tool", "completed"].includes(String(row.status))))) throw new Error("child_resume_wait_step_lineage")
    if (waitResume && waitResume.attempt < lease.attemptCount && !prior.rows.some(row => String(row.id) === waitResume.stepId
      && Number(row.attempt) === waitResume.attempt && Number(row.ordinal) === waitResume.ordinal)) throw new Error("child_resume_wait_step_lineage")
    if (steps.length === 0) {
      await client.query("COMMIT"); committed = true
      return undefined
    }
    let lastOrdinal = 0
    let lastAttempt = 0
    let lastStatus = ""
    let stepCount = 0
    let toolCallCount = 0
    let inputThroughSequence = 0n
    let inputTokens = 0
    let outputTokens = 0
    let estimatedCostUsd = 0
    const consumedInputIds: string[] = []
    const consumed = new Set<string>()
    for (const row of steps) {
      const ordinal = integer(row, "ordinal")
      const attempt = integer(row, "attempt", 1)
      if (text(row, "id") === "" || text(row, "sessionId") !== lease.sessionId || text(row, "turnId") !== lease.turnId || text(row, "taskId") !== lease.id
        || text(row, "rootTaskId") !== lease.rootTaskId || attempt > lease.attemptCount
        || typeof row.status !== "string" || !["queued", "streaming", "completed", "failed", "interrupted", "waiting_for_tool", "waiting_for_approval", "waiting_for_user"].includes(row.status)) throw new Error("child_resume_step_lineage")
      if (attempt > lastAttempt || attempt === lastAttempt && ordinal >= lastOrdinal) { lastAttempt = attempt; lastOrdinal = ordinal; lastStatus = row.status }
      stepCount += 1
      const cursor = sequence(row, "inputThroughSequence")
      if (cursor > inputThroughSequence) inputThroughSequence = cursor
      for (const id of ids(row)) if (!consumed.has(id)) { consumed.add(id); consumedInputIds.push(id) }
      inputTokens += integer(row, "inputTokens")
      outputTokens += integer(row, "outputTokens")
      estimatedCostUsd += amount(row, "estimatedCostUsd")
      if (!Number.isSafeInteger(inputTokens) || !Number.isSafeInteger(outputTokens) || !Number.isFinite(estimatedCostUsd)) throw new Error("child_resume_usage_overflow")
    }
    const nextOrdinal = ["completed", "waiting_for_tool", "waiting_for_approval", "waiting_for_user"].includes(lastStatus) ? lastOrdinal + 1 : lastOrdinal
    const itemResult = currentAttemptWait
      ? await client.query<Row>(waitResumeItemsSql(), [lease.id, lease.sessionId, lease.turnId, lease.userId, lease.rootTaskId, lease.attemptCount, currentAttemptWait.ordinal])
      : await client.query<Row>(itemsSql(), [lease.id, lease.sessionId, lease.turnId, lease.userId, lease.rootTaskId, lease.attemptCount])
    if (itemResult.rows.length > MAX_PRIOR_ITEMS) throw new Error("child_resume_item_limit")
    let restoredObservations = buildChildResumeObservations(itemResult.rows, lease, currentAttemptWait?.ordinal)
    if (waitResume) restoredObservations = mergeDurableWaitObservation(restoredObservations, waitResume)
    toolCallCount = countChildResumeToolCalls(itemResult.rows, lease, currentAttemptWait?.ordinal)
    await client.query("COMMIT"); committed = true
    return {
      resume: { nextOrdinal, stepCount, toolCallCount, inputThroughSequence, consumedInputIds, usage: { inputTokens, outputTokens, estimatedCostUsd } },
      observations: restoredObservations,
      ...(currentAttemptWait ? { durableWait: currentAttemptWait } : {}),
    }
  } catch (error: unknown) {
    if (!committed) await client.query("ROLLBACK").catch(() => undefined)
    throw error
  } finally { client.release() }
}
