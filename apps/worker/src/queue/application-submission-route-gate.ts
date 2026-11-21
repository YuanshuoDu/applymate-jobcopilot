import type { Frame, Page, Route } from "playwright-core";
import { getPool } from "../db/apply-results.js";
import { createPgApprovalStore } from "../runtime/approval/pg-store.js";
import type { ApplicationSubmissionStartScope } from "../db/application-task-state.js";
import type { ApplicationSubmitIdentity } from "./application-submit-fence.js";
import { finishApplicationTask } from "../db/application-task-state.js";
import { UNCONFIRMED_SUBMISSION_MESSAGE } from "../db/submission-guard.js";
import { acquireApplicationSubmissionStartFence } from "../runtime/interrupt/application-submission-probe.js";
import { matchesSubmissionRequest, type SubmissionRequestIntent } from "../flows/submission-intent.js";
import type { ApplyJobRunContext } from "./apply-job-runner.js";

const ROUTE_CONTINUATION_ACK_TIMEOUT_MS = 8_000;

export async function loadApprovedTurnScope(
  identity: ApplicationSubmitIdentity,
  executionId: string,
  workerTaskId: string,
): Promise<ApplicationSubmissionStartScope> {
  const approval = await createPgApprovalStore(getPool(), { userId: identity.userId }).inspectSubmission(identity.approvalId, identity);
  const payload = approval.payload;
  if (
    approval.id !== identity.approvalId || approval.type !== "submit_application" ||
    approval.scope.action !== "submit_application" || approval.scope.userId !== identity.userId ||
    approval.scope.sessionId !== identity.sessionId || approval.scope.turnId !== identity.fillTurnId ||
    approval.scope.jobId !== identity.jobId || approval.scope.toolCallId !== "application-submit:" + identity.applicationTaskId ||
    !payload || typeof payload !== "object" || Array.isArray(payload) ||
    (payload as Record<string, unknown>).applicationTaskId !== identity.applicationTaskId ||
    (payload as Record<string, unknown>).jobId !== identity.jobId
  ) throw new Error("Approval receipt does not match the queued application task lineage.");
  return {
    ...identity, executionId, workerTaskId, userId: approval.scope.userId,
    sessionId: approval.scope.sessionId, turnId: identity.fillTurnId,
  };
}
export function createApplicationSubmissionRouteHandler(
  context: ApplyJobRunContext,
  page: Page,
  requestIntent: SubmissionRequestIntent,
  submissionFrame: Frame,
  pagesPresentWhenArmed: Set<Page>,
): (route: Route) => Promise<void> {
  return async (route: Route): Promise<void> => {
    const { state, payload } = context;
    const { applicationTaskId } = payload;
    if (state.queueCatchStarted) {
      await route.abort("aborted").catch(() => undefined);
      return;
    }
    const request = route.request();
    const armedIntent = state.armedSubmissionIntent;
    let requestFrame: Frame;
    let requestPage: Page;
    try {
      requestFrame = request.frame();
      requestPage = requestFrame.page();
    } catch {
      await route.abort("aborted").catch(() => undefined);
      return;
    }
    let requestMethod: string;
    let isNavigationRequest: boolean;
    try {
      requestMethod = request.method().toUpperCase();
      isNavigationRequest = request.isNavigationRequest();
    } catch {
      await route.abort("aborted").catch(() => undefined);
      return;
    }
    const isSafeRead = requestMethod === "GET" || requestMethod === "HEAD" || requestMethod === "OPTIONS";
    let requestTargetsArmedAction: boolean;
    try {
      requestTargetsArmedAction = matchesSubmissionRequest(requestIntent, {
        url: () => request.url(),
        method: () => requestIntent.method,
      });
    } catch {
      await route.abort("aborted").catch(() => undefined);
      return;
    }
    // A pre-existing tab is unrelated. Only the source page can start the approved write.
    if (requestPage !== page) {
      if (pagesPresentWhenArmed.has(requestPage)) {
        if (requestTargetsArmedAction) await route.abort("aborted").catch(() => undefined);
        else await route.fallback().catch(() => undefined);
      } else if (state.submissionRequestStarted && requestTargetsArmedAction) {
        await route.abort("aborted").catch(() => undefined);
      } else if (state.submissionRequestStarted && isSafeRead) {
        await route.fallback().catch(() => undefined);
      } else {
        await route.abort("aborted").catch(() => undefined);
      }
      return;
    }
    // An iframe may not change the armed action or navigate while submit is armed.
    if (requestFrame !== submissionFrame) {
      if (requestTargetsArmedAction || !isSafeRead || isNavigationRequest) {
        await route.abort("aborted").catch(() => undefined);
      } else {
        await route.fallback().catch(() => undefined);
      }
      return;
    }
    if (state.submissionRequestStarted) {
      if (requestTargetsArmedAction || !isSafeRead) await route.abort("aborted").catch(() => undefined);
      else await route.fallback().catch(() => undefined);
      return;
    }
    if (!requestTargetsArmedAction) {
      if (isNavigationRequest || !isSafeRead) await route.abort("aborted").catch(() => undefined);
      else await route.fallback().catch(() => undefined);
      return;
    }
    if (!armedIntent || !matchesSubmissionRequest(armedIntent, request)) {
      await route.abort("aborted").catch(() => undefined);
      return;
    }
    if (state.submissionCandidateSeen || state.submissionRequestStarted) {
      await route.abort("aborted").catch(() => undefined);
      return;
    }

    // Hold the exact Session -> Turn -> ApplicationTask fence while the named request is paused.
    state.submissionCandidateSeen = true;
    if (state.submissionFenceTimer) clearTimeout(state.submissionFenceTimer);
    state.submissionFenceTimer = null;
    const work = (async () => {
      let continuationAttempted = false;
      try {
        if (state.queueCatchStarted || state.stopController.signal.aborted || state.turnStopped || state.submissionFenceUnavailable) {
          await route.abort("aborted").catch(() => undefined);
          return;
        }
        state.submissionExecutionStartAttempted = true;
        const fence = await acquireApplicationSubmissionStartFence(getPool(), state.approvedTurnScope!);
        if (fence.state === "uncertain") {
          state.pendingSubmissionFence = fence;
          state.submissionRequestStarted = true;
          state.submissionFenceUnavailable = true;
          await route.abort("failed").catch(() => undefined);
          await context.lifecycle!.releaseSubmissionFence(false).catch((releaseError: unknown) => {
            console.warn("[apply-worker] Could not release ambiguous submission start fence:", releaseError instanceof Error ? releaseError.message : String(releaseError));
          });
          try {
            if (await finishApplicationTask(
              getPool(), applicationTaskId, "waiting_for_user", "submission_uncertain",
              UNCONFIRMED_SUBMISSION_MESSAGE, "submit", context.submissionIdentity!,
            ) === "superseded") state.submissionSuperseded = true;
            state.applicationTaskFinalized = true;
          } catch (stateError: unknown) {
            console.warn("[apply-worker] Could not persist ambiguous submission start state:", stateError instanceof Error ? stateError.message : String(stateError));
          }
          return;
        }
        if (fence.state !== "ready") {
          if (fence.state === "stopped") await context.lifecycle!.interruptStoppedTurn();
          else state.submissionTaskInactive = true;
          await route.abort("aborted").catch(() => undefined);
          return;
        }
        state.pendingSubmissionFence = fence;
        if (state.stopController.signal.aborted || state.turnStopped || state.queueCatchStarted) {
          await route.abort("aborted").catch(() => undefined);
          await context.lifecycle!.releaseSubmissionFence(false);
          return;
        }
        state.submissionRequestStarted = true;
        continuationAttempted = true;
        const continuation = route.continue();
        await waitForRouteContinuationAcknowledgement(continuation, state.stopController.signal);
        await context.lifecycle!.releaseSubmissionFence(true);
      } catch (error: unknown) {
        state.submissionFenceUnavailable = true;
        if (continuationAttempted) {
          state.submissionAcknowledgementUncertain = true;
          void context.lifecycle!.closeActiveSubmissionContext();
        }
        console.warn(
          continuationAttempted
            ? "[apply-worker] Submission continuation outcome is uncertain:"
            : "[apply-worker] Could not establish submission request fence:",
          error instanceof Error ? error.message : String(error),
        );
        if (!continuationAttempted) await route.abort("failed").catch(() => undefined);
        if (state.pendingSubmissionFence) {
          await context.lifecycle!.releaseSubmissionFence(continuationAttempted).catch((releaseError: unknown) => {
            state.submissionFenceUnavailable = true;
            console.warn("[apply-worker] Could not release submission request fence:", releaseError instanceof Error ? releaseError.message : String(releaseError));
          });
        }
        if (continuationAttempted && applicationTaskId && !state.applicationTaskFinalized) {
          if (await context.lifecycle!.markSubmissionUncertain(UNCONFIRMED_SUBMISSION_MESSAGE) === "superseded") {
            state.submissionSuperseded = true;
          }
        }
        if (!continuationAttempted) void context.lifecycle!.closeActivePage().catch(() => undefined);
      } finally {
        if (state.pendingSubmissionFence) {
          await context.lifecycle!.releaseSubmissionFence(continuationAttempted).catch((error: unknown) => {
            state.submissionFenceUnavailable = true;
            console.warn("[apply-worker] Could not finalize submission request fence:", error instanceof Error ? error.message : String(error));
          });
        }
      }
    })();
    state.submissionRouteState.work = work;
    try {
      await work;
    } finally {
      if (state.submissionRouteState.work === work) state.submissionRouteState.work = null;
    }
  };
}

async function waitForRouteContinuationAcknowledgement(continuation: Promise<void>, signal: AbortSignal): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  let onAbort: (() => void) | null = null;
  try {
    await Promise.race([continuation, new Promise<void>((_, reject) => {
      onAbort = () => reject(signal.reason instanceof Error ? signal.reason : new Error("Submission continuation was interrupted."));
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener("abort", onAbort, { once: true });
      timeout = setTimeout(() => reject(new Error("Submission route acknowledgement timed out.")), ROUTE_CONTINUATION_ACK_TIMEOUT_MS);
      timeout.unref?.();
    })]);
    if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Submission continuation was interrupted.");
  } finally {
    if (timeout) clearTimeout(timeout);
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}
