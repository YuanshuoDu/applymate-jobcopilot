import { NextRequest } from "next/server";
import { requireAuth, isErrorResponse, err } from "@/lib/api-helpers";
import { db } from "@/lib/db";
import { AutoApplyError, queueAutonomousApplication } from "@/lib/auto-apply";

type Params = { params: Promise<{ id: string }> };

export async function POST(_req: NextRequest, { params }: Params) {
  const auth = await requireAuth(_req);
  if (isErrorResponse(auth)) return auth;

  const { id: jobId } = await params;
  const job = await db.job.findUnique({
    where: { id: jobId },
    select: { userId: true, url: true },
  });
  if (!job || job.userId !== auth.userId) return err("Not found", 404);

  try {
    const { taskId } = await queueAutonomousApplication({
      userId: auth.userId,
      jobId,
      applyUrl: job.url,
    });
    return Response.json({ queued: true, taskId }, { status: 202 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not queue automatic submission.";
    return err(message, error instanceof AutoApplyError ? 409 : 503);
  }
}
