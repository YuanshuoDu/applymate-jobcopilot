import { NextRequest } from "next/server";
import { requireAuth, isErrorResponse, err } from "@/lib/api-helpers";
import { db } from "@/lib/db";

type Params = { params: Promise<{ id: string }> };

export async function POST(_req: NextRequest, { params }: Params) {
  const auth = await requireAuth(_req);
  if (isErrorResponse(auth)) return auth;

  const { id: jobId } = await params;
  const job = await db.job.findUnique({ where: { id: jobId } });
  if (!job || job.userId !== auth.userId) return err("Not found", 404);
  return err('Automatic submission is disabled. Open the assisted application flow, review the extension-filled form, and submit it yourself.', 410);
}
