import type { Pool, PoolClient } from "pg";
import type { ApplicationSubmitIdentity } from "../queue/application-submit-fence.js";
import {
  appendFencedSubmitAudit,
  withExactAttemptFence,
} from "../queue/application-submit-fence.js";

export const UNCONFIRMED_SUBMISSION_MESSAGE =
  "The previous background attempt was interrupted after it started. ApplyMate did not retry it to avoid sending a duplicate application.";

export type SubmissionClaim = "claimed" | "unavailable" | "superseded";
export type ExactSubmissionWrite<T> =
  | { readonly kind: "current"; readonly value: T }
  | { readonly kind: "superseded" };

/** Runs a submit-attempt write in the shared recovery lock order. */
export async function withExactSubmissionWrite<T>(
  pool: Pool,
  identity: ApplicationSubmitIdentity,
  phase: string,
  write: (client: PoolClient) => Promise<T>,
): Promise<ExactSubmissionWrite<T>> {
  const client = await pool.connect();
  let transactionOpen = false;
  try {
    await client.query("BEGIN");
    transactionOpen = true;
    await client.query("SELECT set_config($1, $2, true)", ["app.user_id", identity.userId]);
    const fenced = await withExactAttemptFence(client, identity, () => write(client));
    if (fenced.kind === "superseded") {
      await appendFencedSubmitAudit(client, identity, phase);
      await client.query("COMMIT");
      transactionOpen = false;
      return fenced;
    }
    await client.query("COMMIT");
    transactionOpen = false;
    return fenced;
  } catch (error: unknown) {
    if (transactionOpen) await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Runs under a caller-owned transaction/client; it never begins or commits. */
export async function withExactSubmissionClientWrite<T>(
  client: PoolClient,
  identity: ApplicationSubmitIdentity,
  phase: string,
  write: () => Promise<T>,
): Promise<ExactSubmissionWrite<T>> {
  const fenced = await withExactAttemptFence(client, identity, write);
  if (fenced.kind === "superseded") await appendFencedSubmitAudit(client, identity, phase);
  return fenced;
}

/** Claims the exact approved task and queued Job before any browser is created. */
export async function claimUnattendedSubmission(
  pool: Pool,
  identity: ApplicationSubmitIdentity,
  workerTaskId: string,
): Promise<SubmissionClaim> {
  if (!workerTaskId.trim()) return "unavailable";
  const outcome = await withExactSubmissionWrite(pool, identity, "claim_unattended_submission", async client => {
    const approval = await client.query(
      `SELECT 1 FROM "agent_approvals"
       WHERE "id" = $1 AND "userId" = $2 AND "sessionId" = $3 AND "turnId" = $4 AND "taskId" = $5
         AND "jobId" = $6 AND "type" = 'submit_application' AND "toolCallId" = 'application-submit:' || $5
         AND "status" = 'approved' AND "scopeHash" = $7 AND "expiresAt" > NOW()
         AND "payload"->>'applicationTaskId' = $5 AND "payload"->>'jobId' = $6 FOR UPDATE`,
      [identity.approvalId, identity.userId, identity.sessionId, identity.fillTurnId, identity.applicationTaskId,
        identity.jobId, identity.constraintHash],
    );
    if (approval.rowCount !== 1) return "unavailable" as const;
    const task = await client.query(
      `UPDATE "application_tasks" SET "checkpoint" = 'browser_active', "updatedAt" = NOW()
       WHERE "id" = $1 AND "userId" = $2 AND "jobId" = $3 AND "sessionId" = $4 AND "fillTurnId" = $5
         AND "workerTaskId" = $6 AND "status" = 'filling' AND "checkpoint" = 'submission_authorized'
         AND EXISTS (SELECT 1 FROM "User" u WHERE u."id" = $2 AND u."accountStatus" = 'active')
         AND EXISTS (SELECT 1 FROM "Job" j WHERE j."id" = $3 AND j."userId" = $2 AND j."status" = 'saved' AND j."workflowState" = 'queued')
       RETURNING "id"`,
      [identity.applicationTaskId, identity.userId, identity.jobId, identity.sessionId, identity.fillTurnId, workerTaskId],
    );
    if (task.rowCount !== 1) return "unavailable" as const;
    const job = await client.query(
      `UPDATE "Job" SET "workflowState" = 'submitting', "updatedAt" = NOW()
       WHERE "id" = $1 AND "userId" = $2 AND "status" = 'saved' AND "workflowState" = 'queued' RETURNING "id"`,
      [identity.jobId, identity.userId],
    );
    if (job.rowCount !== 1) throw new Error("Application Job changed during its exact submit claim.");
    return "claimed" as const;
  });
  return outcome.kind === "current" ? outcome.value : "superseded";
}

/** Resolves a browser claim only after its terminal BullMQ event and lock check. */
export async function reconcileClaimedSubmissionUncertain(
  pool: Pool, identity: ApplicationSubmitIdentity, workerTaskId: string,
  isCurrentTerminalDelivery: () => Promise<boolean>,
): Promise<boolean> {
  if (!workerTaskId.trim()) return false;
  const outcome = await withExactSubmissionWrite(pool, identity, "terminal_submit_claim_recovery", async client => {
    // Worker terminal callbacks must validate the current BullMQ delivery only
    // after acquiring the same attempt fence as claim and outbox retry. An old
    // callback can otherwise observe an absent lock, wait here, and recover a
    // newer retry after it has claimed the browser attempt.
    if (!await isCurrentTerminalDelivery()) return false;
    const task = await client.query<{ sessionId: string | null }>(
      `UPDATE application_tasks SET status = 'waiting_for_user', "checkpoint" = 'submission_uncertain', error = $7, "updatedAt" = NOW()
       WHERE id = $1 AND "userId" = $2 AND "jobId" = $3 AND "sessionId" = $4 AND "fillTurnId" = $5 AND "workerTaskId" = $6
         AND status = 'filling' AND "checkpoint" IN ('browser_active', 'submission_request_started')
         AND EXISTS (SELECT 1 FROM "Job" j WHERE j.id = $3 AND j."userId" = $2 AND j.status = 'saved' AND j."workflowState" = 'submitting')
       RETURNING "sessionId"`,
      [identity.applicationTaskId, identity.userId, identity.jobId, identity.sessionId, identity.fillTurnId, workerTaskId, UNCONFIRMED_SUBMISSION_MESSAGE],
    );
    if (task.rowCount !== 1) return false;
    await client.query(`INSERT INTO application_task_events (id, "taskId", type, actor, body, "createdAt")
      VALUES ('evt_' || md5(random()::text || clock_timestamp()::text), $1, 'waiting_for_user', 'worker', $2, NOW())`,
      [identity.applicationTaskId, UNCONFIRMED_SUBMISSION_MESSAGE]);
    const sessionId = task.rows[0]?.sessionId;
    if (sessionId) {
      const tasks = await client.query<{ status: string }>(`SELECT status FROM application_tasks WHERE "sessionId" = $1`, [sessionId]);
      const statuses = tasks.rows.map(row => String(row.status));
      const status = statuses.includes("filling") ? "running"
        : statuses.some(value => value === "waiting_for_user" || value === "waiting_for_authorization") ? "waiting_for_user" : "completed";
      await client.query(`UPDATE agent_sessions SET status = $2, "completedAt" = CASE WHEN $2 = 'completed' THEN NOW() ELSE NULL END, "updatedAt" = NOW()
        WHERE id = $1 AND status NOT IN ('aborted', 'archived', 'completed', 'failed')`, [sessionId, status]);
    }
    return true;
  });
  return outcome.kind === "current" && outcome.value;
}

/** Returns a job to the review queue without ever re-opening its application form. */
export async function releaseUncertainSubmission(
  pool: Pool,
  identity: ApplicationSubmitIdentity,
): Promise<ExactSubmissionWrite<boolean>> {
  return withExactSubmissionWrite(pool, identity, "release_uncertain_submission", client =>
    releaseUncertainSubmissionWithClient(client, identity));
}

async function releaseUncertainSubmissionWithClient(
  client: PoolClient,
  identity: ApplicationSubmitIdentity,
): Promise<boolean> {
  const result = await client.query(
    `UPDATE "Job"
       SET "workflowState" = 'ready_to_apply',
           "analysisNote" = $3,
           "updatedAt" = NOW()
     WHERE id = $1 AND "userId" = $2 AND "workflowState" = 'submitting'`,
    [identity.jobId, identity.userId, `[Autopilot needs review] ${UNCONFIRMED_SUBMISSION_MESSAGE}`],
  );
  return result.rowCount === 1;
}

/** Fences all submit-owned Job workflow/status updates, including late callbacks. */
export async function updateJobForSubmission(
  pool: Pool,
  identity: ApplicationSubmitIdentity,
  input: { readonly status: string; readonly workflowState: string; readonly applied?: boolean; readonly expectedWorkflowStates?: readonly string[] },
  phase: string,
): Promise<ExactSubmissionWrite<boolean>> {
  const outcome = await withExactSubmissionWrite(pool, identity, phase, async client => {
    const result = await client.query(
      `UPDATE "Job" SET status = $1, "workflowState" = $2,
         "appliedAt" = CASE WHEN $3 THEN NOW() ELSE "appliedAt" END, "updatedAt" = NOW()
       WHERE id = $4 AND "userId" = $5
         AND ($6::text[] IS NULL OR "workflowState" = ANY($6::text[]))`,
      [input.status, input.workflowState, input.applied === true, identity.jobId, identity.userId, input.expectedWorkflowStates ?? null],
    );
    return result.rowCount === 1;
  });
  return outcome;
}
