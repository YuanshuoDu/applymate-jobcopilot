import type { Pool } from "pg";
import type { FormReviewNeeds } from "../harness/form-review.js";

type TerminalStatus = "submitted" | "failed" | "waiting_for_user" | "waiting_for_authorization";

/** Worker-side guard: a stale/revoked queue payload must never open a browser. */
export async function claimApplicationTask(
  pool: Pool,
  taskId: string,
  userId: string,
  jobId: string,
): Promise<boolean> {
  const result = await pool.query(
    `UPDATE application_tasks
     SET status = 'filling', "checkpoint" = 'browser_active', "updatedAt" = NOW()
     WHERE id = $1 AND "userId" = $2 AND "jobId" = $3 AND status = 'filling'
       AND EXISTS (SELECT 1 FROM "User" u WHERE u.id = application_tasks."userId" AND u."accountStatus" = 'active')
     RETURNING id`,
    [taskId, userId, jobId],
  );
  return result.rowCount === 1;
}

export async function finishApplicationTask(
  pool: Pool,
  taskId: string,
  status: TerminalStatus,
  checkpoint: string,
  error: string | null,
): Promise<void> {
  const session = await pool.query(`SELECT "sessionId" FROM application_tasks WHERE id = $1`, [taskId]);
  const sessionId = session.rows[0]?.sessionId as string | null | undefined;
  await pool.query(
    `UPDATE application_tasks
       SET status = $2, "checkpoint" = $3, error = $4,
           "completedAt" = CASE WHEN $2 IN ('submitted', 'failed') THEN NOW() ELSE NULL END,
           "updatedAt" = NOW()
     WHERE id = $1 AND status NOT IN ('cancelled', 'submitted')`,
    [taskId, status, checkpoint, error],
  );
  await pool.query(
    `INSERT INTO application_task_events (id, "taskId", type, actor, body, "createdAt")
     VALUES ('evt_' || md5(random()::text || clock_timestamp()::text), $1, $2, 'worker', $3, NOW())`,
    [taskId, status, error ?? checkpoint],
  );
  if (sessionId) await refreshSessionStatus(pool, sessionId);
}

export async function applicationTaskStillActive(pool: Pool, taskId: string, userId: string, jobId: string): Promise<boolean> {
  const result = await pool.query(
    `SELECT 1 FROM application_tasks t
       JOIN "User" u ON u.id = t."userId"
      WHERE t.id = $1 AND t."userId" = $2 AND t."jobId" = $3
        AND t.status = 'filling' AND t."checkpoint" = 'browser_active'
        AND u."accountStatus" = 'active'
      LIMIT 1`,
    [taskId, userId, jobId],
  )
  return result.rowCount === 1
}

async function refreshSessionStatus(pool: Pool, sessionId: string): Promise<void> {
  const result = await pool.query(`SELECT status FROM application_tasks WHERE "sessionId" = $1`, [sessionId]);
  const statuses = result.rows.map(row => String(row.status));
  const status = statuses.includes("filling")
    ? "running"
    : statuses.some(value => value === "waiting_for_user" || value === "waiting_for_authorization")
      ? "waiting_for_user"
      : "completed";
  await pool.query(
    `UPDATE agent_sessions SET status = $2, "completedAt" = CASE WHEN $2 = 'completed' THEN NOW() ELSE NULL END, "updatedAt" = NOW() WHERE id = $1`,
    [sessionId, status],
  );
}

/**
 * Completes the non-submitting fill pass and creates the only approval that
 * can unlock a later browser submission.  It is durable, so refreshing the
 * Agent session after a worker restart still shows the same checkpoint.
 */
export async function completeFillForReview(
  pool: Pool,
  taskId: string,
  userId: string,
  jobId: string,
): Promise<boolean> {
  const transitioned = await pool.query<{ sessionId: string | null }>(
    `UPDATE application_tasks
       SET status = 'waiting_for_authorization', "checkpoint" = 'form_filled', error = NULL, "updatedAt" = NOW()
     WHERE id = $1 AND "userId" = $2 AND "jobId" = $3 AND status = 'filling'
     RETURNING "sessionId"`,
    [taskId, userId, jobId],
  );
  if (transitioned.rowCount !== 1) return false;
  const sessionId = transitioned.rows[0]?.sessionId;
  if (!sessionId) throw new Error("Filled application is missing its Agent session");
  const approvalId = `approval_${randomId()}`;
  const title = "Final submission authorization";
  const body = "The form was filled without submission. Review the current job, material alignment, required answers, and any sensitive declarations before authorizing this external submission.";
  const payload = { applicationTaskId: taskId, jobId };
  await pool.query(
    `INSERT INTO agent_approvals (id, "sessionId", "taskId", "userId", type, status, title, body, impact, payload, "createdAt")
     VALUES ($1, $2, NULL, $3, 'submit_application', 'pending', $4, $5,
             jsonb_build_object('externalSubmission', true, 'jobId', $6), $7::jsonb, NOW())`,
    [approvalId, sessionId, userId, title, body, jobId, JSON.stringify(payload)],
  );
  await pool.query(
    `INSERT INTO agent_transcript_events (id, "sessionId", "taskId", type, speaker, title, body, data, "createdAt")
     VALUES ($1, $2, NULL, 'approval_request', 'Executor', $3, $4,
             jsonb_build_object('approval', jsonb_build_object('id', $5, 'type', 'submit_application', 'title', $3, 'body', $4, 'impact', jsonb_build_object('externalSubmission', true, 'jobId', $6), 'payload', $7::jsonb, 'status', 'pending')), NOW())`,
    [`evt_${randomId()}`, sessionId, title, body, approvalId, jobId, JSON.stringify(payload)],
  );
  await pool.query(
    `INSERT INTO application_task_events (id, "taskId", type, actor, body, "createdAt")
     VALUES ($1, $2, 'form_filled', 'worker', $3, NOW())`,
    [`evt_${randomId()}`, taskId, "Form filled without submission; final user authorization requested."],
  );
  await pool.query(
    `UPDATE agent_sessions SET status = 'waiting_for_user', "completedAt" = NULL, "updatedAt" = NOW() WHERE id = $1`,
    [sessionId],
  );
  return true;
}

export async function pauseForFormInput(
  pool: Pool,
  taskId: string,
  detail: string,
  needs: FormReviewNeeds,
): Promise<void> {
  const current = await pool.query(`SELECT "sessionId" FROM application_tasks WHERE id = $1`, [taskId]);
  const sessionId = current.rows[0]?.sessionId as string | null | undefined;
  await pool.query(
    `UPDATE application_tasks
       SET status = 'waiting_for_user', "checkpoint" = 'form_answer_required', error = $2,
           question = jsonb_build_object('detail', $2, 'missing', $3::jsonb, 'sensitive', $4::jsonb), "updatedAt" = NOW()
     WHERE id = $1`,
    [taskId, detail, JSON.stringify(needs.missing), JSON.stringify(needs.sensitive)],
  );
  await pool.query(
    `INSERT INTO application_task_events (id, "taskId", type, actor, body, "createdAt") VALUES ($1, $2, 'form_answer_required', 'worker', $3, NOW())`,
    [`evt_${randomId()}`, taskId, detail],
  );
  if (sessionId) {
    await pool.query(
      `INSERT INTO agent_transcript_events (id, "sessionId", "taskId", type, speaker, title, body, "createdAt") VALUES ($1, $2, NULL, 'subagent_result', 'Executor', 'Information required', $3, NOW())`,
      [`evt_${randomId()}`, sessionId, detail],
    );
    await pool.query(`UPDATE agent_sessions SET status = 'waiting_for_user', "completedAt" = NULL, "updatedAt" = NOW() WHERE id = $1`, [sessionId]);
  }
}

export function needsUserTakeover(error: string | null | undefined): boolean {
  return /captcha|log[ -]?in|sign[ -]?in|two[ -]?factor|2fa|verification code|platform restriction/i.test(error ?? "");
}

function randomId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
}
