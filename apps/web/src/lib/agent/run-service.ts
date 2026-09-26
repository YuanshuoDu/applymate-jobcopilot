import { db } from "@/lib/db";
import { PipelineInterruptedError, runPipeline } from "@/lib/agent/pipeline";
import { AgentPauseError } from "@/lib/agent/orchestrator";
import { createRunSessionRecorder } from "@/lib/agent/session/run-recorder";
import { isRuntimeAgentHarnessFeatureEnabled } from "@/lib/runtime-feature-flags";
import { resumeToText, type RunReport } from "@/lib/agent/types";
import { loadRoleConfigs, toRoleConfigMap } from "@/lib/agent/role-config";
import { pipelineAgentConfigFrom } from "@/app/api/agent/run/run-helpers";
import { automationRunOverrides, withAutomationOverrides } from "@/lib/agent/automation-overrides";
import { AgentExecutionCancelledError, claimAgentExecution, ensureAgentExecution, saveExecutionCheckpoint } from "@/lib/agent/execution-control";
import { checkpointState, createDurableEventWriter, createRunAttemptOwnership, isActiveAccount, saveHistory } from "@/lib/agent/run-service-helpers";
import type { AiConfig } from "@/lib/model-router";
import type { ResumeContent } from "@/lib/types";
import type { V2TurnSource } from "@/lib/agent/session/v2-turn";
type HistoryEvent = { event: string; at: string; data: unknown };
export interface AgentPipelineRunInput {
  userId: string;
  aiConfig: AiConfig;
  sessionId?: string;
  /** Optional durable control-plane row supplied by the background worker. */
  executionId?: string;
  /** Canonical automation Turn supplied by the TurnEngine queue adapter. */
  turnId?: string;
  legacyTurnId?: string;
  questionId?: string;
  workerTaskId?: string;
  expectedAttemptCount?: number;
  signal?: AbortSignal;
  autonomous: boolean;
  source?: V2TurnSource;
  emit?: (event: string, data: unknown) => void;
}
/** Runs one pipeline while persisting the same transcript for SSE and worker callers. */
export async function runAgentPipeline(input: AgentPipelineRunInput): Promise<RunReport | null> {
  const startedAt = Date.now();
  const events: HistoryEvent[] = [];
  const dualWrite = await isRuntimeAgentHarnessFeatureEnabled(
    "AGENT_PROTOCOL_V2_DUAL_WRITE",
    input.userId,
  ).catch(() => false) || Boolean(input.turnId);
  if (input.signal?.aborted) return null
  const requestedExecution = input.executionId
    ? await db.agentExecution.findFirst({
        where: {
          id: input.executionId,
          userId: input.userId,
          ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        },
      })
    : null
  if (input.executionId && (!requestedExecution || input.signal?.aborted)) {
    if (!requestedExecution && !input.signal?.aborted) console.warn("Agent execution was not found for the requested session")
    return null
  }
  const recorder = await createRunSessionRecorder(db, {
    userId: input.userId,
    goal: input.sessionId || input.executionId ? "Agent Pipeline Run" : "Manual Agent Pipeline Run",
    sessionId: requestedExecution?.sessionId ?? input.sessionId,
    dualWrite,
    source: input.source ?? "system",
    turnId: input.turnId ?? input.legacyTurnId,
    legacyResumeQuestionId: !input.turnId && !input.legacyTurnId && input.questionId && !input.questionId.startsWith("agent-question:") ? input.questionId : undefined,
    manageV2Lifecycle: !input.turnId,
    deferActivation: true,
    ensureTurn: true,
  });
  const execution = requestedExecution ?? await ensureAgentExecution({ userId: input.userId, sessionId: recorder.sessionId, autonomous: input.autonomous })
  if (!execution) {
    console.warn("Agent execution was not found for the requested session")
    return null
  }
  if (input.signal?.aborted) return null
  const attemptCount = await claimAgentExecution({
    id: execution.id, userId: input.userId,
    ...(!input.turnId && input.workerTaskId && input.expectedAttemptCount !== undefined
      ? { sessionId: recorder.sessionId, workerTaskId: input.workerTaskId, expectedAttemptCount: input.expectedAttemptCount }
      : {}),
  })
  if (attemptCount === null) {
    // Duplicate BullMQ delivery, cancellation, or an already-finished session.
    // Never run another copy of the same agent session.
    return null
  }
  const { isCurrentAttempt, finishAttempt, canPublishAttemptResult, recorderOwner } = createRunAttemptOwnership({
    id: execution.id, userId: input.userId, sessionId: recorder.sessionId, attemptCount,
    turnId: recorder.getTurnId, signal: input.signal,
  })
  if (!await isCurrentAttempt()) return null
  try {
    if (!await recorder.activate({
      executionAttempt: { id: execution.id, attemptCount },
      signal: input.signal,
      assertCurrent: isCurrentAttempt,
    })) return null
  } catch (error) {
    if (error instanceof AgentExecutionCancelledError || !await isCurrentAttempt()) return null
    const failed = await finishAttempt("failed", error instanceof Error ? error.message : "Unable to activate agent session")
    if (failed) console.warn("Failed to activate agent session", error)
    return null
  }
  if (!await isCurrentAttempt()) return null
  const eventWriter = createDurableEventWriter({
    record: (event, data) => recorder.record(event, data),
    publish: (event, data) => {
      events.push({ event, data, at: new Date().toISOString() });
      input.emit?.(event, data);
    },
    onError: error => console.warn("Failed to record agent session event", error),
  });
  const emit = (event: string, data: unknown) => eventWriter.emit(event, data);
  const finalize = async (status: "completed" | "failed", report: RunReport | null): Promise<boolean> => {
    await eventWriter.drain();
    const owner = recorderOwner(status);
    return recorder.finalize({ status, report, ...(owner ? { owner } : {}) });
  };
  const failPreflight = async (message: string, error: string) => {
    if (!await isCurrentAttempt()) return null
    const failed = await finishAttempt("failed", error)
    if (!failed || !await canPublishAttemptResult("failed")) return null
    emit("error", { message })
    await eventWriter.drain()
    if (!await finalize("failed", null)) return null
    await saveHistory(input.userId, events, startedAt, null, true)
    return null
  }
  // Web requests check this in requireAuth, but scheduled worker runs carry a
  // durable user ID instead of a browser session. Re-check it after claiming
  // the execution so suspension takes effect before any agent work starts.
  try {
    if (!await isActiveAccount(input.userId)) {
      if (!await isCurrentAttempt()) return null
      return await failPreflight("Account is not active.", "Account is not active")
    }
    if (!await isCurrentAttempt()) return null
    const agentConfig = await db.agentConfig.findUnique({ where: { userId: input.userId } });
    if (!await isCurrentAttempt()) return null
    if (!agentConfig) return await failPreflight("Agent not configured. Save settings first.", "Agent not configured")
    const hasAutomationSession = Boolean(input.sessionId || input.executionId)
    const automationEvent = hasAutomationSession
      ? await db.agentTranscriptEvent.findFirst({
          where: { sessionId: recorder.sessionId, type: "automation_started" },
          orderBy: { createdAt: "desc" },
          select: { data: true },
        })
      : null;
    if (!await isCurrentAttempt()) return null
    const overrides = automationRunOverrides(automationEvent?.data);
    const effectiveConfig = withAutomationOverrides(pipelineAgentConfigFrom(agentConfig), overrides);
    let resume = await db.resume.findFirst({ where: { userId: input.userId, isDefault: true } });
    if (!await isCurrentAttempt()) return null
    if (!resume) {
      resume = await db.resume.findFirst({ where: { userId: input.userId }, orderBy: { createdAt: "desc" } });
      if (!await isCurrentAttempt()) return null
    }
    if (!resume) return await failPreflight("No resume found. Create a resume first.", "No resume found")
    const roleConfigs = toRoleConfigMap(await loadRoleConfigs(input.userId));
    if (!await isCurrentAttempt()) return null
    const report = await runPipeline({
      userId: input.userId,
      sessionId: recorder.sessionId,
      turnId: recorder.getTurnId(),
      questionProjectionMode: input.turnId || input.questionId?.includes(":canonical:") || (!input.questionId && dualWrite) ? "canonical" : "legacy",
      resumeQuestionId: input.questionId,
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
      executionAttempt: { id: execution.id, attemptCount },
      assertExecutionCurrent: async () => Boolean(await db.agentExecution.findFirst({
        where: { id: execution.id, userId: input.userId, status: "running", attemptCount },
        select: { id: true },
      })),
      // Automation can discover and prepare unattended, but may never bypass
      // the per-application review and submit authorization checkpoints.
      autonomous: input.autonomous,
      emit,
      signal: input.signal,
      resumeState: checkpointState(execution.state),
      checkpoint: async state => {
        if (!await isActiveAccount(input.userId)) throw new Error("Account is not active")
        const saved = await saveExecutionCheckpoint({ id: execution.id, userId: input.userId, attemptCount, state })
        if (!saved) throw new AgentExecutionCancelledError()
      },
    });
    // Finish the durable control row before publishing a completed session.
    // If the user cancelled while a stage was running, cancellation wins and
    // must never be overwritten by this runner's stale success result.
    const finished = await finishAttempt("completed")
    if (!finished || !await canPublishAttemptResult("completed")) return null
    if (report.pending > 0) {
      const owner = recorderOwner("completed");
      const paused = await recorder.pause(
        `${report.pending} application package${report.pending === 1 ? " is" : "s are"} ready for your review and final submit authorization.`,
        "reviewer",
        ...(owner ? [owner] : []),
      )
      if (!paused) return null
    } else {
      if (!await finalize("completed", report)) return null
    }
    await saveHistory(input.userId, events, startedAt, report);
    return report;
  } catch (error) {
    if (error instanceof AgentExecutionCancelledError) {
      // The cancel endpoint already marked the session as aborted. Do not
      // replace that user decision with a late failure/completion update.
      await eventWriter.drain()
      return null
    }
    if (error instanceof AgentPauseError) {
      await eventWriter.drain()
      if (!await isCurrentAttempt()) return null
      const owner = recorderOwner("running", "waiting_for_user")
      if (!owner) return null
      const saved = await recorder.pause(
        `Waiting for your answer at ${error.stage}.`,
        error.stage as "scout" | "analyst" | "writer" | "reviewer" | "executor" | "auditor",
        owner,
      )
      if (!saved) return null
      return null
    }
    if (error instanceof PipelineInterruptedError) {
      await eventWriter.drain()
      return null
    }
    const message = error instanceof Error ? error.message : "Agent run failed"
    if (!await isCurrentAttempt()) {
      await eventWriter.drain()
      return null
    }
    const failed = await finishAttempt("failed", message)
    if (!failed || !await canPublishAttemptResult("failed")) {
      await eventWriter.drain()
      return null
    }
    emit("error", { message });
    await eventWriter.drain()
    if (!await finalize("failed", null)) return null
    await saveHistory(input.userId, events, startedAt, null, true);
    return null;
  }
}
