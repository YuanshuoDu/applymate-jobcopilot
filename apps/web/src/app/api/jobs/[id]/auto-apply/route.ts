import { NextRequest } from "next/server";
import { requireAuth, isErrorResponse, ok, err } from "@/lib/api-helpers";
import { db } from "@/lib/db";
import { enqueueApplyTask } from "@/lib/apply-queue-client";

type Params = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, { params }: Params) {
  const auth = await requireAuth(req);
  if (isErrorResponse(auth)) return auth;

  const { id: jobId } = await params;
  const job = await db.job.findUnique({ where: { id: jobId } });
  if (!job || job.userId !== auth.userId) return err("Not found", 404);
  if (!job.url) return err("Job has no apply URL", 400);

  // DEDUP GUARD: prevent double-apply
  if (job.status === 'applied') return err('Already applied or in progress', 409)

  const body = await req.json().catch(() => ({})) as { dryRun?: boolean };

  const taskId = await enqueueApplyTask({
    jobId,
    userId: auth.userId,
    applyUrl: job.url,
    personaId: auth.userId,
    resumePath: auth.userId,
    dryRun: body.dryRun ?? false,
  });


  return ok({ queued: true, taskId });
}
