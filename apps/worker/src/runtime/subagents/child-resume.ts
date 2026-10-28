import type pg from "pg"
import type { ContextSeedBlock } from "../context/step-context-builder.js"
import type { TurnResumeState } from "../turns/turn-engine-types.js"
import type { SubagentLease } from "./types.js"
import { buildChildResumeObservations, countChildResumeToolCalls, integer, mergeDurableWaitObservation, type DurableWaitResume } from "./child-resume-observations.js"
import { loadChildConsumedWaitResume } from "./child-resume-consumed-wait.js"
export { loadChildConsumedWaitResume } from "./child-resume-consumed-wait.js"
type QueryClient = Pick<pg.PoolClient, "query" | "release">
type ResumePool = Pick<pg.Pool, "connect">
type Row = Record<string, unknown>
export type ChildAttemptResume = {
  readonly resume: TurnResumeState
  readonly observations: readonly ContextSeedBlock[]
  readonly durableWait?: DurableWaitResume
}
export type ChildResumeLoader = (lease: SubagentLease) => Promise<ChildAttemptResume | undefined>
export type ChildSameAttemptResume = ChildAttemptResume & { readonly previousFinalText: string; readonly leaseExpiresAt: Date }
export type ChildSameAttemptResumeLoader = (lease: SubagentLease) => Promise<ChildSameAttemptResume | null>

const TERMINAL_TURN_STATUSES = "('completed', 'failed', 'interrupted', 'cancelled')"
const TERMINAL_ROOT_STATUSES = "('completed', 'failed', 'interrupted', 'cancelled', 'closed')"
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
  const restoredObservations = buildChildResumeObservations(itemRows, lease)
  toolCallCount = countChildResumeToolCalls(itemRows, lease)
  return { resume: { nextOrdinal, stepCount: stepRows.length, toolCallCount, inputThroughSequence, consumedInputIds,
    usage: { inputTokens, outputTokens, estimatedCostUsd } }, observations: restoredObservations }
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
    const current = await client.query<Row>(currentTaskSql(), [lease.id, lease.sessionId, lease.turnId, lease.rootTaskId, lease.userId, lease.ownerId, lease.attemptCount])
    if (!current.rows[0]) throw new Error("child_resume_owner_mismatch")
    assertTask(current.rows[0], lease, now)
    if (durableWait && durableWait.attempt !== lease.attemptCount) throw new Error("child_resume_wait_step_lineage")
    const waitResume = durableWait ?? await loadChildConsumedWaitResume(client, lease)
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
