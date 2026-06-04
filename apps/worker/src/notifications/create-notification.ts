import { getPool } from "../db/apply-results.js";

export type ApplyNotificationType =
  | "apply_submitted"
  | "apply_manual"
  | "apply_failed";

export interface CreateNotificationParams {
  type: ApplyNotificationType;
  title: string;
  body?: string | null;
  jobId?: string | null;
}

export async function createNotification(
  userId: string,
  params: CreateNotificationParams
): Promise<void> {
  await getPool().query(
    `INSERT INTO notifications (user_id, type, title, body, job_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      userId,
      params.type,
      params.title,
      params.body ?? null,
      params.jobId ?? null,
    ]
  );
}
