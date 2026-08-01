/**
 * Stage 5 — Execute
 * Role: 执行员
 *
 * Approved packages are atomically claimed and dispatched to the unattended
 * worker. The worker, not this stage, is the source of truth for a submitted
 * application: it records a confirmation or routes the job back for review.
 */
import { db } from "@/lib/db";
import { queueAutonomousApplication } from "@/lib/auto-apply";
import type {
  PipelineCtx, ApplicationPackage, ExecuteOutput, StageResult, AcceptResult,
} from "../types";
import { stageOk } from "../types";

export async function runExecute(
  approved: ApplicationPackage[],
  ctx: PipelineCtx,
): Promise<StageResult<ExecuteOutput>> {
  const startedAt = Date.now();
  const queued: string[] = [];
  const failed: string[] = [];

  if (approved.length === 0) {
    ctx.emit("agent_observation", {
      role: "executor",
      observation: "No approved jobs require unattended submission. Jobs requiring review remain in the review queue.",
    });
    return stageOk("execute", { queued, failed }, 0, Date.now() - startedAt);
  }

  for (const pkg of approved) {
    ctx.emit("agent_action", {
      role: "executor",
      action: `Queueing unattended application: ${pkg.job.company} · ${pkg.job.role} (${pkg.score}%)`,
    });

    try {
      const { taskId } = await queueAutonomousApplication({
        userId: ctx.userId,
        jobId: pkg.job.id,
        applyUrl: pkg.job.url,
      });
      queued.push(pkg.job.id);

      ctx.emit("application_queued", {
        jobId: pkg.job.id,
        taskId,
        company: pkg.job.company,
        role: pkg.job.role,
        score: pkg.score,
        url: pkg.job.url,
        location: pkg.job.location,
        matchedKeywords: pkg.matchedKeywords,
      });
      ctx.emit("agent_observation", {
        role: "executor",
        observation: `✓ ${pkg.job.company} · ${pkg.job.role} is queued for unattended submission. The worker will report the confirmed outcome.`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not queue unattended submission.";
      console.error("[execute] queue error:", error);
      failed.push(pkg.job.id);
      await recordQueueFailure(ctx.userId, pkg.job.id, pkg.job.company, pkg.job.role, message);
      ctx.emit("agent_observation", {
        role: "executor",
        observation: `✗ ${pkg.job.company} · ${pkg.job.role}: ${message}`,
      });
    }
  }

  return stageOk("execute", { queued, failed }, queued.length, Date.now() - startedAt);
}

async function recordQueueFailure(
  userId: string,
  jobId: string,
  company: string,
  role: string,
  message: string,
): Promise<void> {
  await db.activity.create({
    data: {
      userId,
      jobId,
      type: "agent_action",
      text: `Agent could not queue ${company} · ${role}: ${message}`,
      color: "#DC2626",
    },
  }).catch(() => undefined);
}

export function acceptExecute(result: StageResult<ExecuteOutput>): AcceptResult {
  if (!result.ok || !result.data) {
    return { ok: false, reason: result.error ?? "Execute returned no data" };
  }
  return { ok: true };
}
