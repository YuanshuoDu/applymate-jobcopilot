import { randomUUID } from "node:crypto"
import type { Pool, PoolClient } from "pg"
import type { ApplicationSubmissionStartScope } from "./application-task-state.js"
import { readStoppedSubmissionFinalizationProof } from "./application-submission-stop-state.js"
import { withExactSubmissionClientWrite } from "./submission-guard.js"

export type StoppedApplicationSubmissionFinalization =
  | "finalized"
  | "already_finalized"
  | "unavailable"
  | "superseded"

const STOPPED_ERROR_CODE = "submission_stopped_before_dispatch"
const STOPPED_ERROR = "Application submission was stopped before request dispatch."

class StopFinalizationCasFailed extends Error {}

/** Finalizes only the exact attempt whose durable Stop beat its dispatch grant. */
export async function finalizeStoppedApplicationSubmission(
  pool: Pool, scope: ApplicationSubmissionStartScope,
): Promise<StoppedApplicationSubmissionFinalization> {
  if (scope.turnId !== scope.fillTurnId) return "unavailable"
  let client: PoolClient | null = null
  let transactionOpen = false
  try {
    client = await pool.connect()
    await client.query("BEGIN")
    transactionOpen = true
    await client.query("SELECT set_config($1, $2, true)", ["app.user_id", scope.userId])
    const fenced = await withExactSubmissionClientWrite(client, scope, "finalize_stopped_submission", async () => {
      const proof = await readStoppedSubmissionFinalizationProof(pool, client!, scope)
      if (proof.kind !== "ready") return proof.kind
      if (proof.attemptState === "reserved") {
        const attempt = await client!.query(`UPDATE "submission_attempt" SET "state" = 'failed', "errorCode" = $1, "updatedAt" = CURRENT_TIMESTAMP
          WHERE "userId" = $2 AND "jobId" = $3 AND "receiptId" = $4 AND "constraintHash" = $5
            AND "artifactHash" = $6 AND "state" = 'reserved' AND "responseRef" IS NULL RETURNING "id"`,
        [STOPPED_ERROR_CODE, scope.userId, scope.jobId, scope.approvalId, scope.constraintHash, proof.artifactHash])
        if (attempt.rowCount !== 1 || attempt.rows.length !== 1) throw new StopFinalizationCasFailed()
      }
      const task = await client!.query(`UPDATE application_tasks SET status = 'failed', "checkpoint" = 'turn_stopped_before_submit',
          error = $7, "completedAt" = NOW(), "updatedAt" = NOW()
        WHERE "id" = $1 AND "userId" = $2 AND "jobId" = $3 AND "sessionId" = $4 AND "fillTurnId" = $5
          AND "fillTurnSessionId" = $4 AND "fillTurnUserId" = $2 AND "workerTaskId" = $6
          AND status = 'filling' AND "checkpoint" = 'submission_request_started' AND "completedAt" IS NULL
          AND EXISTS (SELECT 1 FROM "submission_attempt" WHERE "userId" = $2 AND "jobId" = $3 AND "receiptId" = $8
            AND "constraintHash" = $9 AND "artifactHash" = $10 AND "state" = 'failed' AND "responseRef" IS NULL)
        RETURNING "id"`,
      [scope.applicationTaskId, scope.userId, scope.jobId, scope.sessionId, scope.fillTurnId, scope.workerTaskId,
        STOPPED_ERROR, scope.approvalId, scope.constraintHash, proof.artifactHash])
      if (task.rowCount !== 1 || task.rows.length !== 1) throw new StopFinalizationCasFailed()
      const event = await client!.query(`INSERT INTO "application_task_events" ("id", "taskId", "type", "actor", "body", "createdAt")
        VALUES ($1, $2, 'failed', 'worker', $3, NOW()) RETURNING "id"`,
      [`evt_${randomUUID()}`, scope.applicationTaskId, STOPPED_ERROR])
      if (event.rowCount !== 1) throw new StopFinalizationCasFailed()
      return "finalized" as const
    })
    await client.query("COMMIT")
    transactionOpen = false
    if (fenced.kind === "superseded") return "superseded"
    return fenced.value
  } catch {
    if (client && transactionOpen) await client.query("ROLLBACK").catch(() => undefined)
    return "unavailable"
  } finally {
    client?.release()
  }
}
