import { db } from "@/lib/db";
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
  /** A pipeline may carry a validated per-run automation policy. */
  approvalPolicy?: { autoApply: boolean; requireApproval: boolean };
}): Promise<{ taskId: string }> {
  const applyUrl = validateAutoApplyUrl(input.applyUrl);
  const config = input.approvalPolicy ?? await db.agentConfig.findUnique({
    where: { userId: input.userId },
    select: { autoApply: true, requireApproval: true },
  });
  if (!config?.autoApply || config.requireApproval) {
    throw new AutoApplyError("Enable Auto-apply and turn off manual review before queuing unattended submissions.");
  }

  const claimed = await db.job.updateMany({
    where: {
      id: input.jobId,
      userId: input.userId,
      status: "saved",
      workflowState: { in: ["draft", "ready_to_apply"] },
    },
    data: {
      workflowState: "queued",
      analysisNote: "[Autopilot queued] ApplyMate is submitting this application in the background.",
    },
  });
  if (claimed.count !== 1) {
    throw new AutoApplyError("This job is already queued, submitted, or no longer ready to apply.");
  }

  try {
    const taskId = await enqueueApplyTask({
      jobId: input.jobId,
      userId: input.userId,
      applyUrl,
    });
    await db.activity.create({
      data: {
        userId: input.userId,
        jobId: input.jobId,
        type: "agent_action",
        text: "Agent queued this application for unattended submission.",
        color: "#7C3AED",
      },
    });
    return { taskId };
  } catch (error) {
    await db.job.updateMany({
      where: { id: input.jobId, userId: input.userId, workflowState: "queued" },
      data: { workflowState: "ready_to_apply" },
    }).catch(() => undefined);
    throw error;
  }
}
