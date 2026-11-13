import { createHash } from "node:crypto"
import type { Pool, PoolClient } from "pg"
import type { ApplicationSubmissionExecution } from "./application-submit-fence.js"

const CONNECT_TIMEOUT_MS = 1_000
const TRANSACTION_BUDGET_MS = 6_000
const CLIENT_QUERY_TIMEOUT_MS = 2_000
const HASH = /^[a-f0-9]{64}$/

type AttemptRow = { id: string; artifactHash: string; responseRef: string | null }
export type ApplicationSubmissionEvidenceData = Readonly<{
  schemaVersion: 1
  userId: string
  sessionId: string
  fillTurnId: string
  applicationTaskId: string
  jobId: string
  approvalId: string
  constraintHash: string
  workerTaskId: string
  executionId: string
  attemptId: string
  artifactHash: string
  workerReport: "recorded_submitted"
  localRecord: "correlated" | "unavailable"
  siteOutcome: "unverified"
}>

function validScope(scope: ApplicationSubmissionExecution): boolean {
  return [scope.sessionId, scope.fillTurnId, scope.applicationTaskId, scope.userId, scope.jobId, scope.approvalId, scope.workerTaskId, scope.executionId]
    .every(value => typeof value === "string" && value.trim().length > 0) && HASH.test(scope.constraintHash)
}

async function connectBounded(pool: Pool): Promise<PoolClient | null> {
  let acceptClient = true
  let timer: ReturnType<typeof setTimeout> | undefined
  const checkout = pool.connect().then(client => {
    if (acceptClient) return client
    try { client.release() } catch { /* A late checkout must not keep a pool slot. */ }
    return null
  })
  const timeout = new Promise<null>(resolve => {
    timer = setTimeout(() => { acceptClient = false; resolve(null) }, CONNECT_TIMEOUT_MS)
  })
  try {
    const client = await Promise.race([checkout, timeout])
    if (!client) acceptClient = false
    return client
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function queryBounded(
  client: PoolClient,
  sql: string,
  values: unknown[] | undefined,
  deadline: number,
  onTimeout: () => void,
) {
  const timeoutMs = Math.min(CLIENT_QUERY_TIMEOUT_MS, deadline - Date.now())
  if (timeoutMs <= 0) {
    onTimeout()
    throw new Error("Submission evidence transaction exceeded its bounded deadline.")
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout()
      reject(new Error("Submission evidence query exceeded its bounded deadline."))
    }, timeoutMs)
  })
  try {
    return await Promise.race([client.query(sql, values), timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function deterministicEventId(receiptId: string, attemptId: string): string {
  const key = `${receiptId.length}:${receiptId}${attemptId.length}:${attemptId}`
  return `evt_submission_evidence_${createHash("sha256").update(key).digest("hex")}`
}

const ATTEMPT_SQL = `SELECT "id", "artifactHash", "responseRef" FROM "submission_attempt"
  WHERE "receiptId" = $1 AND "userId" = $2 AND "jobId" = $3 AND "constraintHash" = $4
    AND "state" = 'submitted' AND NULLIF(BTRIM("responseRef"), '') IS NOT NULL`

const INSERT_EVIDENCE_SQL = `
WITH current_task AS (
  SELECT task."id"
  FROM "application_tasks" task
  JOIN "Job" job ON job."id" = task."jobId" AND job."userId" = task."userId"
  WHERE task."id" = $5 AND task."userId" = $2 AND task."jobId" = $6
    AND task."sessionId" = $3 AND task."fillTurnId" = $4
    AND task."fillTurnSessionId" = $3 AND task."fillTurnUserId" = $2 AND task."workerTaskId" = $9
    AND EXISTS (SELECT 1 FROM "agent_sessions" session WHERE session."id" = $3 AND session."userId" = $2)
    AND EXISTS (SELECT 1 FROM "agent_turns" turn WHERE turn."id" = $4 AND turn."sessionId" = $3 AND turn."userId" = $2)
    AND (SELECT COUNT(*) FROM "sub_agent_tasks" filler
      JOIN "agent_turns" scoped_turn ON scoped_turn."id" = filler."turnId"
        AND scoped_turn."sessionId" = filler."sessionId" AND scoped_turn."userId" = $2
      WHERE filler."sessionId" = $3 AND filler."turnId" = $4
        AND filler."role" = 'application_filler' AND filler."taskType" = 'application_fill_for_review'
        AND filler."status" = 'completed' AND filler."leaseOwner" IS NULL
        AND filler."leaseExpiresAt" IS NULL AND filler."interruptRequestedAt" IS NULL) = 1
), approval AS (
  SELECT receipt."id", receipt."resourceHash"
  FROM "agent_approvals" receipt
  WHERE receipt."id" = $7 AND receipt."userId" = $2 AND receipt."sessionId" = $3
    AND receipt."turnId" = $4 AND receipt."taskId" = $5 AND receipt."jobId" = $6
    AND receipt."type" = 'submit_application' AND receipt."toolCallId" = ('application-submit:' || $5)
    AND receipt."status" = 'consumed' AND receipt."scopeHash" = $8
    AND receipt."payload"->>'applicationTaskId' = $5 AND receipt."payload"->>'jobId' = $6
), attempt AS (
  SELECT submitted."id", submitted."artifactHash", submitted."responseRef"
  FROM "submission_attempt" submitted
  JOIN current_task task ON true
  JOIN approval ON approval."resourceHash" = submitted."artifactHash"
  WHERE submitted."id" = $11 AND submitted."receiptId" = $7
    AND submitted."userId" = $2 AND submitted."jobId" = $6 AND submitted."constraintHash" = $8
    AND submitted."artifactHash" = $12 AND submitted."state" = 'submitted'
    AND NULLIF(BTRIM(submitted."responseRef"), '') IS NOT NULL
    AND (($13 = 'correlated' AND submitted."responseRef" = 'application:' || task."id")
      OR ($13 = 'unavailable' AND submitted."responseRef" <> 'application:' || task."id'))
), queued AS (
  SELECT COUNT(*) = 1 AS unique_event,
    COUNT(*) FILTER (WHERE event."actor" = 'user'
      AND event."data"->>'applicationTaskId' = $5 AND event."data"->>'userId' = $2
      AND event."data"->>'jobId' = $6 AND event."data"->>'sessionId' = $3
      AND event."data"->>'fillTurnId' = $4 AND event."data"->>'approvalId' = $7
      AND event."data"->>'receiptId' = $7 AND event."data"->>'constraintHash' = $8
      AND event."data"->>'workerTaskId' = $9) = 1 AS exact_event
  FROM "application_task_events" event
  WHERE event."taskId" = $5 AND event."type" = 'submission_queued'
    AND (event."data"->>'workerTaskId' = $9 OR event."data"->>'receiptId' = $7)
), execution AS (
  SELECT COUNT(*) = 2 AS unique_pair,
    COUNT(*) FILTER (WHERE event."type" = 'submission_execution_started') = 1 AS one_start,
    COUNT(*) FILTER (WHERE event."type" = 'submission_execution_settled') = 1 AS one_settlement,
    COUNT(DISTINCT event."data"->>'executionId') = 1 AS one_execution,
    COUNT(*) FILTER (WHERE event."actor" = 'worker'
      AND event."data"->>'executionId' = $10 AND event."data"->>'workerTaskId' = $9
      AND event."data"->>'applicationTaskId' = $5 AND event."data"->>'userId' = $2
      AND event."data"->>'jobId' = $6 AND event."data"->>'sessionId' = $3
      AND event."data"->>'fillTurnId' = $4 AND event."data"->>'approvalId' = $7
      AND event."data"->>'constraintHash' = $8) = 2 AS exact_pair
  FROM "application_task_events" event
  WHERE event."taskId" = $5 AND event."type" IN ('submission_execution_started', 'submission_execution_settled')
    AND (event."data"->>'workerTaskId' = $9 OR event."data"->>'executionId' = $10)
)
INSERT INTO "application_task_events" ("id", "taskId", "type", "actor", "body", "data")
SELECT $1, task."id", 'submission_evidence_recorded', 'worker', 'Worker recorded a submission outcome',
  jsonb_build_object('schemaVersion', 1, 'userId', $2::text, 'sessionId', $3::text,
    'fillTurnId', $4::text, 'applicationTaskId', $5::text, 'jobId', $6::text,
    'approvalId', $7::text, 'constraintHash', $8::text, 'workerTaskId', $9::text,
    'executionId', $10::text, 'attemptId', attempt."id", 'artifactHash', attempt."artifactHash",
    'workerReport', 'recorded_submitted', 'localRecord', $13::text, 'siteOutcome', 'unverified')
FROM current_task task CROSS JOIN approval CROSS JOIN attempt CROSS JOIN queued CROSS JOIN execution
WHERE queued.unique_event AND queued.exact_event AND execution.unique_pair
  AND execution.one_start AND execution.one_settlement AND execution.one_execution AND execution.exact_pair
ON CONFLICT ("id") DO NOTHING
`

/** Append a best-effort owner-scoped record; it never drives submission or recovery. */
export async function recordApplicationSubmissionEvidence(pool: Pool, scope: ApplicationSubmissionExecution): Promise<boolean> {
  if (!validScope(scope)) return false
  const client = await connectBounded(pool)
  if (!client) return false
  const deadline = Date.now() + TRANSACTION_BUDGET_MS
  let transactionOpen = false
  let destroyClient = false
  const query = (sql: string, values?: unknown[]) =>
    queryBounded(client, sql, values, deadline, () => { destroyClient = true })
  try {
    await query("BEGIN")
    transactionOpen = true
    await query("SELECT set_config($1, $2, true)", ["app.user_id", scope.userId])
    await query("SET LOCAL statement_timeout = '1500ms'")
    await query("SET LOCAL lock_timeout = '500ms'")
    await query("SET LOCAL idle_in_transaction_session_timeout = '6000ms'")
    const result = await query(ATTEMPT_SQL, [scope.approvalId, scope.userId, scope.jobId, scope.constraintHash])
    const attempt = result.rows.length === 1 ? result.rows[0] : undefined
    if (!attempt || typeof attempt.id !== "string" || !attempt.id.trim() || !HASH.test(attempt.artifactHash)
      || typeof attempt.responseRef !== "string" || !attempt.responseRef.trim()) return false
    const localRecord = attempt.responseRef === `application:${scope.applicationTaskId}` ? "correlated" : "unavailable"
    const insert = await query(INSERT_EVIDENCE_SQL, [
      deterministicEventId(scope.approvalId, attempt.id), scope.userId, scope.sessionId, scope.fillTurnId,
      scope.applicationTaskId, scope.jobId, scope.approvalId, scope.constraintHash, scope.workerTaskId,
      scope.executionId, attempt.id, attempt.artifactHash, localRecord,
    ])
    await query("COMMIT")
    transactionOpen = false
    return insert.rowCount === 1
  } catch (error: unknown) {
    throw error
  } finally {
    if (transactionOpen && !destroyClient) {
      try { await query("ROLLBACK") } catch { destroyClient = true }
    }
    try { client.release(destroyClient) } catch { /* Evidence is advisory; cleanup cannot change submit outcome. */ }
  }
}
