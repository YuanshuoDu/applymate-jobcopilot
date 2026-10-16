import type { Pool, PoolClient } from "pg";
import type { ApplicationSubmitIdentity } from "../queue/application-submit-fence.js";
import {
  appendFencedSubmitAudit,
  withExactAttemptFence,
} from "../queue/application-submit-fence.js";

export const UNCONFIRMED_SUBMISSION_MESSAGE =
  "The previous background attempt was interrupted after it started. ApplyMate did not retry it to avoid sending a duplicate application.";

export type SubmissionClaim = "claimed" | "uncertain" | "unavailable" | "superseded";
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

/**
 * Atomically moves a queued job into the browser-submission critical section.
 * A second delivery never opens the form again: a prior `submitting` state is
 * deliberately released for review instead of being retried.
 */
export async function claimUnattendedSubmission(
  pool: Pool,
  identity: ApplicationSubmitIdentity,
): Promise<SubmissionClaim> {
  const outcome = await withExactSubmissionWrite(pool, identity, "claim_unattended_submission", async (client) => {
    const claimed = await client.query(
      `UPDATE "Job"
         SET "workflowState" = 'submitting', "updatedAt" = NOW()
       WHERE id = $1
         AND "userId" = $2
         AND EXISTS (SELECT 1 FROM "User" u WHERE u.id = "Job"."userId" AND u."accountStatus" = 'active')
         AND status = 'saved'
         AND "workflowState" = 'queued'
       RETURNING id`,
      [identity.jobId, identity.userId],
    );
    if (claimed.rowCount === 1) return "claimed" as const;

    const current = await client.query(
      `SELECT "workflowState" FROM "Job" WHERE id = $1 AND "userId" = $2`,
      [identity.jobId, identity.userId],
    );
    const row = current.rows[0] as { workflowState?: unknown } | undefined;
    if (row?.workflowState !== "submitting") return "unavailable" as const;
    const released = await releaseUncertainSubmissionWithClient(client, identity);
    return released ? "uncertain" as const : "unavailable" as const;
  });
  return outcome.kind === "current" ? outcome.value : "superseded";
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
