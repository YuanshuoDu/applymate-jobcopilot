import type { Pool } from "pg";

type TerminalStatus = "submitted" | "failed" | "waiting_for_user";

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
  await pool.query(
    `UPDATE application_tasks
       SET status = $2, "checkpoint" = $3, error = $4,
           "completedAt" = CASE WHEN $2 IN ('submitted', 'failed') THEN NOW() ELSE NULL END,
           "updatedAt" = NOW()
     WHERE id = $1`,
    [taskId, status, checkpoint, error],
  );
  await pool.query(
    `INSERT INTO application_task_events (id, "taskId", type, actor, body, "createdAt")
     VALUES ('evt_' || md5(random()::text || clock_timestamp()::text), $1, $2, 'worker', $3, NOW())`,
    [taskId, status, error ?? checkpoint],
  );
}

export function needsUserTakeover(error: string | null | undefined): boolean {
  return /captcha|log[ -]?in|sign[ -]?in|two[ -]?factor|2fa|verification code|platform restriction/i.test(error ?? "");
}
