import { checkBudget, incrementBudget } from "../db/budget.js";
import { CAPTCHA_USER_TAKEOVER_MESSAGE, CHALLENGE_DETECTION_FAILED_MESSAGE } from "../db/application-task-state.js";
import { getPool } from "../db/apply-results.js";
import { UNCONFIRMED_SUBMISSION_MESSAGE } from "../db/submission-guard.js";
import { findFormPattern, recordPatternFailure, upsertFormPattern } from "../db/form-patterns.js";
import { AgentHarness, type ApplyTask, type HarnessResult } from "../harness/agent-harness.js";
import { runGreenhouseFlow } from "../flows/greenhouse-flow.js";
import { runWorkdayFlow } from "../flows/workday-flow.js";
import { runLeverFlow } from "../flows/lever-flow.js";
import { runPersonioFlow } from "../flows/personio-flow.js";
import { runSmartRecruitersFlow } from "../flows/smartrecruiters-flow.js";
import type { SubmissionRequestIntent } from "../flows/submission-intent.js";
import { createPgApplicationSubmitTool, ObjectiveSubmissionUncertainError, type ApplicationSubmitOutput } from "../runtime/tools/application-submit-tool.js";
import { createBrowserApplicationSubmitProvider } from "../runtime/tools/browser-submit-provider.js";
import { linkAbortSignals } from "../runtime/interrupt/bridge.js";
import { shouldUsePattern } from "../patterns/confidence.js";
import { replayPattern } from "../patterns/replay.js";
import type { Page } from "playwright-core";
import type { ApplyJobRunContext } from "./apply-job-runner.js";
import { APPLY_TIMEOUT_MS } from "./apply-job-finalization.js";
import { objectiveApplicationSubmitTargetSupported, runObjectiveGreenhouseApplicationSubmit } from "./objective-application-submit-material.js";
import { createObjectiveGreenhouseSubmissionObservation } from "../flows/objective-greenhouse-submission-observation.js";
import { isAllowedAtsDestination } from "./apply-browser-session.js";

export async function runApplySubmitStrategy(
  context: ApplyJobRunContext,
  page: Page,
  runBrowserFlow: (typedSubmitGuard?: (intent?: SubmissionRequestIntent) => Promise<boolean>) => Promise<HarnessResult>,
  objective?: { applyTask: ApplyTask; challengeAllowsAction(): Promise<boolean> },
): Promise<HarnessResult> {
  const { payload, submissionIdentity } = context;
  const { userId, jobId, receiptId, constraintHash, applicationTaskId } = payload;
  const approvedTurnScope = context.state.approvedTurnScope;
  if (payload.operation !== "submit" || !submissionIdentity) return runBrowserFlow();
  if (!approvedTurnScope) throw new Error("Approved application submission is missing its durable Turn scope.");
  const submit = createBrowserApplicationSubmitProvider({
    run: async (beforeSubmit) => {
      const result = await runBrowserFlow(beforeSubmit);
      const activeRouteWork = context.state.submissionRouteState.work;
      if (activeRouteWork) await activeRouteWork;
      return context.state.submissionAcknowledgementUncertain
        ? { ...result, status: "manual", error: UNCONFIRMED_SUBMISSION_MESSAGE }
        : result;
    },
    ...(context.state.objectiveMode ? {
      supportsObjectiveTarget: (url: unknown) => url === context.taskContext!.applyUrl
        && context.state.flow === "greenhouse" && objectiveApplicationSubmitTargetSupported(url),
      runObjective: async ({ material, beforeSubmit }) => {
        const state = context.state;
        const targetUrl = context.taskContext!.applyUrl;
        if (!objective || material.approvedApplyUrl !== targetUrl || !objectiveApplicationSubmitTargetSupported(targetUrl)) {
          return { status: "submission_blocked" as const, error: "Approved Objective target changed.", durationMs: 0 };
        }
        state.browserAttemptStarted = true;
        await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
        if (!isAllowedAtsDestination(page.url(), "greenhouse", targetUrl)) {
          return { status: "submission_blocked" as const, error: "Approved Objective target redirected outside Greenhouse.", durationMs: 0 };
        }
        if (!await objective.challengeAllowsAction()) return { status: "manual" as const,
          error: state.challengeBoundary === "detection_error" ? CHALLENGE_DETECTION_FAILED_MESSAGE : CAPTCHA_USER_TAKEOVER_MESSAGE, durationMs: 0 };
        const task: ApplyTask = { ...objective.applyTask, applyUrl: targetUrl, resumePath: "", allowSubmit: true,
          confirmedAnswers: material.confirmedAnswers,
          beforeSubmit: async intent => await beforeSubmit(intent) && (objective.applyTask.beforeSubmit ? await objective.applyTask.beforeSubmit(intent) : true) };
        const observation = createObjectiveGreenhouseSubmissionObservation(page, () => state.objectiveSubmissionRouteLifecycle?.signal ?? null);
        state.objectiveSubmissionObservation.current = observation;
        const cancelAndJoin = async (): Promise<void> => {
          state.armedSubmissionIntent = null;
          if (state.submissionFenceTimer) clearTimeout(state.submissionFenceTimer);
          state.submissionFenceTimer = null;
          state.objectiveSubmissionRouteLifecycle?.cancel();
          await state.objectiveSubmissionRouteLifecycle?.settle();
          if (state.submissionRequestStarted) void context.lifecycle!.closeActiveSubmissionContext();
          void context.lifecycle!.closeActivePage();
        };
        let result: HarnessResult;
        try { result = await runObjectiveGreenhouseApplicationSubmit({ userId, task, material, page, observation }); }
        catch (error: unknown) { await cancelAndJoin(); if (state.submissionRequestStarted) throw new ObjectiveSubmissionUncertainError(); throw error; }
        if (result.status !== "submitted") {
          await cancelAndJoin();
          if (state.submissionRequestStarted) throw new ObjectiveSubmissionUncertainError();
          return result;
        }
        const routeSettled = await state.objectiveSubmissionRouteLifecycle?.settle() ?? true;
        if (!routeSettled || !state.submissionRequestForwarded || state.submissionFenceUnavailable || state.submissionAcknowledgementUncertain) {
          await cancelAndJoin();
          if (state.submissionRequestStarted) throw new ObjectiveSubmissionUncertainError();
          return { status: "manual" as const, error: "The approved request was not forwarded through the verified boundary.", durationMs: result.durationMs };
        }
        return result;
      },
    } : {}),
    confirmationId: "application:" + applicationTaskId,
    postSubmitUrl: () => page.url(),
  });
  const tool = createPgApplicationSubmitTool({ pool: getPool(), submit, identity: submissionIdentity });
  const linkedSignal = linkAbortSignals([AbortSignal.timeout(APPLY_TIMEOUT_MS), context.state.stopController.signal]);
  let toolResult: ApplicationSubmitOutput;
  try {
    toolResult = await tool.execute(
      {
        scope: { userId },
        sessionId: approvedTurnScope.sessionId,
        turnId: approvedTurnScope.turnId,
        stepId: "application.submit",
        toolCallId: "application-submit:" + applicationTaskId,
        taskId: applicationTaskId,
        signal: linkedSignal.signal,
        capabilities: ["submission", "write", "external_write", "coordination"],
        reportProgress: async () => undefined,
      },
      { applicationTargetId: jobId, receiptId: receiptId!, constraintHash: constraintHash! },
    ) as ApplicationSubmitOutput;
  } finally {
    linkedSignal.dispose();
  }
  if (context.state.queueCatchStarted) return {
    status: "failed", turns: 0, durationMs: Date.now() - context.startedAt,
    error: "Apply execution was interrupted.", log: [],
  };
  context.state.usedFlow = "application.submit";
  if (context.state.objectiveMode && toolResult.status === "submitted") {
    context.state.objectiveRunnerReportedSuccess = true;
    context.state.objectiveRunnerConfirmationId = toolResult.confirmationId;
  }
  return toolResult.status === "submitted" || toolResult.status === "replayed"
    ? { status: "submitted", turns: toolResult.status === "replayed" ? 0 : 1, durationMs: Date.now() - context.startedAt, error: null, log: [] }
    : {
        status: toolResult.errorCode === "browser_412"
          ? "submission_blocked"
          : toolResult.errorCode === "browser_manual"
            ? "manual"
            : "failed",
        turns: 0,
        durationMs: Date.now() - context.startedAt,
        error: toolResult.errorCode ?? "submission_failed",
        log: [],
      };
}
export async function runApplyBrowserStrategy(
  context: ApplyJobRunContext,
  page: Page,
  applyTask: ApplyTask,
  challengeAllowsAction: () => Promise<boolean>,
  typedSubmitGuard?: (intent?: SubmissionRequestIntent) => Promise<boolean>,
): Promise<HarnessResult> {
  const { userId, dryRun } = context.payload;
  const taskContext = context.taskContext!;
  const { flow } = context.state;
  const browserTask: ApplyTask = typedSubmitGuard
    ? {
        ...applyTask,
        beforeSubmit: async (intent?: SubmissionRequestIntent) => {
          if (!await typedSubmitGuard(intent)) return false;
          return applyTask.beforeSubmit ? applyTask.beforeSubmit(intent) : true;
        },
      }
    : applyTask;
  let result: HarnessResult | null = null;
  context.state.usedFlow = flow ? "programmatic" : null;

  if (!await challengeAllowsAction()) {
    console.log("[apply-worker] Challenge boundary reached; requesting user takeover.");
    result = {
      status: "manual",
      turns: 0,
      error: context.state.challengeBoundary === "detection_error"
        ? CHALLENGE_DETECTION_FAILED_MESSAGE
        : CAPTCHA_USER_TAKEOVER_MESSAGE,
      durationMs: 0,
      log: [],
    };
    context.state.usedFlow = null;
  }

  if (result) {
    // The challenge branch already decided the outcome.
  } else if (flow === "greenhouse") {
    console.log("[apply-worker] Using Greenhouse pre-programmed flow");
    result = await runGreenhouseFlow(page, browserTask);
  } else if (flow === "lever") {
    console.log("[apply-worker] Using Lever pre-programmed flow");
    result = await runLeverFlow(page, browserTask);
  } else if (flow === "workday") {
    console.log("[apply-worker] Using Workday pre-programmed flow");
    result = await runWorkdayFlow(page, browserTask);
  } else if (flow === "personio") {
    console.log("[apply-worker] Using Personio pre-programmed flow");
    result = await runPersonioFlow(page, browserTask);
  } else if (flow === "smartrecruiters") {
    console.log("[apply-worker] Using SmartRecruiters pre-programmed flow");
    result = await runSmartRecruitersFlow(page, browserTask);
  } else {
    const budget = await checkBudget(userId);
    if (!budget.allowed) {
      console.log("[apply-worker] AI budget exceeded: " + budget.used + "/" + budget.limit);
      result = {
        status: "manual",
        turns: 0,
        error: "AI fallback budget exceeded (" + budget.used + "/" + budget.limit + " this month)",
        durationMs: 0,
        log: [],
      };
    } else {
      let host = "unknown";
      try { host = new URL(taskContext.applyUrl).hostname; } catch { /* invalid URL: cache miss */ }
      const pathParts = taskContext.applyUrl.replace(/^https?:\/\/[^/]+\//, "").split("/");
      const urlPattern = pathParts.slice(0, 2).join("/") + "/";
      const pattern = await findFormPattern(userId, host, urlPattern).catch((error: Error) => {
        console.warn("[apply-worker] Pattern lookup failed:", error.message);
        return null;
      });

      if (context.payload.operation === "submit" && pattern && shouldUsePattern(pattern)) {
        const attempts = pattern.successCount + pattern.failureCount;
        console.log("[apply-worker] Pattern cache hit: " + host + "/" + urlPattern + " (confidence=" + pattern.successCount + "/" + attempts + ")");
        result = await replayPattern(page, pattern, browserTask.persona, browserTask.beforeSubmit);
        if (result.status === "submission_blocked") {
          context.state.usedFlow = "pattern-cache";
        } else if (result.status !== "submitted") {
          await recordPatternFailure(pattern.id).catch((error: Error) =>
            console.warn("[apply-worker] Pattern failure record failed:", error.message)
          );
          console.log("[apply-worker] Pattern replay failed, falling back to AgentHarness");
          context.state.usedFlow = "llm";
          const harness = new AgentHarness({ userId, maxTurns: 30, dryRun: dryRun ?? false, mode: "dom" });
          result = await harness.run(page, browserTask);
          if (result.status === "submitted") {
            await incrementBudget(userId).catch((error: Error) =>
              console.warn("[apply-worker] Budget increment failed:", error.message)
            );
            writeFormPattern(userId, taskContext.applyUrl, result);
          }
        } else {
          context.state.usedFlow = "pattern-cache";
        }
      } else {
        console.log("[apply-worker] AI fallback: budget " + budget.used + "/" + budget.limit);
        context.state.usedFlow = "llm";
        const harness = new AgentHarness({ userId, maxTurns: 30, dryRun: dryRun ?? false, mode: "dom" });
        result = await harness.run(page, browserTask);
        if (result.status === "submitted") {
          await incrementBudget(userId).catch((error: Error) =>
            console.warn("[apply-worker] Budget increment failed:", error.message)
          );
          writeFormPattern(userId, taskContext.applyUrl, result);
        }
      }
    }
  }

  if (!result) throw new Error("Apply completed without a harness result");
  return result;
}

function writeFormPattern(userId: string, applyUrl: string, result: HarnessResult): void {
  if (!result.fieldMappings || Object.keys(result.fieldMappings).length === 0) return;
  let host = "unknown";
  try { host = new URL(applyUrl).hostname; } catch { /* invalid URL: write unknown host */ }
  const pathParts = applyUrl.replace(/^https?:\/\/[^/]+\//, "").split("/");
  const urlPattern = pathParts.slice(0, 2).join("/") + "/";
  upsertFormPattern({
    userId,
    atsHost: host,
    urlPattern,
    fieldMapping: result.fieldMappings,
  }).catch((error: Error) => console.warn("[apply-worker] Pattern write failed:", error.message));
}
