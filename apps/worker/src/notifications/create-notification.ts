import { getPool } from "../db/apply-results.js";

export type ApplyNotificationType =
  | "apply_submitted"
  | "apply_manual"
  | "apply_failed"
  | "apply_blocked";

export interface CreateNotificationParams {
  type: ApplyNotificationType;
  title: string;
  body?: string | null;
  jobId?: string | null;
}

type NotificationPreferenceKey = "apply" | "reject" | "interview" | "offer" | "weekly" | "followUp";

function preferenceKey(type: ApplyNotificationType): NotificationPreferenceKey {
  // Worker notifications represent application outcomes. A failed attempt is
  // not an employer rejection, so every current worker result follows apply.
  void type;
  return "apply";
}

async function notificationsEnabled(userId: string, type: ApplyNotificationType): Promise<boolean> {
  try {
    const result = await getPool().query<{ preferences?: unknown }>(
      `SELECT preferences FROM "User" WHERE id = $1 LIMIT 1`,
      [userId],
    );
    const row = result.rows[0];
    const prefs = row?.preferences;
    if (!prefs || typeof prefs !== "object" || Array.isArray(prefs)) return true;
    const notificationPrefs = (prefs as Record<string, unknown>).notificationPreferences;
    if (!notificationPrefs || typeof notificationPrefs !== "object" || Array.isArray(notificationPrefs)) return true;
    const configured = (notificationPrefs as Record<string, unknown>)[preferenceKey(type)];
    return typeof configured === "boolean" ? configured : true;
  } catch {
    // A preference read must not make a completed application look failed.
    return true;
  }
}

export async function createNotification(
  userId: string,
  params: CreateNotificationParams
): Promise<void> {
  if (!(await notificationsEnabled(userId, params.type))) return;
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
