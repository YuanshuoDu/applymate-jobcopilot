import { NextRequest } from "next/server";
import { requireAuth, isErrorResponse, err } from "@/lib/api-helpers";
import { db } from "@/lib/db";

type Params = { params: Promise<{ id: string }> };

export async function POST(_req: NextRequest, { params }: Params) {
  const auth = await requireAuth(_req);
  if (isErrorResponse(auth)) return auth;

  const { id: jobId } = await params;
  const job = await db.job.findUnique({
    where: { id: jobId },
    select: { userId: true },
  });
  if (!job || job.userId !== auth.userId) return err("Not found", 404);

  // A job-page click cannot be treated as final external consent. The Agent
  // session creates a review record and a distinct submit authorization first.
  return err("Review and explicitly authorize this application from the Agent session before queuing it.", 409);
}
