import { NextRequest } from "next/server";
import { requireAuth, isErrorResponse, ok, err } from "@/lib/api-helpers";
import { db } from "@/lib/db";

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: Params) {
  const auth = await requireAuth(_req);
  if (isErrorResponse(auth)) return auth;

  const { id: jobId } = await params;
  const job = await db.job.findUnique({ where: { id: jobId }, select: { userId: true } });
  if (!job || job.userId !== auth.userId) return err("Not found", 404);

  const results = await db.$queryRaw`
    SELECT id, status, mode, ats_type as "atsType", flow_used as "flowUsed",
           error, duration_ms as "durationMs", created_at as "createdAt"
    FROM apply_results
    WHERE job_id = ${jobId}
    ORDER BY created_at DESC
    LIMIT 10
  `;

  return ok({ results });
}
