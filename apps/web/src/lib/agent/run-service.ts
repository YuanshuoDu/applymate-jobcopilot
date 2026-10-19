import { db } from "@/lib/db";
import { PipelineInterruptedError, runPipeline } from "@/lib/agent/pipeline";
import { runAnalyze } from "@/lib/agent/stages/analyze";
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
import type { Job } from "@prisma/client";
import { parseScheduledAutomationSnapshot } from "@/lib/agent/scheduled-automation-snapshot";
import { buildScheduledTaskGraphPrepareCheckpoint, scheduledTaskGraphContinuationKey, type ScheduledTaskGraphPipelineOwner } from "@/lib/agent/scheduled-taskgraph-pipeline-checkpoint";
import { finishScheduledTaskGraphExecution, isScheduledTaskGraphOwnerCurrent, persistScheduledTaskGraphWaitMarker, saveScheduledTaskGraphCheckpoint, scheduledTaskGraphClaimMatches } from "@/lib/agent/scheduled-taskgraph-pipeline-fence";
import type { PipelineCtx } from "@/lib/agent/pipeline-context";
type HistoryEvent = { event: string; at: string; data: unknown };
export type ScheduledTaskGraphWaitResult = { status: "waiting_for_user"; waitId: string; stage: string };
export interface AgentPipelineRunInput {
  userId: string;
  aiConfig: AiConfig;
  sessionId?: string;
  executionId?: string;
  turnId?: string;
  legacyTurnId?: string;
  questionId?: string;
  workerTaskId?: string;
  expectedAttemptCount?: number;
  signal?: AbortSignal;
  autonomous: boolean;
  source?: V2TurnSource;
  emit?: (event: string, data: unknown) => void;
  scheduledTaskGraph?: { owner: ScheduledTaskGraphPipelineOwner; snapshot: unknown; attestation: unknown; continuationKey: string; claimToken: string; ownedJobs: readonly Job[] };
}
export async function runAgentPipeline(input: AgentPipelineRunInput): Promise<RunReport | ScheduledTaskGraphWaitResult | null> {
  const startedAt = Date.now(), events: HistoryEvent[] = [];
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
  const scheduled = input.scheduledTaskGraph;
  let scheduledState: unknown = execution.state;
  if (input.signal?.aborted) return null
  const attemptCount = scheduled
    ? execution.status === "running" && execution.attemptCount === scheduled.owner.executionAttemptCount
      && scheduledTaskGraphContinuationKey(scheduled.owner, scheduled.attestation) === scheduled.continuationKey
      && scheduledTaskGraphClaimMatches(execution.state, scheduled.continuationKey, scheduled.owner, scheduled.claimToken)
      ? execution.attemptCount : null
    : await claimAgentExecution({
        id: execution.id, userId: input.userId,
        ...(!input.turnId && input.workerTaskId && input.expectedAttemptCount !== undefined
          ? { sessionId: recorder.sessionId, workerTaskId: input.workerTaskId, expectedAttemptCount: input.expectedAttemptCount }
          : {}),
      })
  if (attemptCount === null) {
    return null
  }
  const { isCurrentAttempt, finishAttempt, canPublishAttemptResult, recorderOwner } = createRunAttemptOwnership({
    id: execution.id, userId: input.userId, sessionId: recorder.sessionId, attemptCount,
    turnId: recorder.getTurnId, signal: input.signal,
  })
  const finishOwnedAttempt = scheduled
    ? (status: "completed" | "failed", error?: string | null) => finishScheduledTaskGraphExecution({ state: scheduledState,
        owner: scheduled.owner, key: scheduled.continuationKey, claimToken: scheduled.claimToken, status, error })
    : finishAttempt
  if (!await isCurrentAttempt()) return null
  try {
    if (!await recorder.activate({
      executionAttempt: { id: execution.id, attemptCount },
      signal: input.signal,
      assertCurrent: isCurrentAttempt,
    })) return null
  } catch (error) {
    if (error instanceof AgentExecutionCancelledError || !await isCurrentAttempt()) return null
    const failed = await finishOwnedAttempt("failed", error instanceof Error ? error.message : "Unable to activate agent session")
    if (failed) console.warn("Failed to activate agent session", error)
    return null
  }
  if (!await isCurrentAttempt()) return null
  let scheduledQuestionPersistenceFailed = false;
  const eventWriter = createDurableEventWriter({
    record: async (event, data) => {
      if (!scheduled || event !== "orchestrator_question") return recorder.record(event, data);
      try {
        const question = data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : null;
        const waitId = typeof question?.id === "string" ? question.id : question?.questionId;
        if (typeof waitId !== "string" || typeof question?.stage !== "string") throw new AgentExecutionCancelledError();
        const waitingState = await persistScheduledTaskGraphWaitMarker({ state: scheduledState,
          owner: scheduled.owner, key: scheduled.continuationKey, claimToken: scheduled.claimToken, waitId, stage: question.stage });
        if (!waitingState) throw new AgentExecutionCancelledError();
        scheduledState = waitingState;
        return await recorder.record(event, data);
      } catch (error) {
        scheduledQuestionPersistenceFailed = true;
        throw error;
      }
    },
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
    const failed = await finishOwnedAttempt("failed", error)
    if (!failed || !await canPublishAttemptResult("failed")) return null
    emit("error", { message })
    await eventWriter.drain()
    if (!await finalize("failed", null)) return null
    await saveHistory(input.userId, events, startedAt, null, true); return null
  }
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
    const scheduledSnapshot = scheduled ? parseScheduledAutomationSnapshot(scheduled.snapshot) : null;
    const overrides = scheduledSnapshot
      ? automationRunOverrides({ automation: scheduledSnapshot })
      : automationRunOverrides(automationEvent?.data);
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
    const pipelineInput: PipelineCtx = {
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
      })) && (!scheduled || await isScheduledTaskGraphOwnerCurrent(scheduled.owner, scheduled.continuationKey, scheduled.claimToken)),
      autonomous: input.autonomous,
      emit,
      signal: input.signal,
      resumeState: checkpointState(execution.state),
      checkpoint: async state => {
        if (!await isActiveAccount(input.userId)) throw new Error("Account is not active")
        const saved = scheduled
          ? await saveScheduledTaskGraphCheckpoint({ expectedState: scheduledState, state, owner: scheduled.owner,
              key: scheduled.continuationKey, claimToken: scheduled.claimToken })
          : await saveExecutionCheckpoint({ id: execution.id, userId: input.userId, attemptCount, state })
        if (!saved) throw new AgentExecutionCancelledError()
        if (scheduled) scheduledState = state;
      },
    };
    let resumeState = checkpointState(execution.state);
    if (scheduled) {
      if (!resumeState || !await isScheduledTaskGraphOwnerCurrent(scheduled.owner, scheduled.continuationKey, scheduled.claimToken)) throw new AgentExecutionCancelledError();
      if (execution.state && typeof execution.state === "object" && !Array.isArray(execution.state)
        && "scheduledTaskGraphContinuation" in execution.state) {
        const prior = buildScheduledTaskGraphPrepareCheckpoint({ owner: scheduled.owner, snapshot: scheduled.snapshot,
          attestation: scheduled.attestation, existingCheckpoint: execution.state });
        if (!prior.alreadyPersisted || prior.continuationKey !== scheduled.continuationKey) throw new AgentExecutionCancelledError();
        resumeState = prior.checkpoint;
        scheduledState = prior.checkpoint;
      } else {
        const analysis = await runAnalyze([...scheduled.ownedJobs], pipelineInput);
        if (!await isScheduledTaskGraphOwnerCurrent(scheduled.owner, scheduled.continuationKey, scheduled.claimToken)) throw new AgentExecutionCancelledError();
        const prepared = buildScheduledTaskGraphPrepareCheckpoint({ owner: scheduled.owner, snapshot: scheduled.snapshot,
          attestation: scheduled.attestation, ownedJobs: scheduled.ownedJobs, analyzeResult: analysis, existingCheckpoint: execution.state });
        if (prepared.alreadyPersisted || prepared.continuationKey !== scheduled.continuationKey) throw new AgentExecutionCancelledError();
        const saved = await saveScheduledTaskGraphCheckpoint({ expectedState: execution.state, state: prepared.checkpoint,
          owner: scheduled.owner, key: scheduled.continuationKey, claimToken: scheduled.claimToken });
        if (!saved) throw new AgentExecutionCancelledError();
        resumeState = prepared.checkpoint;
        scheduledState = prepared.checkpoint;
      }
    }
    const report = await runPipeline({ ...pipelineInput, resumeState });
    const finished = await finishOwnedAttempt("completed")
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
      await eventWriter.drain()
      return null
    }
    if (error instanceof AgentPauseError) {
      await eventWriter.drain()
      if (scheduled && scheduledQuestionPersistenceFailed) return null;
      if (!await isCurrentAttempt()) return null
      if (scheduled && !await isScheduledTaskGraphOwnerCurrent(scheduled.owner, scheduled.continuationKey, scheduled.claimToken)) return null;
      const owner = recorderOwner("running", "waiting_for_user")
      if (!owner) return null
      const saved = await recorder.pause(
        `Waiting for your answer at ${error.stage}.`,
        error.stage as "scout" | "analyst" | "writer" | "reviewer" | "executor" | "auditor",
        owner,
      )
      if (!saved) return null
      if (scheduled) return { status: "waiting_for_user", waitId: error.questionId, stage: error.stage };
      return null
    }
    if (error instanceof PipelineInterruptedError) {
      await eventWriter.drain(); return null
    }
    const message = error instanceof Error ? error.message : "Agent run failed"
    if (!await isCurrentAttempt()) {
      await eventWriter.drain()
      return null
    }
    const failed = await finishOwnedAttempt("failed", message)
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
