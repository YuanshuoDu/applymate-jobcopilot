import { NextRequest } from "next/server";
import { requireAuth, isErrorResponse, ok } from "@/lib/api-helpers";
import { db } from "@/lib/db";

type NotificationRow = {
  id: string;
  type: string;
  title: string;
  body: string | null;
  read: boolean;
  jobId: string | null;
  createdAt: Date;
};

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (isErrorResponse(auth)) return auth;

  const notifications = await db.$queryRaw`
    SELECT
      id,
      type,
      title,
      body,
      read,
      job_id     AS "jobId",
      created_at AS "createdAt"
    FROM notifications
    WHERE user_id = ${auth.userId}
      AND created_at > NOW() - INTERVAL '30 days'
    ORDER BY created_at DESC
    LIMIT 50
  ` as NotificationRow[];

  const unreadCount = notifications.filter((n) => !n.read).length;
  return ok({ notifications, unreadCount });
}
