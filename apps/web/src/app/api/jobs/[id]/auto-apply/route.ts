import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isErrorResponse, ok, err } from "@/lib/api-helpers";
import { db } from "@/lib/db";
import { enqueueApplyTask } from "@/lib/apply-queue-client";
import { checkRateLimit } from "@/lib/rate-limit";

type Params = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, { params }: Params) {
  const auth = await requireAuth(req);
  if (isErrorResponse(auth)) return auth;

  // Rate limit: max 10 auto-apply requests per user per hour
  const rl = checkRateLimit(`auto-apply:${auth.userId}`, 10, 3_600_000);
  if (!rl.ok) {
    return NextResponse.json(
      { error: "Rate limit exceeded. Try again later." },
      { status: 429 }
    );
  }

  const { id: jobId } = await params;
  const job = await db.job.findUnique({ where: { id: jobId } });
  if (!job || job.userId !== auth.userId) return err("Not found", 404);
  if (!job.url) return err("Job has no apply URL", 400);

  // DEDUP GUARD: prevent double-apply
  if (job.status === "applied") return err("Already applied or in progress", 409);

  const body = await req.json().catch(() => ({})) as { dryRun?: boolean };

  const taskId = await enqueueApplyTask({
    jobId,
    userId: auth.userId,
    applyUrl: job.url,
    personaId: auth.userId,
    resumePath: '',   // worker generates PDF from DB resume; empty string = no fallback path
    dryRun: body.dryRun ?? false,
  });

  // Mark job as applied for dedup guard + frontend status badge
  await db.job.update({
    where: { id: jobId },
    data: { status: 'applied', appliedAt: new Date() },
  }).catch(() => {});

  return ok({ queued: true, taskId });
}
