import type pg from "pg"
import type { ContextSeedBlock } from "../context/step-context-builder.js"
import type { TurnResumeState } from "../turns/turn-engine-types.js"
import type { ChildToolReplayReceipt, ChildWaitReplayReceipt } from "../turns/turn-execution-options.js"
import type { SubagentLease } from "./types.js"
import { buildChildResumeObservations, countChildResumeToolCalls, integer, mergeDurableWaitObservation, type DurableWaitResume } from "./child-resume-observations.js"
import { loadChildConsumedWaitResume } from "./child-resume-consumed-wait.js"
import { loadChildWaitCallRecovery } from "./child-resume-wait-call-recovery.js"
import type { ChildWaitClaimRecovery, ChildWaitOrphanRecovery } from "./child-durable-wait-replay.js"
import { childWaitLogicalResumeCursor } from "./child-resume-wait-call-contract.js"
import { lockAndLoadCurrentChildResume } from "./child-resume-locks.js"
export { loadChildConsumedWaitResume } from "./child-resume-consumed-wait.js"
type QueryClient = Pick<pg.PoolClient, "query" | "release">
type ResumePool = Pick<pg.Pool, "connect">
type Row = Record<string, unknown>
export type ChildAttemptResume = {
  readonly resume: TurnResumeState
  readonly observations: readonly ContextSeedBlock[]
  readonly childToolReplayReceipts?: readonly ChildToolReplayReceipt[]
  readonly childWaitReplayReceipts?: readonly ChildWaitReplayReceipt[]
  readonly durableWait?: DurableWaitResume
  readonly childWaitClaimRecovery?: ChildWaitClaimRecovery
  readonly childWaitOrphanRecovery?: ChildWaitOrphanRecovery
  readonly childWaitOrphanCallIds?: readonly string[]
}
export type ChildResumeLoader = (lease: SubagentLease) => Promise<ChildAttemptResume | undefined>
export type ChildSameAttemptResume = ChildAttemptResume & { readonly previousFinalText: string; readonly leaseExpiresAt: Date }
export type ChildSameAttemptResumeLoader = (lease: SubagentLease) => Promise<ChildSameAttemptResume | null>

const MAX_PRIOR_STEPS = 256; const MAX_PRIOR_ITEMS = 1024
function text(row: Row, key: string): string {
  const value = row[key]
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`child_resume_invalid_${key}`)
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

function stepsSql(): string {
  return `SELECT step."id", step."sessionId", step."turnId", step."taskId", step."ordinal", step."attempt", step."status", step."inputThroughSequence", step."consumedInputIds", step."inputTokens", step."outputTokens", step."estimatedCostUsd", task."rootTaskId" AS "rootTaskId"
    FROM "agent_steps" AS step JOIN "sub_agent_tasks" AS task ON task."id" = step."taskId" AND task."sessionId" = step."sessionId" AND task."turnId" = step."turnId" JOIN "agent_sessions" AS session ON session."id" = step."sessionId" JOIN "agent_turns" AS turn ON turn."id" = step."turnId" AND turn."sessionId" = step."sessionId" JOIN "sub_agent_tasks" AS root ON root."id" = task."rootTaskId" AND root."sessionId" = task."sessionId" AND root."turnId" = task."turnId"
    WHERE step."taskId" = $1 AND step."sessionId" = $2 AND step."turnId" = $3 AND session."userId" = $4 AND task."rootTaskId" = $5 AND step."attempt" >= 1 AND step."attempt" < $6 ORDER BY step."attempt" ASC, step."ordinal" ASC, step."id" ASC LIMIT ${MAX_PRIOR_STEPS + 1}`
}

function waitResumeStepsSql(): string {
  return `SELECT step."id", step."sessionId", step."turnId", step."taskId", step."ordinal", step."attempt", step."status", step."inputThroughSequence", step."consumedInputIds", step."inputTokens", step."outputTokens", step."estimatedCostUsd", task."rootTaskId" AS "rootTaskId"
    FROM "agent_steps" AS step JOIN "sub_agent_tasks" AS task ON task."id" = step."taskId" AND task."sessionId" = step."sessionId" AND task."turnId" = step."turnId" JOIN "agent_sessions" AS session ON session."id" = step."sessionId" JOIN "agent_turns" AS turn ON turn."id" = step."turnId" AND turn."sessionId" = step."sessionId" JOIN "sub_agent_tasks" AS root ON root."id" = task."rootTaskId" AND root."sessionId" = task."sessionId" AND root."turnId" = task."turnId"
    WHERE step."taskId" = $1 AND step."sessionId" = $2 AND step."turnId" = $3 AND session."userId" = $4 AND task."rootTaskId" = $5
      AND step."attempt" = $6 ORDER BY step."ordinal" ASC, step."id" ASC LIMIT ${MAX_PRIOR_STEPS + 1}`
}

function itemsSql(): string {
  return `SELECT item."id", item."revision", item."sessionId", item."turnId", item."taskId", item."stepId", item."type", item."status", item."content", step."attempt", step."ordinal", task."rootTaskId" AS "rootTaskId"
    FROM "agent_items" AS item JOIN "agent_steps" AS step ON step."id" = item."stepId" AND step."sessionId" = item."sessionId" AND step."turnId" = item."turnId" AND step."taskId" = item."taskId" JOIN "sub_agent_tasks" AS task ON task."id" = item."taskId" AND task."sessionId" = item."sessionId" AND task."turnId" = item."turnId" JOIN "agent_sessions" AS session ON session."id" = item."sessionId" JOIN "agent_turns" AS turn ON turn."id" = item."turnId" AND turn."sessionId" = item."sessionId"
    WHERE item."taskId" = $1 AND item."sessionId" = $2 AND item."turnId" = $3 AND session."userId" = $4 AND task."rootTaskId" = $5 AND step."attempt" >= 1 AND step."attempt" < $6 ORDER BY step."attempt" ASC, step."ordinal" ASC, item."createdAt" ASC, item."id" ASC LIMIT ${MAX_PRIOR_ITEMS + 1}`
}

function waitResumeItemsSql(): string {
  return `SELECT item."id", item."revision", item."sessionId", item."turnId", item."taskId", item."stepId", item."type", item."status", item."content", step."attempt", step."ordinal", task."rootTaskId" AS "rootTaskId"
    FROM "agent_items" AS item JOIN "agent_steps" AS step ON step."id" = item."stepId" AND step."sessionId" = item."sessionId" AND step."turnId" = item."turnId" AND step."taskId" = item."taskId" JOIN "sub_agent_tasks" AS task ON task."id" = item."taskId" AND task."sessionId" = item."sessionId" AND task."turnId" = item."turnId" JOIN "agent_sessions" AS session ON session."id" = item."sessionId" JOIN "agent_turns" AS turn ON turn."id" = item."turnId" AND turn."sessionId" = item."sessionId"
    WHERE item."taskId" = $1 AND item."sessionId" = $2 AND item."turnId" = $3 AND session."userId" = $4 AND task."rootTaskId" = $5
      AND step."attempt" <= $6
    ORDER BY step."attempt" ASC, step."ordinal" ASC, item."createdAt" ASC, item."id" ASC LIMIT ${MAX_PRIOR_ITEMS + 1}`
}

function summarizePriorAttempts(stepRows: readonly Row[], itemRows: readonly Row[], lease: SubagentLease): ChildAttemptResume {
  let lastOrdinal = 0, lastAttempt = 0, lastStatus = "", toolCallCount = 0
  let inputThroughSequence = 0n, inputTokens = 0, outputTokens = 0, estimatedCostUsd = 0
  const consumedInputIds: string[] = [], consumed = new Set<string>()
  for (const row of stepRows) {
    const ordinal = integer(row, "ordinal"), attempt = integer(row, "attempt", 1)
    if (!text(row, "id") || text(row, "sessionId") !== lease.sessionId || text(row, "turnId") !== lease.turnId || text(row, "taskId") !== lease.id
      || text(row, "rootTaskId") !== lease.rootTaskId || attempt >= lease.attemptCount
      || typeof row.status !== "string" || !["queued", "streaming", "completed", "failed", "interrupted", "waiting_for_tool", "waiting_for_approval", "waiting_for_user"].includes(row.status)) throw new Error("child_resume_step_lineage")
    if (attempt > lastAttempt || attempt === lastAttempt && ordinal >= lastOrdinal) { lastAttempt = attempt; lastOrdinal = ordinal; lastStatus = row.status }
    const cursor = sequence(row, "inputThroughSequence")
    if (cursor > inputThroughSequence) inputThroughSequence = cursor
    for (const id of ids(row)) if (!consumed.has(id)) { consumed.add(id); consumedInputIds.push(id) }
    inputTokens += integer(row, "inputTokens")
    outputTokens += integer(row, "outputTokens")
    estimatedCostUsd += amount(row, "estimatedCostUsd")
    if (!Number.isSafeInteger(inputTokens) || !Number.isSafeInteger(outputTokens) || !Number.isFinite(estimatedCostUsd)) throw new Error("child_resume_usage_overflow")
  }
  const nextOrdinal = ["completed", "waiting_for_tool", "waiting_for_approval", "waiting_for_user"].includes(lastStatus) ? lastOrdinal + 1 : lastOrdinal
  const restored = buildChildResumeObservations(itemRows, lease)
  toolCallCount = countChildResumeToolCalls(itemRows, lease)
  return { resume: { nextOrdinal, stepCount: stepRows.length, toolCallCount, inputThroughSequence, consumedInputIds,
    usage: { inputTokens, outputTokens, estimatedCostUsd } }, observations: restored.observations,
    ...(restored.childToolReplayReceipts.length ? { childToolReplayReceipts: restored.childToolReplayReceipts } : {}),
    ...(restored.childWaitReplayReceipts.length ? { childWaitReplayReceipts: restored.childWaitReplayReceipts } : {}) }
}

/** Loads accounting/evidence from prior attempts on this exact task using the caller's transaction. */
export async function loadChildPriorAttemptResume(client: Pick<pg.PoolClient, "query">, lease: SubagentLease): Promise<ChildAttemptResume | undefined> {
  if (lease.attemptCount <= 1) return undefined
  const prior = await client.query<Row>(stepsSql(), [lease.id, lease.sessionId, lease.turnId, lease.userId, lease.rootTaskId, lease.attemptCount])
  if (prior.rows.length > MAX_PRIOR_STEPS) throw new Error("child_resume_step_limit")
  if (prior.rows.length === 0) return undefined
  const items = await client.query<Row>(itemsSql(), [lease.id, lease.sessionId, lease.turnId, lease.userId, lease.rootTaskId, lease.attemptCount])
  if (items.rows.length > MAX_PRIOR_ITEMS) throw new Error("child_resume_item_limit")
  return summarizePriorAttempts(prior.rows, items.rows, lease)
}

export async function loadChildAttemptResume(pool: ResumePool, lease: SubagentLease, now = new Date(), durableWait?: DurableWaitResume): Promise<ChildAttemptResume | undefined> {
  const client: QueryClient = await pool.connect()
  let committed = false
  try {
    await client.query("BEGIN")
    await client.query("SELECT set_config($1, $2, true)", ["app.user_id", lease.userId])
    await lockAndLoadCurrentChildResume(client, lease, now)
    if (durableWait && durableWait.attempt !== lease.attemptCount) throw new Error("child_resume_wait_step_lineage")
    const acknowledgedWait = durableWait ? await loadChildConsumedWaitResume(client, lease, durableWait.waitId) : undefined
    const waitResume = acknowledgedWait ?? durableWait ?? await loadChildConsumedWaitResume(client, lease)
    const currentAttemptWait = waitResume?.attempt === lease.attemptCount ? waitResume : undefined
    const prior = await client.query<Row>(stepsSql(), [lease.id, lease.sessionId, lease.turnId, lease.userId, lease.rootTaskId, lease.attemptCount])
    const sameAttempt = currentAttemptWait
      ? await client.query<Row>(waitResumeStepsSql(), [lease.id, lease.sessionId, lease.turnId, lease.userId, lease.rootTaskId, lease.attemptCount])
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
    // A resumed wait keeps its logical successor ordinal even if the persisted Turn-global continuation is later.
    let nextOrdinal = currentAttemptWait ? currentAttemptWait.ordinal + 1
      : ["completed", "waiting_for_tool", "waiting_for_approval", "waiting_for_user"].includes(lastStatus) ? lastOrdinal + 1 : lastOrdinal
    const itemResult = currentAttemptWait
      ? await client.query<Row>(waitResumeItemsSql(), [lease.id, lease.sessionId, lease.turnId, lease.userId, lease.rootTaskId, lease.attemptCount])
      : await client.query<Row>(itemsSql(), [lease.id, lease.sessionId, lease.turnId, lease.userId, lease.rootTaskId, lease.attemptCount])
    if (itemResult.rows.length > MAX_PRIOR_ITEMS) throw new Error("child_resume_item_limit")
    const currentAttemptItemOrdinal = currentAttemptWait ? Math.max(...sameAttempt.rows.map(row => integer(row, "ordinal"))) : undefined
    const restored = buildChildResumeObservations(itemResult.rows, lease, currentAttemptItemOrdinal, waitResume ? [waitResume] : [])
    let restoredObservations = restored.observations
    if (waitResume) restoredObservations = mergeDurableWaitObservation(restoredObservations, waitResume)
    const waitCallRecovery = currentAttemptWait?.continuationStepId
      ? await loadChildWaitCallRecovery(client, lease, currentAttemptWait) : undefined
    const childWaitClaimRecovery = waitCallRecovery?.claim
    const childWaitOrphanRecovery = waitCallRecovery?.orphan
    const childWaitOrphanCallIds = waitCallRecovery?.orphanCallIds ?? []
    const recoveredCall = childWaitClaimRecovery ?? childWaitOrphanRecovery
    if (currentAttemptWait) nextOrdinal = childWaitLogicalResumeCursor(sameAttempt.rows, lease, currentAttemptWait, recoveredCall?.stepOrdinal)
    if (recoveredCall?.stepStatus === "streaming") {
      inputTokens += recoveredCall.modelUsage.inputTokens; outputTokens += recoveredCall.modelUsage.outputTokens
      estimatedCostUsd += recoveredCall.modelUsage.estimatedCostUsd
      if (!Number.isSafeInteger(inputTokens) || !Number.isSafeInteger(outputTokens) || !Number.isFinite(estimatedCostUsd)) throw new Error("child_resume_usage_overflow")
    }
    const hiddenCallIds = new Set([...childWaitOrphanCallIds, ...(childWaitClaimRecovery ? [childWaitClaimRecovery.call.id] : [])])
    if (hiddenCallIds.size) restoredObservations = restoredObservations.filter(item => {
      const content = item.content && typeof item.content === "object" && !Array.isArray(item.content) ? item.content as Record<string, unknown> : {}
      return typeof content.toolCallId !== "string" || !hiddenCallIds.has(content.toolCallId)
    })
    const observationIds = new Set(restoredObservations.map(item => item.id))
    toolCallCount = countChildResumeToolCalls(itemResult.rows, lease, currentAttemptItemOrdinal)
    if (childWaitOrphanCallIds.length) {
      const orphanRows = itemResult.rows.filter(row => row.type === "tool_call" && row.content && typeof row.content === "object"
        && !Array.isArray(row.content) && childWaitOrphanCallIds.includes(String((row.content as Row).toolCallId)))
      if (orphanRows.length !== childWaitOrphanCallIds.length || new Set(childWaitOrphanCallIds).size !== childWaitOrphanCallIds.length) {
        throw new Error("child_resume_wait_tool_call_conflict")
      }
      toolCallCount -= orphanRows.filter(row => (row.content as Row).toolCallId !== childWaitOrphanRecovery?.call.id).length
    }
    await client.query("COMMIT"); committed = true
    return {
      resume: { nextOrdinal, stepCount, toolCallCount, inputThroughSequence, consumedInputIds, usage: { inputTokens, outputTokens, estimatedCostUsd } },
      observations: restoredObservations,
      ...(restored.childToolReplayReceipts.length ? { childToolReplayReceipts: restored.childToolReplayReceipts.filter(item => observationIds.has(`child-resume:${item.resultItem.id}`)) } : {}),
      ...(restored.childWaitReplayReceipts.length ? { childWaitReplayReceipts: restored.childWaitReplayReceipts.filter(item => observationIds.has(`child-resume:${item.resultItem.id}`)) } : {}),
      ...(currentAttemptWait ? { durableWait: currentAttemptWait } : {}),
      ...(childWaitClaimRecovery ? { childWaitClaimRecovery } : {}),
      ...(childWaitOrphanRecovery ? { childWaitOrphanRecovery } : {}),
      ...(childWaitOrphanCallIds.length ? { childWaitOrphanCallIds } : {}),
    }
  } catch (error: unknown) {
    if (!committed) await client.query("ROLLBACK").catch(() => undefined)
    throw error
  } finally { client.release() }
}
