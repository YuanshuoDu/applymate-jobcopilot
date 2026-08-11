import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { runPipeline } from "@/lib/agent/pipeline";
import { AgentPauseError } from "@/lib/agent/orchestrator";
import { createRunSessionRecorder } from "@/lib/agent/session/run-recorder";
import { resumeToText, type RunReport } from "@/lib/agent/types";
import { loadRoleConfigs, toRoleConfigMap } from "@/lib/agent/role-config";
import { pipelineAgentConfigFrom } from "@/app/api/agent/run/run-helpers";
import { automationRunOverrides, withAutomationOverrides } from "@/lib/agent/automation-overrides";
import { AgentExecutionCancelledError, claimAgentExecution, ensureAgentExecution, finishAgentExecution, saveExecutionCheckpoint, type PipelineCheckpointState } from "@/lib/agent/execution-control";
import type { AiConfig } from "@/lib/model-router";
import type { ResumeContent } from "@/lib/types";

type HistoryEvent = { event: string; at: string; data: unknown };

export interface AgentPipelineRunInput {
  userId: string;
  aiConfig: AiConfig;
  sessionId?: string;
  /** Optional durable control-plane row supplied by the background worker. */
  executionId?: string;
  autonomous: boolean;
  emit?: (event: string, data: unknown) => void;
}

function pickNumber(data: unknown, keys: string[]): number | null {
  if (!data || typeof data !== "object") return null;
  const row = data as Record<string, unknown>;
  for (const key of keys) {
    const value = row[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}

function historyStatus(report: RunReport | null, failed = false) {
  if (failed || !report) return "failed";
  return report.failed > 0 ? "partial" : "completed";
}

function checkpointState(value: unknown): PipelineCheckpointState | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const state = value as Partial<PipelineCheckpointState>
  const stages = ["scout", "analyze", "prepare", "gate", "execute", "audit", "completed"]
  return typeof state.nextStage === "string" && stages.includes(state.nextStage)
    ? state as PipelineCheckpointState
    : undefined
}

async function isActiveAccount(userId: string): Promise<boolean> {
  try {
    const user = await db.user.findUnique({
      where: { id: userId },
      select: { accountStatus: true },
    })
    return user?.accountStatus === "active"
  } catch {
    // A background action must never proceed if the current account state is
    // unavailable. The execution is recorded as failed by the caller.
    return false
  }
}

async function saveHistory(
  userId: string,
  events: HistoryEvent[],
  startedAt: number,
  report: RunReport | null,
  failed = false,
) {
  const stageEvents = events.filter(event => event.event === "stage_done");
  const scout = [...events].reverse().find(event => {
    const data = event.data as Record<string, unknown> | null;
    return event.event === "role_done" && data?.role === "scout";
  });

  await db.agentRun.create({
    data: {
      userId,
      status: historyStatus(report, failed),
      durationMs: report?.durationMs ?? Math.max(0, Date.now() - startedAt),
      stagesCompleted: stageEvents.length,
      jobsFound: pickNumber(scout?.data, ["discovered", "count", "jobsFound"]) ?? 0,
      ...(report ? { report: report as unknown as Prisma.InputJsonValue } : {}),
      log: events as unknown as Prisma.InputJsonValue,
    },
  }).catch(error => console.warn("Failed to save agent run history", error));
}

/** Runs one pipeline while persisting the same transcript for SSE and worker callers. */
export async function runAgentPipeline(input: AgentPipelineRunInput): Promise<RunReport | null> {
  const startedAt = Date.now();
  const events: HistoryEvent[] = [];
  const recorder = await createRunSessionRecorder(db, {
    userId: input.userId,
    goal: input.sessionId ? "Agent Pipeline Run" : "Manual Agent Pipeline Run",
    sessionId: input.sessionId,
  });
  const execution = input.executionId
    ? await db.agentExecution.findFirst({ where: { id: input.executionId, userId: input.userId, sessionId: recorder.sessionId } })
    : await ensureAgentExecution({ userId: input.userId, sessionId: recorder.sessionId, autonomous: input.autonomous })
  if (!execution) {
    console.warn("Agent execution was not found for the requested session")
    return null
  }
  const claimed = await claimAgentExecution({ id: execution.id, userId: input.userId })
  if (!claimed) {
    // Duplicate BullMQ delivery, cancellation, or an already-finished session.
    // Never run another copy of the same agent session.
    return null
  }
  const writes: Promise<unknown>[] = [];
  const emit = (event: string, data: unknown) => {
    events.push({ event, data, at: new Date().toISOString() });
    input.emit?.(event, data);
    writes.push(recorder.record(event, data).catch(error => {
      console.warn("Failed to record agent session event", error);
      return null;
    }));
  };
  const finalize = async (status: "completed" | "failed", report: RunReport | null) => {
    await Promise.allSettled(writes);
    await recorder.finalize({ status, report });
  };

  // Web requests check this in requireAuth, but scheduled worker runs carry a
  // durable user ID instead of a browser session. Re-check it after claiming
  // the execution so suspension takes effect before any agent work starts.
  if (!await isActiveAccount(input.userId)) {
    emit("error", { message: "Account is not active." });
    const failed = await finishAgentExecution({ id: execution.id, userId: input.userId, status: "failed", error: "Account is not active" })
    if (!failed) return null
    await finalize("failed", null)
    await saveHistory(input.userId, events, startedAt, null, true)
    return null
  }

  const agentConfig = await db.agentConfig.findUnique({ where: { userId: input.userId } });
  if (!agentConfig) {
    emit("error", { message: "Agent not configured. Save settings first." });
    const failed = await finishAgentExecution({ id: execution.id, userId: input.userId, status: "failed", error: "Agent not configured" })
    if (!failed) return null
    await finalize("failed", null);
    await saveHistory(input.userId, events, startedAt, null, true);
    return null;
  }

  const automationEvent = input.sessionId
    ? await db.agentTranscriptEvent.findFirst({
        where: { sessionId: input.sessionId, type: "automation_started" },
        orderBy: { createdAt: "desc" },
        select: { data: true },
      })
    : null;
  const overrides = automationRunOverrides(automationEvent?.data);
  const effectiveConfig = withAutomationOverrides(pipelineAgentConfigFrom(agentConfig), overrides);
  const resume =
    await db.resume.findFirst({ where: { userId: input.userId, isDefault: true } }) ??
    await db.resume.findFirst({ where: { userId: input.userId }, orderBy: { createdAt: "desc" } });

  if (!resume) {
    emit("error", { message: "No resume found. Create a resume first." });
    const failed = await finishAgentExecution({ id: execution.id, userId: input.userId, status: "failed", error: "No resume found" })
    if (!failed) return null
    await finalize("failed", null);
    await saveHistory(input.userId, events, startedAt, null, true);
    return null;
  }

  const roleConfigs = toRoleConfigMap(await loadRoleConfigs(input.userId));
  try {
    const report = await runPipeline({
      userId: input.userId,
      sessionId: recorder.sessionId,
      agentCfg: effectiveConfig,
      roleConfigs,
      resumeText: resumeToText(resume.content as unknown as ResumeContent).slice(0, 2500),
      resumeContent: resume.content as unknown as ResumeContent,
      defaultResume: {
        id: resume.id, name: resume.name, templateId: resume.templateId ?? null,
        templateOptions: resume.templateOptions, directionId: resume.directionId ?? null,
        basicsDetached: resume.basicsDetached ?? false,
      },
      aiConfig: input.aiConfig,
      // Automation can discover and prepare unattended, but may never bypass
      // the per-application review and submit authorization checkpoints.
      autonomous: input.autonomous,
      emit,
      resumeState: checkpointState(execution.state),
      checkpoint: async state => {
        if (!await isActiveAccount(input.userId)) throw new Error("Account is not active")
        const saved = await saveExecutionCheckpoint({ id: execution.id, userId: input.userId, state })
        if (!saved) throw new AgentExecutionCancelledError()
      },
    });
    // Finish the durable control row before publishing a completed session.
    // If the user cancelled while a stage was running, cancellation wins and
    // must never be overwritten by this runner's stale success result.
    const finished = await finishAgentExecution({ id: execution.id, userId: input.userId, status: "completed" })
    if (!finished) return null
    if (report.pending > 0) {
      await recorder.pause(
        `${report.pending} application package${report.pending === 1 ? " is" : "s are"} ready for your review and final submit authorization.`,
        "reviewer",
      )
    } else {
      await finalize("completed", report);
    }
    await saveHistory(input.userId, events, startedAt, report);
    return report;
  } catch (error) {
    if (error instanceof AgentExecutionCancelledError) {
      // The cancel endpoint already marked the session as aborted. Do not
      // replace that user decision with a late failure/completion update.
      await Promise.allSettled(writes)
      return null
    }
    if (error instanceof AgentPauseError) {
      await Promise.allSettled(writes)
      const paused = await finishAgentExecution({ id: execution.id, userId: input.userId, status: "waiting_for_user", error: null })
      if (paused) {
        await recorder.pause(`Waiting for your answer at ${error.stage}.`, error.stage as "scout" | "analyst" | "writer" | "reviewer" | "executor" | "auditor")
      }
      return null
    }
    emit("error", { message: error instanceof Error ? error.message : "Agent run failed" });
    const failed = await finishAgentExecution({ id: execution.id, userId: input.userId, status: "failed", error: error instanceof Error ? error.message : "Agent run failed" })
    if (!failed) return null
    await finalize("failed", null);
    await saveHistory(input.userId, events, startedAt, null, true);
    return null;
  }
}
