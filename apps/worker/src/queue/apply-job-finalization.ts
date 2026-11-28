import { unlinkSync } from "node:fs";
import { markExactStartedObjectiveSubmissionUncertain } from "../db/objective-submission-uncertain.js";
import { getPool, insertApplyResult } from "../db/apply-results.js";
import * as legacyFillOutcomes from "./legacy-apply-outcomes.js";
import { finishApplicationTask, USER_TAKEOVER_CHECKPOINT } from "../db/application-task-state.js";
import { updateJobForSubmission, UNCONFIRMED_SUBMISSION_MESSAGE } from "../db/submission-guard.js";
import { recordSubmissionExecutionSettled, type ApplicationSubmitIdentity } from "./application-submit-fence.js";
import { createApplyResultNotification } from "./apply-job-outcomes.js";
import type { ApplyJobLifecycle, ApplyJobRunContext, SubmissionUncertainTaskWrite } from "./apply-job-runner.js";

export const APPLY_TIMEOUT_MS = Number(process.env.APPLY_TIMEOUT_MS ?? "300000");
export const TURN_STOPPED_MESSAGE = "Agent turn was stopped before the application submission request started."
export const SUBMISSION_START_OBSERVATION_TIMEOUT_MS = 8_000;
export const BEST_EFFORT_PAGE_CLOSE_TIMEOUT_MS = 1_000;

export function createApplyJobFinalization(context: ApplyJobRunContext): ApplyJobLifecycle {
  const { state } = context;
  const closeActivePage = async (): Promise<void> => {
    if (!state.activePageCloseRef.current) return;
    let closeTimeout: ReturnType<typeof setTimeout> | null = null;
    try {
      await Promise.race([
        Promise.resolve().then(() => state.activePageCloseRef.current?.()).then(() => undefined).catch(() => undefined),
        new Promise<void>((resolve) => { closeTimeout = setTimeout(resolve, BEST_EFFORT_PAGE_CLOSE_TIMEOUT_MS); }),
      ]);
    } finally {
      if (closeTimeout) clearTimeout(closeTimeout);
    }
  };
  const closeActiveSubmissionContext = (): Promise<void> => {
    if (!state.activeSubmissionContextClosePromise) {
      if (!state.activeSubmissionContextClose) {
        console.error("[apply-worker] Cannot confirm submission browser context closure because no active context is available.");
        state.activeSubmissionContextClosePromise = new Promise<void>(() => undefined);
      } else {
        try {
          const closeWork = state.objectiveMode
            ? state.activeSubmissionContextClose()
            : Promise.resolve().then(() => state.activeSubmissionContextClose?.());
          state.activeSubmissionContextClosePromise = Promise.resolve(closeWork)
            .then(() => { state.submissionContextCloseConfirmed = true; })
            .catch((error: unknown) => {
              console.error("[apply-worker] Could not confirm submission browser context closure:", error instanceof Error ? error.message : String(error));
              return new Promise<void>(() => undefined);
            });
        } catch (error: unknown) {
          console.error("[apply-worker] Could not start submission browser context closure:", error instanceof Error ? error.message : String(error));
          state.activeSubmissionContextClosePromise = new Promise<void>(() => undefined);
        }
      }
    }
    return state.activeSubmissionContextClosePromise;
  };
  const interruptStoppedTurn = async (): Promise<void> => {
    state.turnStopped = true;
    if (!state.stopController.signal.aborted) state.stopController.abort(new Error(TURN_STOPPED_MESSAGE));
    await closeActivePage();
  };
  const releaseSubmissionFence = (commit: boolean): Promise<void> => {
    if (state.submissionFenceRelease) return state.submissionFenceRelease;
    const fence = state.pendingSubmissionFence;
    if (!fence) return Promise.resolve();
    state.pendingSubmissionFence = null;
    if (state.submissionFenceTimer) clearTimeout(state.submissionFenceTimer);
    state.submissionFenceTimer = null;
    state.submissionFenceOwner = fence;
    state.submissionFenceRelease = fence.release(commit).finally(() => {
      if (state.submissionFenceOwner === fence) state.submissionFenceOwner = null;
    });
    return state.submissionFenceRelease;
  };
  const markSubmissionUncertain = (message: string): Promise<SubmissionUncertainTaskWrite> => {
    if (state.applicationTaskFinalized) return Promise.resolve("written");
    if (state.submissionSuperseded) return Promise.resolve("superseded");
    if (state.submissionUncertainWrite) return state.submissionUncertainWrite;
    if (!context.payload.applicationTaskId || !context.submissionIdentity) return Promise.resolve("failed");
    if (state.objectiveMode && state.submissionExecutionStartAttempted && !state.approvedTurnScope) return Promise.resolve("failed");
    const writeRequest = state.objectiveMode && state.submissionExecutionStartAttempted && state.approvedTurnScope
      ? markExactStartedObjectiveSubmissionUncertain(getPool(), state.approvedTurnScope, message)
      : finishApplicationTask(getPool(), context.payload.applicationTaskId, "waiting_for_user", "submission_uncertain",
          message, "submit", context.submissionIdentity);
    const write = writeRequest.then((result): SubmissionUncertainTaskWrite => {
      if (result === "superseded") { state.submissionSuperseded = true; return "superseded"; }
      if (result === "unverified") return "failed";
      state.applicationTaskFinalized = true;
      return "written";
    }).catch((error: unknown): SubmissionUncertainTaskWrite => {
      console.warn("[apply-worker] Could not persist uncertain task state:", error instanceof Error ? error.message : String(error));
      return "failed";
    }).finally(() => { state.submissionUncertainWrite = null; });
    state.submissionUncertainWrite = write;
    return write;
  };
  return { closeActivePage, closeActiveSubmissionContext, interruptStoppedTurn, releaseSubmissionFence, markSubmissionUncertain };
}

export async function persistStoppedSubmission(input: {
  identity: ApplicationSubmitIdentity;
  jobTitle: string | null;
  jobCompany: string;
  startedAt: number;
}): Promise<boolean> {
  const { identity } = input;
  const resultId = await insertApplyResult({
    userId: identity.userId, jobId: identity.jobId, status: "failed",
    mode: "unattended", atsType: null, flowUsed: "application.submit",
    error: TURN_STOPPED_MESSAGE, durationMs: Date.now() - input.startedAt,
    submissionIdentity: identity,
  });
  if (resultId === null) return false;
  const jobWrite = await updateJobForSubmission(getPool(), identity, {
    status: "saved", workflowState: "ready_to_apply", expectedWorkflowStates: ["queued", "submitting"],
  }, "persist_stopped_submission");
  if (jobWrite.kind === "superseded") return false;
  const taskWrite = await finishApplicationTask(
    getPool(), identity.applicationTaskId, "failed", "turn_stopped_before_submit", TURN_STOPPED_MESSAGE, "submit", identity,
  );
  if (taskWrite === "superseded") return false;
  createApplyResultNotification({
    userId: identity.userId, jobId: identity.jobId, jobTitle: input.jobTitle,
    jobCompany: input.jobCompany, status: "failed",
  }).catch((error: Error) => console.warn("[notify] in-app notification failed:", error.message));
  return true;
}
export async function handleApplyJobFailure(context: ApplyJobRunContext, error: unknown): Promise<boolean> {
  const { payload, submissionIdentity, taskContext, startedAt, validSubmitPayload } = context;
  const { applicationTaskId, operation, userId, jobId } = payload;
  const { state } = context;
  state.queueCatchStarted = true;
  state.objectiveSubmissionRouteLifecycle?.cancel();
  if (!state.stopController.signal.aborted) state.stopController.abort(new Error(error instanceof Error ? error.message : String(error)));
  const durationMs = Date.now() - startedAt;
  const message = error instanceof Error ? error.message : String(error);
  const stoppedBeforeRequest = state.turnStopped && !state.submissionRequestStarted;
  const mayHaveOpenedBrowser = state.submissionClaimed || state.submissionRequestStarted;
  const safeMessage = mayHaveOpenedBrowser ? UNCONFIRMED_SUBMISSION_MESSAGE + " Original error: " + message : message;
  if (operation === "submit" && validSubmitPayload && submissionIdentity && !state.submissionClaimed) {
    console.warn("[apply-worker] Submit claim is not confirmed; retrying the queue task without state writes for job=" + jobId);
    return true;
  }
  if (state.submissionRequestStarted) void context.lifecycle?.closeActiveSubmissionContext();
  if (operation === "fill") {
    if (!applicationTaskId || stoppedBeforeRequest) return false;
    const outcome = await legacyFillOutcomes.persistLegacyFillErrorOutcome({
      pool: getPool(), scope: { applicationTaskId, userId, jobId }, error: safeMessage, durationMs,
      task: { jobTitle: taskContext?.jobTitle ?? null, jobCompany: taskContext?.jobCompany ?? "Application" },
      shouldInsertResult: !state.resultWritten && !state.resultWriteStarted,
      browserAttemptStarted: state.browserAttemptStarted, applicationTaskFinalized: state.applicationTaskFinalized,
      notifyInApp: createApplyResultNotification,
    });
    if (!outcome) return false;
    state.resultWritten = state.resultWritten || outcome.insertedResult;
    state.applicationTaskFinalized = state.applicationTaskFinalized || outcome.taskFinalized;
    return false;
  }
  if (mayHaveOpenedBrowser && applicationTaskId && !state.applicationTaskFinalized) {
    const uncertainty = await context.lifecycle?.markSubmissionUncertain(safeMessage);
    if (uncertainty === "superseded") return false;
    if (state.objectiveMode && state.submissionExecutionStartAttempted && uncertainty !== "written") return false;
    if (state.activeSubmissionContextClose && state.objectiveMode) await waitForObjectiveCleanup(context.lifecycle!.closeActiveSubmissionContext());
    else if (state.activeSubmissionContextClose) await context.lifecycle?.closeActiveSubmissionContext();
    else await context.lifecycle?.closeActivePage();
  }
  if (state.submissionSuperseded) return false;
  console.error("[apply-worker] Failed for user=" + userId + ", job=" + jobId + ": " + message);
  if (operation === "submit" && !validSubmitPayload) return false;

  if (stoppedBeforeRequest && !state.submissionClaimed && !state.resultWritten) {
    const stoppedPersisted = await persistStoppedSubmission({
      identity: submissionIdentity!, jobTitle: taskContext?.jobTitle ?? null,
      jobCompany: taskContext?.jobCompany ?? "Application", startedAt,
    });
    if (!stoppedPersisted) { state.submissionSuperseded = true; return false; }
    state.resultWritten = true;
  } else {
    const status = mayHaveOpenedBrowser || state.browserAttemptStarted ? "manual" : "failed";
    if (!state.resultWritten && !state.resultWriteStarted && !state.objectiveResultCorrelationRequired) {
      state.resultWriteStarted = true;
      try {
        const resultId = await insertApplyResult({
          userId, jobId, status, mode: "unattended", atsType: null, flowUsed: null,
          error: safeMessage, durationMs, submissionIdentity: submissionIdentity!,
        });
        if (resultId === null) { state.submissionSuperseded = true; return false; }
        state.resultWritten = true;
      } finally {
        state.resultWriteStarted = false;
      }
      createApplyResultNotification({
        userId, jobId, jobTitle: taskContext?.jobTitle ?? null,
        jobCompany: taskContext?.jobCompany ?? "Application", status,
      }).catch((notifyError: Error) => console.warn("[notify] in-app notification failed:", notifyError.message));
    }
    if (!state.submissionClaimed && !stoppedBeforeRequest) {
      const jobWrite = await updateJobForSubmission(getPool(), submissionIdentity!, { status: "saved", workflowState: "ready_to_apply" }, "release_failed_submit_job");
      if (jobWrite.kind === "superseded") { state.submissionSuperseded = true; return false; }
    }
  }
  if (applicationTaskId && (!stoppedBeforeRequest || state.submissionClaimed) && !state.applicationTaskFinalized
    && !(state.objectiveMode && state.submissionExecutionStartAttempted)) {
    const taskWrite = await finishApplicationTask(
      getPool(), applicationTaskId,
      mayHaveOpenedBrowser || state.browserAttemptStarted ? "waiting_for_user" : "failed",
      mayHaveOpenedBrowser ? "submission_uncertain" : state.browserAttemptStarted ? USER_TAKEOVER_CHECKPOINT : "worker_failed",
      safeMessage, operation === "submit" ? "submit" : "fill", submissionIdentity ?? undefined,
    ).catch((stateError: Error) => console.warn("[apply-worker] Could not persist task failure:", stateError.message));
    if (taskWrite === "superseded") { state.submissionSuperseded = true; return false; }
    state.applicationTaskFinalized = true;
  }
  return false;
}

export async function finalizeApplyJob(context: ApplyJobRunContext): Promise<void> {
  const { state, taskContext, submissionIdentity } = context;
  state.stopProbe?.stop();
  if (state.objectiveMode) { await finalizeObjectiveApplyJob(context); return; }
  if (state.submissionRequestStarted && (state.queueCatchStarted || state.submissionSuperseded || state.activeSubmissionContextClosePromise)) {
    await context.lifecycle?.closeActiveSubmissionContext();
  } else if (state.submissionCandidateSeen || state.submissionRequestStarted) {
    const closePage = state.activePageCloseRef.current;
    if (state.submissionExecutionStartAttempted && closePage) {
      await closePage();
      state.submissionPageCloseConfirmed = true;
    } else {
      await context.lifecycle?.closeActivePage().catch(() => undefined);
    }
  }
  const activeRouteWork = state.submissionRouteState.work;
  if (activeRouteWork) {
    const observedRouteWork = activeRouteWork.catch((routeError: unknown) => {
      console.warn("[apply-worker] Submission route failed:", routeError instanceof Error ? routeError.message : String(routeError));
    });
    await observedRouteWork;
  }
  if ((state.submissionCandidateSeen || state.submissionRequestStarted) && state.activeBrowserExecution) {
    await state.activeBrowserExecution.catch((browserError: unknown) => {
      console.warn("[apply-worker] Browser submit execution failed after timeout:", browserError instanceof Error ? browserError.message : String(browserError));
    });
  }
  const removeRoute = state.submissionRouteState.cleanup;
  if (removeRoute) {
    const routeCleanup = removeRoute().catch((cleanupError: unknown) =>
      console.warn("[apply-worker] Could not remove exact submission request route:", cleanupError instanceof Error ? cleanupError.message : String(cleanupError))
    );
    await routeCleanup;
  }
  if (state.armedSubmissionIntent && !state.submissionCandidateSeen && !state.submissionRequestStarted) {
    await context.lifecycle?.closeActivePage();
  }
  if (state.pendingSubmissionFence && !state.submissionRequestStarted) await context.lifecycle?.closeActivePage();
  await context.lifecycle?.releaseSubmissionFence(state.submissionRequestStarted).catch((releaseError: unknown) =>
    console.warn("[apply-worker] Could not clean up submission start fence:", releaseError instanceof Error ? releaseError.message : String(releaseError))
  );
  if (state.submissionExecutionStartAttempted && state.approvedTurnScope) {
    if (!state.submissionContextCloseConfirmed && !state.submissionPageCloseConfirmed) {
      const closePage = state.activePageCloseRef.current;
      if (!closePage) throw new Error("Cannot confirm submission page closure for Worker execution evidence.");
      await closePage();
      state.submissionPageCloseConfirmed = true;
    }
    await recordSubmissionExecutionSettled(getPool(), state.approvedTurnScope);
  }
  if (state.submissionFenceTimer) clearTimeout(state.submissionFenceTimer);
  state.activePageCloseRef.current = null;
  if (taskContext?.resumeTempPath) {
    try { unlinkSync(taskContext.resumeTempPath); } catch { /* ENOENT or already gone — ignore */ }
  }
}

/** The Objective route may still be settling after a browser timeout. Never wait forever on cleanup. */
async function finalizeObjectiveApplyJob(context: ApplyJobRunContext): Promise<void> {
  const { state, taskContext } = context;
  const lifecycle = context.lifecycle!;
  const route = state.objectiveSubmissionRouteLifecycle;
  route?.cancel();
  const routeSettled = await route?.settle() ?? true;
  state.objectiveSubmissionObservation.current?.dispose();
  const routeMayHaveStarted = !routeSettled && state.submissionExecutionStartAttempted;
  if (routeMayHaveStarted) {
    state.submissionRequestStarted = true;
    state.submissionFenceUnavailable = true;
  }
  if (state.submissionRequestStarted && (state.queueCatchStarted || state.submissionSuperseded || state.activeSubmissionContextClosePromise || routeMayHaveStarted)) {
    await waitForObjectiveCleanup(lifecycle.closeActiveSubmissionContext());
  } else if (state.submissionCandidateSeen || state.submissionRequestStarted) {
    const closePage = state.activePageCloseRef.current;
    if (state.submissionExecutionStartAttempted && closePage) state.submissionPageCloseConfirmed = await waitForObjectiveCleanup(closePage());
    else await lifecycle.closeActivePage();
  }
  if (state.submissionRouteState.work) await waitForObjectiveCleanup(state.submissionRouteState.work);
  if ((state.submissionCandidateSeen || state.submissionRequestStarted) && state.activeBrowserExecution) {
    await waitForObjectiveCleanup(state.activeBrowserExecution);
  }
  if (state.browserExecutionFinished && state.objectiveRunnerReportedSuccess && state.objectiveResultLinkCommitted
    && state.submissionRequestForwarded && !state.submissionContextCloseConfirmed) {
    await waitForObjectiveCleanup(lifecycle.closeActiveSubmissionContext());
  }
  if (state.submissionRouteState.cleanup && state.submissionContextCloseConfirmed) {
    await waitForObjectiveCleanup(state.submissionRouteState.cleanup());
  }
  if ((state.armedSubmissionIntent && !state.submissionCandidateSeen && !state.submissionRequestStarted)
    || (state.pendingSubmissionFence && !state.submissionRequestStarted)) await lifecycle.closeActivePage();
  const releaseWork = lifecycle.releaseSubmissionFence(state.submissionRequestStarted);
  const fenceReleaseConfirmed = await waitForObjectiveCleanup(releaseWork);
  if (!fenceReleaseConfirmed) {
    state.submissionFenceUnavailable = true;
    void lifecycle.closeActiveSubmissionContext();
    if (state.submissionFenceOwner && !state.submissionFenceAbortAttempted) {
      state.submissionFenceAbortAttempted = true;
      state.submissionFenceOwner.abort?.();
    }
  }
  if (routeMayHaveStarted || !fenceReleaseConfirmed) {
    await waitForObjectiveCleanup(lifecycle.markSubmissionUncertain(UNCONFIRMED_SUBMISSION_MESSAGE));
  }
  if (state.submissionExecutionStartAttempted && state.approvedTurnScope) {
    const safelyFinished = fenceReleaseConfirmed && (state.submissionContextCloseConfirmed || (routeSettled && state.browserExecutionFinished
      && state.objectiveRunnerReportedSuccess && state.objectiveResultLinkCommitted && state.submissionRequestForwarded));
    if (safelyFinished) await recordSubmissionExecutionSettled(getPool(), state.approvedTurnScope);
    else console.warn("[apply-worker] Objective browser closure is unconfirmed; submission remains uncertain.");
  }
  if (state.submissionFenceTimer) clearTimeout(state.submissionFenceTimer);
  state.activePageCloseRef.current = null;
  if (taskContext?.resumeTempPath) {
    try { unlinkSync(taskContext.resumeTempPath); } catch { /* Already removed. */ }
  }
}

async function waitForObjectiveCleanup(work: Promise<unknown>): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work.then(() => true, () => false),
      new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), BEST_EFFORT_PAGE_CLOSE_TIMEOUT_MS); timer.unref?.(); }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}
