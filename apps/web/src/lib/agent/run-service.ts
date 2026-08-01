import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { runPipeline } from "@/lib/agent/pipeline";
import { createRunSessionRecorder } from "@/lib/agent/session/run-recorder";
import { resumeToText, type RunReport } from "@/lib/agent/types";
import { loadRoleConfigs, toRoleConfigMap } from "@/lib/agent/role-config";
import { pipelineAgentConfigFrom } from "@/app/api/agent/run/run-helpers";
import { automationRunOverrides, withAutomationOverrides } from "@/lib/agent/automation-overrides";
import type { AiConfig } from "@/lib/model-router";
import type { ResumeContent } from "@/lib/types";

type HistoryEvent = { event: string; at: string; data: unknown };

export interface AgentPipelineRunInput {
  userId: string;
  aiConfig: AiConfig;
  sessionId?: string;
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

  const agentConfig = await db.agentConfig.findUnique({ where: { userId: input.userId } });
  if (!agentConfig) {
    emit("error", { message: "Agent not configured. Save settings first." });
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
    });
    await finalize("completed", report);
    await saveHistory(input.userId, events, startedAt, report);
    return report;
  } catch (error) {
    emit("error", { message: error instanceof Error ? error.message : "Agent run failed" });
    await finalize("failed", null);
    await saveHistory(input.userId, events, startedAt, null, true);
    return null;
  }
}
