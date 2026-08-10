import type { Pool } from "pg";

export const UNCONFIRMED_SUBMISSION_MESSAGE =
  "The previous background attempt was interrupted after it started. ApplyMate did not retry it to avoid sending a duplicate application.";

export type SubmissionClaim = "claimed" | "uncertain" | "unavailable";

/**
 * Atomically moves a queued job into the browser-submission critical section.
 * A second delivery never opens the form again: a prior `submitting` state is
 * deliberately released for review instead of being retried.
 */
export async function claimUnattendedSubmission(
  pool: Pool,
  userId: string,
  jobId: string,
): Promise<SubmissionClaim> {
  const claimed = await pool.query(
    `UPDATE "Job"
       SET "workflowState" = 'submitting', "updatedAt" = NOW()
     WHERE id = $1
       AND "userId" = $2
       AND EXISTS (SELECT 1 FROM "User" u WHERE u.id = "Job"."userId" AND u."accountStatus" = 'active')
       AND status = 'saved'
       AND "workflowState" = 'queued'
     RETURNING id`,
    [jobId, userId],
  );
  if (claimed.rowCount === 1) return "claimed";

  const current = await pool.query(
    `SELECT "workflowState" FROM "Job" WHERE id = $1 AND "userId" = $2`,
    [jobId, userId],
  );
  const row = current.rows[0] as { workflowState?: unknown } | undefined;
  if (row?.workflowState !== "submitting") return "unavailable";

  const released = await releaseUncertainSubmission(pool, userId, jobId);
  return released ? "uncertain" : "unavailable";
}

/** Returns a job to the review queue without ever re-opening its application form. */
export async function releaseUncertainSubmission(
  pool: Pool,
  userId: string,
  jobId: string,
): Promise<boolean> {
  const result = await pool.query(
    `UPDATE "Job"
       SET "workflowState" = 'ready_to_apply',
           "analysisNote" = $3,
           "updatedAt" = NOW()
     WHERE id = $1 AND "userId" = $2 AND "workflowState" = 'submitting'`,
    [jobId, userId, `[Autopilot needs review] ${UNCONFIRMED_SUBMISSION_MESSAGE}`],
  );
  return result.rowCount === 1;
}
