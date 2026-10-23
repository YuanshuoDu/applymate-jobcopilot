import { isSubagentDispatchAdmitted } from "./subagent-pause-dispatch.js"
import { subagentDispatchJobId } from "../runtime/subagents/dispatch-identity.js"
import { parseSubagentJobPayload, type PgSubagentPool, type SubagentJobPayload } from "../runtime/subagents/types.js"
import { CHILD_WAIT_RESUMABLE_SQL } from "./subagent-dispatch-eligibility.js"

export const PUBLISHED_SUBAGENT_RECOVERY_LIMIT = 50
export const PUBLISHED_SUBAGENT_RECOVERY_AGE_MS = 30_000
const DISPATCH_TOPIC = "agent.subagent.dispatch"
const POSTGRES_INT_MAX = 2_147_483_647
const TERMINAL = ["completed", "failed", "interrupted", "cancelled", "closed"]

type DispatchSnapshot = {
  dispatchId: string
  sessionId: string
  taskId: string
  turnId: string
  rootTaskId: string
  userId: string
  payload: SubagentJobPayload
  attemptCount: number
  taskAttemptCount: number
  publishedAtText: string
  childWaitResumable: boolean
}

type SnapshotRow = Record<string, unknown>

function text(value: unknown): value is string { return typeof value === "string" && value.length > 0 }
function integer(value: unknown): number | null {
  const number = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN
  return Number.isSafeInteger(number) ? number : null
}
function dateMillis(value: unknown): number | null {
  const parsed = value instanceof Date ? value.getTime() : typeof value === "string" ? Date.parse(value) : NaN
  return Number.isFinite(parsed) ? parsed : null
}
function parseSnapshot(row: SnapshotRow, now: number): DispatchSnapshot | null {
  const payload = parseSubagentJobPayload(row.payload)
  const count = integer(row.attemptCount), publishedAt = dateMillis(row.publishedAt)
  const taskAttemptCount = integer(row.taskAttemptCount)
  const firstDispatch = integer(row.taskAttemptCount) === 0 && row.taskStartedAt == null
  const childWaitResumable = row.childWaitResumable === true
  if (!payload || !text(row.dispatchId) || !text(row.sessionId) || !text(row.taskId) || !text(row.turnId)
    || !text(row.rootTaskId) || !text(row.userId) || !text(row.publishedAtText)
    || row.topic !== DISPATCH_TOPIC || row.aggregateId !== row.sessionId
    || row.idempotencyKey !== `subagent-dispatch:${row.taskId}`
    || payload.taskId !== row.taskId || payload.sessionId !== row.sessionId || payload.rootTaskId !== row.rootTaskId
    || row.turnRootTaskId !== row.rootTaskId
    || row.sessionStatus !== "running" || !text(row.turnStatus) || TERMINAL.includes(row.turnStatus)
    || !text(row.rootStatus) || TERMINAL.includes(row.rootStatus) || row.rootInterruptRequestedAt != null
    || row.taskStatus !== "queued" || taskAttemptCount === null || (!firstDispatch && !childWaitResumable)
    || row.taskLeaseOwner != null || row.taskLeaseExpiresAt != null || row.taskInterruptRequestedAt != null
    || (row.taskNextAttemptAt != null && (dateMillis(row.taskNextAttemptAt) ?? Infinity) > now)
    || integer(row.taskMaxAttempts) === null || Number(row.taskMaxAttempts) < 1
    || count === null || count < 1 || count >= POSTGRES_INT_MAX || publishedAt === null
    || dateMillis(row.publishedAtText) !== publishedAt
    || publishedAt > now - PUBLISHED_SUBAGENT_RECOVERY_AGE_MS) return null
  try { subagentDispatchJobId(payload.taskId, count - 1); subagentDispatchJobId(payload.taskId, count) } catch { return null }
  return { dispatchId: row.dispatchId, sessionId: row.sessionId, taskId: row.taskId, turnId: row.turnId,
    rootTaskId: row.rootTaskId, userId: row.userId, payload, attemptCount: count, taskAttemptCount,
    publishedAtText: row.publishedAtText, childWaitResumable }
}

async function snapshot(pool: PgSubagentPool, limit: number): Promise<DispatchSnapshot[]> {
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    const result = await client.query<SnapshotRow>(`SELECT dispatch."id" AS "dispatchId", dispatch."topic", dispatch."aggregateId",
        dispatch."idempotencyKey", dispatch."payload", dispatch."attemptCount", dispatch."publishedAt",
        dispatch."publishedAt"::text AS "publishedAtText", task."id" AS "taskId", task."sessionId", task."turnId",
        task."rootTaskId", task."status" AS "taskStatus", task."attemptCount" AS "taskAttemptCount",
        task."maxAttempts" AS "taskMaxAttempts", task."startedAt" AS "taskStartedAt", task."leaseOwner" AS "taskLeaseOwner",
        task."leaseExpiresAt" AS "taskLeaseExpiresAt", task."interruptRequestedAt" AS "taskInterruptRequestedAt",
        task."nextAttemptAt" AS "taskNextAttemptAt", ${CHILD_WAIT_RESUMABLE_SQL} AS "childWaitResumable",
        session."userId", session."status" AS "sessionStatus",
        turn."status" AS "turnStatus", turn."rootTaskId" AS "turnRootTaskId",
        root."status" AS "rootStatus", root."interruptRequestedAt" AS "rootInterruptRequestedAt"
      FROM "agent_outbox" AS dispatch
      JOIN "agent_sessions" AS session ON session."id" = dispatch."aggregateId" AND session."status" = 'running'
      JOIN "sub_agent_tasks" AS task ON task."sessionId" = session."id"
        AND dispatch."idempotencyKey" = 'subagent-dispatch:' || task."id"
      JOIN "sub_agent_tasks" AS root ON root."id" = task."rootTaskId" AND root."sessionId" = task."sessionId"
        AND root."turnId" = task."turnId"
      JOIN "agent_turns" AS turn ON turn."id" = task."turnId" AND turn."sessionId" = task."sessionId"
        AND turn."userId" = session."userId" AND turn."rootTaskId" = task."rootTaskId"
      WHERE dispatch."topic" = $1 AND dispatch."publishedAt" <= CURRENT_TIMESTAMP - INTERVAL '30 seconds'
        AND dispatch."attemptCount" BETWEEN 1 AND $2
        AND task."status" = 'queued'
        AND ((task."attemptCount" = 0 AND task."startedAt" IS NULL) OR ${CHILD_WAIT_RESUMABLE_SQL})
        AND task."leaseOwner" IS NULL AND task."leaseExpiresAt" IS NULL AND task."interruptRequestedAt" IS NULL
        AND task."maxAttempts" > 0 AND (task."nextAttemptAt" IS NULL OR task."nextAttemptAt" <= CURRENT_TIMESTAMP)
        AND root."interruptRequestedAt" IS NULL AND root."status" <> ALL($3::text[])
        AND turn."status" <> ALL($3::text[])
        AND NOT EXISTS (SELECT 1 FROM "agent_events" AS pause_request
          WHERE pause_request."sessionId" = session."id" AND pause_request."turnId" = turn."id"
            AND pause_request."type" = 'session.pause_requested'
            AND NOT EXISTS (SELECT 1 FROM "agent_events" AS resumed
              WHERE resumed."sessionId" = pause_request."sessionId" AND resumed."turnId" = pause_request."turnId"
                AND resumed."type" = 'session.resume_requested' AND resumed."sequence" > pause_request."sequence"))
      ORDER BY dispatch."publishedAt" ASC, dispatch."id" ASC LIMIT $4`,
    [DISPATCH_TOPIC, POSTGRES_INT_MAX - 1, TERMINAL, limit])
    await client.query("COMMIT")
    const now = Date.now(), seen = new Set<string>(), rows: DispatchSnapshot[] = []
    for (const row of result.rows.slice(0, limit)) {
      const candidate = parseSnapshot(row, now)
      if (candidate && !seen.has(candidate.dispatchId)) { seen.add(candidate.dispatchId); rows.push(candidate) }
    }
    return rows
  } catch (error: unknown) {
    await client.query("ROLLBACK").catch(() => undefined)
    throw error
  } finally { client.release() }
}

function samePayload(value: unknown, expected: SubagentJobPayload): boolean {
  const payload = parseSubagentJobPayload(value)
  return Boolean(payload && payload.taskId === expected.taskId && payload.sessionId === expected.sessionId
    && payload.rootTaskId === expected.rootTaskId && payload.ownerId === expected.ownerId)
}

async function retainedJobIsTerminal(value: unknown, expectedId: string, expectedPayload: SubagentJobPayload): Promise<boolean> {
  if (!value || typeof value !== "object") return false
  const job = value as { id?: unknown; data?: unknown; getState?: unknown }
  if (job.id !== expectedId || !samePayload(job.data, expectedPayload) || typeof job.getState !== "function") return false
  try {
    const state: unknown = await Reflect.apply(job.getState, value, [])
    return state === "completed" || state === "failed"
  } catch { return false }
}

async function clearStillMissing(pool: PgSubagentPool, candidate: DispatchSnapshot): Promise<boolean> {
  const client = await pool.connect()
  let transactionOpen = false
  try {
    await client.query("BEGIN")
    transactionOpen = true
    const session = await client.query<{ id: string; userId: string; status: string }>(`SELECT session."id", session."userId", session."status"
      FROM "agent_sessions" AS session WHERE session."id" = $1 FOR UPDATE`, [candidate.sessionId])
    const currentSession = session.rows[0]
    if (!currentSession || currentSession.userId !== candidate.userId || currentSession.status !== "running") return false
    await client.query("SELECT set_config('app.user_id', $1, true)", [candidate.userId])
    const turn = await client.query<{ id: string; status: string; rootTaskId: string }>(`SELECT turn."id", turn."status", turn."rootTaskId"
      FROM "agent_turns" AS turn WHERE turn."id" = $1 AND turn."sessionId" = $2 AND turn."userId" = $3
        AND turn."status" <> ALL($4::text[]) AND turn."rootTaskId" = $5 FOR UPDATE`,
    [candidate.turnId, candidate.sessionId, candidate.userId, TERMINAL, candidate.rootTaskId])
    if (!turn.rows[0] || turn.rows[0].rootTaskId !== candidate.rootTaskId
      || !text(turn.rows[0].status) || TERMINAL.includes(turn.rows[0].status)
      || !await isSubagentDispatchAdmitted(client, { sessionId: candidate.sessionId, userId: candidate.userId, turnId: candidate.turnId })) return false
    const root = await client.query<{ id: string; status: string; interruptRequestedAt: Date | null }>(`SELECT root."id", root."status", root."interruptRequestedAt"
      FROM "sub_agent_tasks" AS root WHERE root."id" = $1 AND root."sessionId" = $2 AND root."turnId" = $3 FOR UPDATE`,
    [candidate.rootTaskId, candidate.sessionId, candidate.turnId])
    if (!root.rows[0] || !text(root.rows[0].status) || root.rows[0].interruptRequestedAt != null || TERMINAL.includes(root.rows[0].status)) return false
    const task = await client.query<SnapshotRow>(`SELECT task."id", task."sessionId", task."turnId", task."rootTaskId", task."status",
        task."attemptCount", task."maxAttempts", task."startedAt", task."leaseOwner", task."leaseExpiresAt",
        task."interruptRequestedAt", task."nextAttemptAt", ${CHILD_WAIT_RESUMABLE_SQL} AS "childWaitResumable"
      FROM "sub_agent_tasks" AS task WHERE task."id" = $1 AND task."sessionId" = $2 AND task."turnId" = $3
        AND task."rootTaskId" = $4 FOR UPDATE`, [candidate.taskId, candidate.sessionId, candidate.turnId, candidate.rootTaskId])
    const currentTask = task.rows[0]
    const firstDispatch = integer(currentTask?.attemptCount) === 0 && currentTask?.startedAt == null
    const childWaitResumable = currentTask?.childWaitResumable === true
    if (!currentTask || currentTask.status !== "queued" || integer(currentTask.attemptCount) !== candidate.taskAttemptCount
      || (!firstDispatch && !childWaitResumable)
      || integer(currentTask.maxAttempts) === null || Number(currentTask.maxAttempts) < 1
      || currentTask.leaseOwner != null || currentTask.leaseExpiresAt != null || currentTask.interruptRequestedAt != null
      || (currentTask.nextAttemptAt != null && (dateMillis(currentTask.nextAttemptAt) ?? Infinity) > Date.now())) return false
    const dispatch = await client.query<SnapshotRow>(`SELECT dispatch."id", dispatch."topic", dispatch."aggregateId", dispatch."idempotencyKey",
        dispatch."payload", dispatch."attemptCount", dispatch."publishedAt"::text AS "publishedAtText"
      FROM "agent_outbox" AS dispatch WHERE dispatch."id" = $1 AND dispatch."aggregateId" = $2
        AND dispatch."topic" = $3 AND dispatch."idempotencyKey" = $4 FOR UPDATE`,
    [candidate.dispatchId, candidate.sessionId, DISPATCH_TOPIC, `subagent-dispatch:${candidate.taskId}`])
    const current = dispatch.rows[0], count = integer(current?.attemptCount)
    if (!current || current.topic !== DISPATCH_TOPIC || current.aggregateId !== candidate.sessionId
      || current.idempotencyKey !== `subagent-dispatch:${candidate.taskId}` || !samePayload(current.payload, candidate.payload)
      || count !== candidate.attemptCount || current.publishedAtText !== candidate.publishedAtText
      || count === null || count < 1 || count >= POSTGRES_INT_MAX) return false
    const updated = await client.query(`UPDATE "agent_outbox" AS dispatch SET "publishedAt" = NULL
      WHERE dispatch."id" = $1 AND dispatch."topic" = $2 AND dispatch."aggregateId" = $3
        AND dispatch."idempotencyKey" = $4 AND dispatch."attemptCount" = $5
        AND dispatch."publishedAt" = $6::timestamptz AND dispatch."payload" = $7::jsonb
        AND dispatch."publishedAt" <= CURRENT_TIMESTAMP - INTERVAL '30 seconds'`,
    [candidate.dispatchId, DISPATCH_TOPIC, candidate.sessionId, `subagent-dispatch:${candidate.taskId}`,
      candidate.attemptCount, candidate.publishedAtText, JSON.stringify(candidate.payload)])
    await client.query("COMMIT")
    transactionOpen = false
    return updated.rowCount === 1
  } finally {
    if (transactionOpen) await client.query("ROLLBACK").catch(() => undefined)
    client.release()
  }
}

/** Clears only a stale publication whose canonical Bull job is definitively absent. */
export async function recoverMissingPublishedSubagentDispatches(
  pool: PgSubagentPool,
  queue: { getJob?: (jobId: string) => Promise<unknown> },
  limit = PUBLISHED_SUBAGENT_RECOVERY_LIMIT,
): Promise<number> {
  if (!Number.isInteger(limit) || limit < 1) return 0
  const boundedLimit = Math.min(limit, PUBLISHED_SUBAGENT_RECOVERY_LIMIT)
  if (typeof queue?.getJob !== "function") return 0
  const candidates = await snapshot(pool, boundedLimit)
  let recovered = 0
  for (const candidate of candidates) {
    const jobId = subagentDispatchJobId(candidate.taskId, candidate.attemptCount - 1)
    let existing: unknown
    try { existing = await queue.getJob(jobId) }
    catch { continue }
    if (existing !== null && existing !== undefined && !await retainedJobIsTerminal(existing, jobId, candidate.payload)) continue
    if (await clearStillMissing(pool, candidate)) recovered += 1
  }
  return recovered
}
