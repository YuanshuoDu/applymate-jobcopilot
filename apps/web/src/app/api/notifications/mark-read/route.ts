import { NextRequest } from "next/server";
import { requireAuth, isErrorResponse, ok } from "@/lib/api-helpers";
import { db } from "@/lib/db";

type TableExistsRow = {
  exists: boolean;
};

async function notificationsTableExists() {
  const rows = await db.$queryRaw<TableExistsRow[]>`
    SELECT to_regclass('public.notifications') IS NOT NULL AS "exists"
  `;
  return rows[0]?.exists === true;
}

export async function PATCH(req: NextRequest) {
  const auth = await requireAuth(req);
  if (isErrorResponse(auth)) return auth;

  const body = await req.json().catch(() => ({})) as { id?: unknown };
  const id = typeof body.id === "string" && body.id.trim() ? body.id.trim() : null;

  if (!(await notificationsTableExists())) {
    return ok({ ok: true });
  }

  if (id) {
    await db.$executeRaw`
      UPDATE notifications
      SET read = true
      WHERE user_id = ${auth.userId} AND id = ${id}
    `;
  } else {
    await db.$executeRaw`
      UPDATE notifications
      SET read = true
      WHERE user_id = ${auth.userId}
    `;
  }

  return ok({ ok: true });
}
