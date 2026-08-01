import { db } from "@/lib/db";
import { Prisma } from "@prisma/client";
import { enqueueApplyTask } from "@/lib/apply-queue-client";

const BLOCKED_HOSTS = ["linkedin.com", "indeed.com"];

export class AutoApplyError extends Error {}

export function validateAutoApplyUrl(rawUrl: string | null | undefined): string {
  const url = rawUrl?.trim();
  if (!url) throw new AutoApplyError("This job has no application URL.");

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new AutoApplyError("The application URL is invalid.");
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new AutoApplyError("The application URL must use HTTP or HTTPS.");
  }

  const host = parsed.hostname.toLowerCase();
  if (BLOCKED_HOSTS.some(blocked => host === blocked || host.endsWith(`.${blocked}`))) {
    throw new AutoApplyError("Automatic submission is not supported on this job board.");
  }

  return parsed.toString();
}

export async function queueAutonomousApplication(input: {
  userId: string;
  jobId: string;
  applyUrl: string | null | undefined;
  applicationTaskId: string;
  /** Approved per-job authorization. Global settings can never replace this. */
  approvalId: string;
}): Promise<{ taskId: string }> {
  const applyUrl = validateAutoApplyUrl(input.applyUrl);
  const approval = await db.agentApproval.findFirst({
    where: { id: input.approvalId, userId: input.userId, status: "approved", type: "submit_application" },
    select: { payload: true },
  });
  const payload = approval?.payload as { applicationTaskId?: unknown; jobId?: unknown } | undefined;
  if (payload?.applicationTaskId !== input.applicationTaskId || payload.jobId !== input.jobId) {
    throw new AutoApplyError("A current, explicit approval is required before this application can be submitted.");
  }

  const claimed = await db.$transaction(async tx => {
    const task = await tx.applicationTask.updateMany({
      where: { id: input.applicationTaskId, userId: input.userId, jobId: input.jobId, status: "waiting_for_authorization" },
      data: { status: "filling", checkpoint: "submission_authorized", question: Prisma.DbNull, startedAt: new Date() },
    });
    if (task.count !== 1) return false;
    const job = await tx.job.updateMany({
      where: { id: input.jobId, userId: input.userId, status: "saved", workflowState: "ready_to_apply" },
      data: { workflowState: "queued", analysisNote: "[Approved submission] Applying in the background after explicit user authorization." },
    });
    return job.count === 1;
  });
  if (!claimed) {
    throw new AutoApplyError("This application is no longer ready for the approved submission step.");
  }

  try {
    const taskId = await enqueueApplyTask({
      applicationTaskId: input.applicationTaskId,
      jobId: input.jobId,
      userId: input.userId,
      applyUrl,
    });
    await db.activity.create({
      data: {
        userId: input.userId,
        jobId: input.jobId,
        type: "agent_action",
        text: "Agent queued this application after explicit per-job user authorization.",
        color: "#7C3AED",
      },
    });
    await db.applicationTask.update({ where: { id: input.applicationTaskId }, data: { workerTaskId: taskId } });
    await db.applicationTaskEvent.create({
      data: {
        taskId: input.applicationTaskId,
        type: "submission_queued",
        actor: "user",
        body: "User approved this job for background submission.",
        data: { approvalId: input.approvalId, workerTaskId: taskId },
      },
    });
    return { taskId };
  } catch (error) {
    await db.$transaction([
      db.job.updateMany({ where: { id: input.jobId, userId: input.userId, workflowState: "queued" }, data: { workflowState: "ready_to_apply" } }),
      db.applicationTask.updateMany({ where: { id: input.applicationTaskId, status: "filling" }, data: { status: "waiting_for_authorization", checkpoint: "queue_retry" } }),
    ]).catch(() => undefined);
    throw error;
  }
}
