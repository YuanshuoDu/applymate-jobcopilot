import { db } from "@/lib/db";
import { Prisma } from "@prisma/client";
import { enqueueApplyTask } from "@/lib/apply-queue-client";
import { assessApplicationPreflight, isSupportedAutomatedApplyUrl } from "@/lib/agent/application-preflight";
import { isRuntimeFeatureEnabled } from '@/lib/runtime-feature-flags'

export class AutoApplyError extends Error {}

async function assertActiveAccount(userId: string): Promise<void> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { accountStatus: true } })
  if (user?.accountStatus !== 'active') throw new AutoApplyError('Account is not active.')
}

async function assertUnattendedApplyEnabled(userId: string): Promise<void> {
  try {
    if (!await isRuntimeFeatureEnabled('unattended_apply', userId)) {
      throw new AutoApplyError('Unattended applications are temporarily unavailable.')
    }
  } catch (error) {
    if (error instanceof AutoApplyError) throw error
    throw new AutoApplyError('Unattended applications are temporarily unavailable.')
  }
}

export function validateAutoApplyUrl(rawUrl: string | null | undefined): string {
  const url = rawUrl?.trim();
  if (!url) throw new AutoApplyError("This job has no application URL.");

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new AutoApplyError("The application URL is invalid.");
  }

  if (parsed.protocol !== "https:") {
    throw new AutoApplyError("Automatic applications require an HTTPS destination.");
  }

  if (!isSupportedAutomatedApplyUrl(parsed.toString())) {
    throw new AutoApplyError("Automatic application requires a direct supported ATS link, not a job-board or unknown destination.");
  }

  return parsed.toString();
}

async function assertJobPreflight(input: { userId: string; jobId: string }) {
  const job = await db.job.findFirst({
    where: { id: input.jobId, userId: input.userId },
    select: { company: true, description: true, source: true, url: true },
  })
  if (!job) throw new AutoApplyError("The job could not be found for application preflight.")
  const preflight = assessApplicationPreflight(job)
  if (!preflight.canAutomate) throw new AutoApplyError(preflight.issues.map(issue => issue.message).join(" "))
}

/** Dispatches the safe first browser pass: fill fields, then stop for review. */
export async function queueApplicationFill(input: {
  userId: string;
  jobId: string;
  applyUrl: string | null | undefined;
  applicationTaskId: string;
  resumeAfterUserInput?: boolean;
}): Promise<{ taskId: string }> {
  await assertActiveAccount(input.userId)
  await assertUnattendedApplyEnabled(input.userId)
  const applyUrl = validateAutoApplyUrl(input.applyUrl);
  await assertJobPreflight(input)
  const claimed = await db.applicationTask.updateMany({
    where: {
      id: input.applicationTaskId,
      userId: input.userId,
      jobId: input.jobId,
      status: "waiting_for_user",
      checkpoint: input.resumeAfterUserInput ? "form_answer_required" : "materials_ready",
    },
    data: { status: "filling", checkpoint: "form_fill_queued", question: Prisma.DbNull, startedAt: new Date() },
  });
  if (claimed.count !== 1) throw new AutoApplyError("This application is no longer ready for the form-fill review pass.");

  try {
    const taskId = await enqueueApplyTask({ applicationTaskId: input.applicationTaskId, jobId: input.jobId, userId: input.userId, applyUrl, operation: "fill" });
    await db.applicationTask.update({ where: { id: input.applicationTaskId }, data: { workerTaskId: taskId } });
    await db.applicationTaskEvent.create({ data: { taskId: input.applicationTaskId, type: "form_fill_queued", actor: "reviewer", body: "Material review approved; worker will fill the form without submitting it.", data: { workerTaskId: taskId } } });
    return { taskId };
  } catch (error) {
    await db.applicationTask.updateMany({ where: { id: input.applicationTaskId, status: "filling", checkpoint: "form_fill_queued" }, data: { status: "waiting_for_user", checkpoint: "materials_ready" } }).catch(() => undefined);
    throw error;
  }
}

export async function queueAutonomousApplication(input: {
  userId: string;
  jobId: string;
  applyUrl: string | null | undefined;
  applicationTaskId: string;
  /** Approved per-job authorization. Global settings can never replace this. */
  approvalId: string;
}): Promise<{ taskId: string }> {
  await assertActiveAccount(input.userId)
  await assertUnattendedApplyEnabled(input.userId)
  const applyUrl = validateAutoApplyUrl(input.applyUrl);
  await assertJobPreflight(input)
  const approval = await db.agentApproval.findFirst({
    where: { id: input.approvalId, userId: input.userId, status: "approved", type: "submit_application" },
    select: { payload: true },
  });
  const payload = approval?.payload as { applicationTaskId?: unknown; jobId?: unknown } | undefined;
  if (payload?.applicationTaskId !== input.applicationTaskId || payload.jobId !== input.jobId) {
    throw new AutoApplyError("A current, explicit approval is required before this application can be submitted.");
  }

  const claimed = await db.$transaction(async tx => {
    const material = await tx.applicationTask.findFirst({
      where: {
        id: input.applicationTaskId,
        userId: input.userId,
        jobId: input.jobId,
        status: "waiting_for_authorization",
        checkpoint: "form_filled",
        resumeId: { not: null },
        question: { equals: Prisma.DbNull },
      },
      select: { resumeId: true, coverLetterId: true },
    });
    if (!material?.resumeId) return false;

    // A stale task must not submit a resume from another job. A candidate's
    // current default resume is valid fallback material; any adapted resume
    // must be explicitly linked to this job.
    const resume = await tx.resume.findFirst({
      where: {
        id: material.resumeId,
        userId: input.userId,
        OR: [{ targetJobId: input.jobId }, { isDefault: true }],
      },
      select: { id: true },
    });
    if (!resume) return false;

    // Cover letters are optional, but when a task has one it must be the
    // current user's artifact for this exact job and selected resume.
    if (material.coverLetterId) {
      const coverLetter = await tx.coverLetter.findFirst({
        where: {
          id: material.coverLetterId,
          userId: input.userId,
          jobId: input.jobId,
          resumeId: material.resumeId,
        },
        select: { id: true },
      });
      if (!coverLetter) return false;
    }
    const task = await tx.applicationTask.updateMany({
      where: {
        id: input.applicationTaskId,
        userId: input.userId,
        jobId: input.jobId,
        status: "waiting_for_authorization",
        checkpoint: "form_filled",
        resumeId: { not: null },
        question: { equals: Prisma.DbNull },
      },
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
      operation: "submit",
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
    await db.$transaction(async tx => {
      await tx.job.updateMany({ where: { id: input.jobId, userId: input.userId, workflowState: "queued" }, data: { workflowState: "ready_to_apply" } })
      await tx.applicationTask.updateMany({ where: { id: input.applicationTaskId, status: "filling" }, data: { status: "waiting_for_authorization", checkpoint: "queue_retry" } })
    }).catch(() => undefined);
    throw error;
  }
}
