/**
 * Stage 5 — Execute
 *
 * The pipeline cannot submit applications. It only holds review-ready packages
 * for the session action that requires explicit, per-job final authorization.
 */
import type { PipelineCtx, ApplicationPackage, ExecuteOutput, StageResult, AcceptResult } from "../types";
import { stageOk } from "../types";

export async function runExecute(
  approved: ApplicationPackage[],
  ctx: PipelineCtx,
): Promise<StageResult<ExecuteOutput>> {
  const startedAt = Date.now();
  for (const pkg of approved) {
    ctx.emit("agent_action", {
      role: "executor",
      action: `Holding ${pkg.job.company} · ${pkg.job.role} for explicit final authorization`,
    });
  }
  ctx.emit("agent_observation", {
    role: "executor",
    observation: approved.length
      ? `${approved.length} application(s) are held. Review and final submit authorization are required before any browser task can start.`
      : "No application was dispatched. Review-ready jobs remain safely paused.",
  });
  return stageOk("execute", { queued: [], failed: [] }, 0, Date.now() - startedAt);
}

export function acceptExecute(result: StageResult<ExecuteOutput>): AcceptResult {
  if (!result.ok || !result.data) return { ok: false, reason: result.error ?? "Execute returned no data" };
  return { ok: true };
}
