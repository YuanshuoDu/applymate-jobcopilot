import { Queue, Worker } from "bullmq";
import type { Pool } from "pg";
import { matchesApplyTaskSubmitPayload, type ApplyTaskPayload } from "@jobcopilot/shared";
import { checkRateLimit } from "../rate-limit.js";
import { withCloakContext } from "../cloak/pool.js";
import { detectCaptcha } from "../cloak/captcha.js";
import { insertApplyResult, getPool, type InsertApplyResult } from "../db/apply-results.js";
import * as legacyFillOutcomes from "./legacy-apply-outcomes.js";
import {
  claimUnattendedSubmission,
  releaseUncertainSubmission,
  updateJobForSubmission,
  UNCONFIRMED_SUBMISSION_MESSAGE,
} from "../db/submission-guard.js";
import { checkBudget, incrementBudget } from "../db/budget.js";
import { findFormPattern, recordPatternFailure, upsertFormPattern } from "../db/form-patterns.js";
import { loadTaskContext } from "../db/load-task-context.js";
import { AgentHarness } from "../harness/agent-harness.js";
import type { ApplyTask, HarnessResult } from "../harness/agent-harness.js";
import type { FlowType } from "../flows/index.js";
import { runGreenhouseFlow } from "../flows/greenhouse-flow.js";
import { runWorkdayFlow } from '../flows/workday-flow.js'
import { runLeverFlow } from '../flows/lever-flow.js'
import { runPersonioFlow } from '../flows/personio-flow.js'
import { runSmartRecruitersFlow } from '../flows/smartrecruiters-flow.js'
import { isValidSubmissionIntent, matchesSubmissionRequest, type SubmissionRequestIntent } from "../flows/submission-intent.js";
import { createNotification } from "../notifications/create-notification.js";
import { notifyApplyResult } from "../notifications/notify-apply-result.js";
import { purgeTemporaryGeneratedCoverLetters } from "../notifications/purge-cover-letters.js";
import { shouldUsePattern } from "../patterns/confidence.js";
import { replayPattern } from "../patterns/replay.js";
import { unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  applicationTaskStillActive,
  CAPTCHA_USER_TAKEOVER_MESSAGE,
  CHALLENGE_DETECTION_FAILED_MESSAGE,
  claimApplicationTask,
  finishApplicationTask,
  isUserActive,
  needsUserTakeover,
  type ApplicationSubmissionStartScope,
  USER_TAKEOVER_CHECKPOINT,
} from "../db/application-task-state.js";
import { inspectFormReviewNeeds } from "../harness/form-review.js";
import { workerPollingOptions } from "./worker-polling-options.js";
import {
  evaluateUnattendedApplyControl,
  UNATTENDED_APPLY_UNAVAILABLE_MESSAGE,
} from "./unattended-apply-control.js";
import { redisConnection } from "../redis.js";
import { createPgApplicationSubmitTool, type ApplicationSubmitOutput } from "../runtime/tools/application-submit-tool.js";
import { recordSubmissionExecutionSettled, type ApplicationSubmitIdentity } from "./application-submit-fence.js";
import { createBrowserApplicationSubmitProvider } from "../runtime/tools/browser-submit-provider.js";
import { createPgApprovalStore } from "../runtime/approval/pg-store.js";
import { linkAbortSignals } from "../runtime/interrupt/bridge.js";
import {
  acquireApplicationSubmissionStartFence,
  isApplicationSubmissionStopped,
  startApplicationSubmissionStopProbe,
  type ApplicationSubmissionStartFence,
} from "../runtime/interrupt/application-submission-probe.js";

export const connection = redisConnection;

const APPLY_TIMEOUT_MS = Number(process.env.APPLY_TIMEOUT_MS ?? '300000');
const TURN_STOPPED_MESSAGE = "Agent turn was stopped before the application submission request started.";
const SUBMISSION_START_OBSERVATION_TIMEOUT_MS = 8_000;
const BEST_EFFORT_PAGE_CLOSE_TIMEOUT_MS = 1_000;

export const QUEUE_NAME = "apply-tasks";

/** The queue used to enqueue apply tasks */
export const applyQueue = new Queue<ApplyTaskPayload>(QUEUE_NAME, {
  connection,
  skipVersionCheck: true,
});

export const applyWorker = new Worker<ApplyTaskPayload>(
  QUEUE_NAME,
  async (job) => {
    const payload = job.data;
    const workerTaskId = typeof job.id === "string" ? job.id : "";
    const executionId = randomUUID();
    const { applicationTaskId, operation, userId, jobId, applyUrl, personaId, resumePath, coverLetterPath, dryRun, receiptId, constraintHash } = payload;
    const submissionIdentity: ApplicationSubmitIdentity | null = operation === "submit"
      ? {
          applicationTaskId, userId, jobId, sessionId: payload.sessionId, fillTurnId: payload.fillTurnId,
          approvalId: receiptId, constraintHash,
        }
      : null;
    const validSubmitPayload = operation !== "submit" ||
      (workerTaskId.length > 0 && matchesApplyTaskSubmitPayload(payload, payload) && /^[a-f0-9]{64}$/.test(constraintHash));
    let submissionSuperseded = false;

    // Extract domain from applyUrl for per-domain rate limiting
    let domain: string | null = null;
    try {
      const u = new URL(applyUrl);
      domain = u.hostname.replace(/^www\./, "");
    } catch {
      // Invalid URL — skip domain check
    }

    const startedAt = Date.now();
    let resultWritten = false;
    let resultWriteStarted = false;
    let browserAttemptStarted = false;
    let ctx: Awaited<ReturnType<typeof loadTaskContext>> | null = null;
    let approvedTurnScope: ApplicationSubmissionStartScope | null = null;
    let turnStopped = false;
    let submissionRequestStarted = false;
    let submissionExecutionStartAttempted = false;
    let submissionContextCloseConfirmed = false;
    let submissionPageCloseConfirmed = false;
    let submissionFenceUnavailable = false;
    let submissionTaskInactive = false;
    let pendingSubmissionFence: ApplicationSubmissionStartFence | null = null;
    let submissionFenceTimer: ReturnType<typeof setTimeout> | null = null;
    let armedSubmissionIntent: SubmissionRequestIntent | null = null;
    let submissionCandidateSeen = false;
    const submissionRouteState: {
      cleanup: (() => Promise<void>) | null;
      work: Promise<void> | null;
    } = { cleanup: null, work: null };
    let activeBrowserExecution: Promise<void> | null = null;
    let submissionFenceRelease: Promise<void> | null = null;
    const activePageCloseRef: { current: (() => Promise<void>) | null } = { current: null };
    let activeSubmissionContextClose: (() => Promise<void>) | null = null;
    let activeSubmissionContextClosePromise: Promise<void> | null = null;
    let applicationTaskFinalized = false;
    let queueCatchStarted = false;
    const stopController = new AbortController();
    let stopProbe: ReturnType<typeof startApplicationSubmissionStopProbe> | null = null;
    const closeActivePage = async (): Promise<void> => {
      if (!activePageCloseRef.current) return;
      let closeTimeout: ReturnType<typeof setTimeout> | null = null;
      try {
        await Promise.race([
          Promise.resolve().then(() => activePageCloseRef.current?.()).then(() => undefined).catch(() => undefined),
          new Promise<void>((resolve) => {
            closeTimeout = setTimeout(resolve, BEST_EFFORT_PAGE_CLOSE_TIMEOUT_MS);
          }),
        ]);
      } finally {
        if (closeTimeout) clearTimeout(closeTimeout);
      }
    };
    const closeActiveSubmissionContext = (): Promise<void> => {
      if (!activeSubmissionContextClosePromise) {
        if (!activeSubmissionContextClose) {
          console.error("[apply-worker] Cannot confirm submission browser context closure because no active context is available.");
          activeSubmissionContextClosePromise = new Promise<void>(() => undefined);
        } else {
          activeSubmissionContextClosePromise = Promise.resolve()
            .then(() => activeSubmissionContextClose?.())
            .then(() => { submissionContextCloseConfirmed = true; })
            .catch((error: unknown) => {
              console.error("[apply-worker] Could not confirm submission browser context closure:", error instanceof Error ? error.message : String(error));
              return new Promise<void>(() => undefined);
            });
        }
      }
      return activeSubmissionContextClosePromise;
    };
    const interruptStoppedTurn = async (): Promise<void> => {
      turnStopped = true;
      if (!stopController.signal.aborted) stopController.abort(new Error(TURN_STOPPED_MESSAGE));
      await closeActivePage();
    };
    const releaseSubmissionFence = (commit: boolean): Promise<void> => {
      if (submissionFenceRelease) return submissionFenceRelease;
      const fence = pendingSubmissionFence;
      if (!fence) return Promise.resolve();
      pendingSubmissionFence = null;
      if (submissionFenceTimer) clearTimeout(submissionFenceTimer);
      submissionFenceTimer = null;
      submissionFenceRelease = fence.release(commit);
      return submissionFenceRelease;
    };

    try {
      if (!validSubmitPayload) {
        throw new Error("Canonical application submission identity is missing or malformed.");
      }
      if (!(await isUserActive(getPool(), userId))) {
        let startedSubmissionFound = false;
        if (applicationTaskId && operation === "submit" && submissionIdentity) {
          try {
            const taskState = await getPool().query<{ checkpoint: string | null }>(
              `SELECT "checkpoint" FROM application_tasks WHERE "id" = $1 AND "userId" = $2 AND "jobId" = $3`,
              [applicationTaskId, userId, jobId],
            );
            if (taskState.rows[0]?.checkpoint === "submission_request_started") {
              startedSubmissionFound = true;
              if (!await reconcileStartedSubmission({ identity: submissionIdentity, startedAt })) submissionSuperseded = true;
            }
          } catch (error: unknown) {
            console.warn("[apply-worker] Could not reconcile a started submission for an inactive account:", error instanceof Error ? error.message : String(error));
          }
        }
        if (startedSubmissionFound || submissionSuperseded) return;
        if (operation === "fill" && applicationTaskId) {
          await legacyFillOutcomes.persistSuspendedLegacyFillOutcome(getPool(), { applicationTaskId, userId, jobId });
        } else if (operation === "submit" && submissionIdentity) {
          if (await finishApplicationTask(getPool(), applicationTaskId, "failed", "account_suspended", "Account suspended by an administrator.", "submit", submissionIdentity) === "superseded") submissionSuperseded = true;
        }
        console.warn(`[apply-worker] Skipping suspended account for job=${jobId}`);
        return;
      }
      if (!applicationTaskId || !operation) {
        console.warn(`[apply-worker] Skipping stale or revoked application task for job=${jobId}`);
        return;
      }
      if (!await claimApplicationTask(getPool(), applicationTaskId, userId, jobId, operation === "submit" ? "submit" : "fill", submissionIdentity ?? undefined)) {
        if (operation === "submit" && submissionIdentity) {
          try {
            const taskState = await getPool().query<{ status: string; checkpoint: string | null }>(
              `SELECT "status", "checkpoint" FROM application_tasks WHERE "id" = $1 AND "userId" = $2 AND "jobId" = $3`,
              [applicationTaskId, userId, jobId],
            );
            const state = taskState.rows[0];
            if (state?.checkpoint === "submission_request_started") {
              if (!await reconcileStartedSubmission({ identity: submissionIdentity, startedAt })) submissionSuperseded = true;
            } else if (state?.status === "cancelled") {
              const stoppedScope = await loadApprovedTurnScope(getPool(), submissionIdentity, executionId, workerTaskId);
              if (await isApplicationSubmissionStopped(getPool(), stoppedScope)) {
                const persisted = await persistStoppedSubmission({ identity: submissionIdentity, jobTitle: null, jobCompany: "Application", startedAt });
                if (persisted) resultWritten = true;
                else submissionSuperseded = true;
              }
            }
          } catch (error: unknown) {
            console.warn("[apply-worker] Could not reconcile a stopped queued application:", error instanceof Error ? error.message : String(error));
          }
        }
        if (submissionSuperseded) return;
        console.warn(`[apply-worker] Skipping stale or revoked application task for job=${jobId}`);
        return;
      }
      if (submissionSuperseded) return;
      const initialControl = await evaluateUnattendedApplyControl(getPool(), applyUrl, userId);
      if (!initialControl.allowed) {
        const handedOff = await handOffUnavailableUnattendedTask({
          applicationTaskId,
          operation,
          userId,
          jobId,
          submissionIdentity: submissionIdentity ?? undefined,
          flow: initialControl.flow,
          startedAt,
          jobTitle: null,
          jobCompany: "Application",
        });
        if (!handedOff) { submissionSuperseded = true; return; }
        resultWritten = true;
        return;
      }

      const limit = await checkRateLimit(userId, domain);
      if (!limit.allowed) {
        const retryMs = limit.retryAfterMs ?? 60_000;
        console.warn(
          `[apply-worker] Rate-limited: user=${userId} domain=${domain}, retry in ${retryMs}ms`
        );
        throw new Error(`RATE_LIMITED:${retryMs}`);
      }

      // Load real persona + job data from DB
      ctx = await loadTaskContext(getPool(), userId, jobId, applyUrl, applicationTaskId);
      const taskCtx = ctx; // non-null const for use inside async callbacks
      const control = taskCtx.applyUrl === applyUrl
        ? initialControl
        : await evaluateUnattendedApplyControl(getPool(), taskCtx.applyUrl, userId);
      if (!control.allowed) {
        const handedOff = await handOffUnavailableUnattendedTask({
          applicationTaskId,
          operation,
          userId,
          jobId,
          submissionIdentity: submissionIdentity ?? undefined,
          flow: control.flow,
          startedAt,
          jobTitle: taskCtx.jobTitle,
          jobCompany: taskCtx.jobCompany,
        });
        if (!handedOff) { submissionSuperseded = true; return; }
        resultWritten = true;
        return;
      }
      const flow = control.flow;

      if (operation === "submit" && submissionIdentity) {
        approvedTurnScope = await loadApprovedTurnScope(getPool(), submissionIdentity, executionId, workerTaskId);
        if (await isApplicationSubmissionStopped(getPool(), approvedTurnScope)) {
          if (!await persistStoppedSubmission({ identity: submissionIdentity, jobTitle: taskCtx.jobTitle, jobCompany: taskCtx.jobCompany, startedAt })) {
            submissionSuperseded = true;
            return;
          }
          resultWritten = true;
          return;
        }
        stopProbe = startApplicationSubmissionStopProbe({
          pool: getPool(),
          scope: approvedTurnScope,
          closePage: closeActivePage,
          controller: stopController,
          hasSubmissionStarted: () => submissionRequestStarted,
          onStopped: () => { turnStopped = true; },
          onUnavailable: (error) => {
            submissionFenceUnavailable = true;
            console.warn("[apply-worker] Agent turn state probe failed:", error instanceof Error ? error.message : String(error));
          },
        });
      }

      const browserExecution = withCloakContext(userId, async (page) => {
        activePageCloseRef.current = async () => { await page.close(); };
        const submissionBrowserContext = page.context();
        activeSubmissionContextClose = async () => { await submissionBrowserContext.close(); };
        if (stopController.signal.aborted || turnStopped) {
          await closeActivePage();
          return;
        }
        if (!await applicationTaskStillActive(getPool(), applicationTaskId, userId, jobId, operation === "submit" ? "submit" : "fill", submissionIdentity ?? undefined)) {
          if (approvedTurnScope && await isApplicationSubmissionStopped(getPool(), approvedTurnScope)) {
            await interruptStoppedTurn();
            if (!await persistStoppedSubmission({ identity: submissionIdentity!, jobTitle: taskCtx.jobTitle, jobCompany: taskCtx.jobCompany, startedAt })) {
              submissionSuperseded = true;
              return;
            }
            resultWritten = true;
          }
          return;
        }
        if (operation === "submit") {
          const submissionClaim = await claimUnattendedSubmission(getPool(), submissionIdentity!);
          if (submissionClaim === "superseded") { submissionSuperseded = true; return; }
          if (submissionClaim === "unavailable") {
            console.warn(`[apply-worker] Skipping duplicate task for job=${jobId}; it is no longer queued.`);
            return;
          }

          if (submissionClaim === "uncertain") {
            const uncertainResult = await insertApplyResult({
              userId, jobId, status: "manual", mode: "unattended", atsType: null, flowUsed: null,
              error: UNCONFIRMED_SUBMISSION_MESSAGE, durationMs: Date.now() - startedAt, submissionIdentity: submissionIdentity!,
            });
            if (uncertainResult === null) { submissionSuperseded = true; return; }
            resultWritten = true;
            if (await finishApplicationTask(getPool(), applicationTaskId, "waiting_for_user", "submission_uncertain", UNCONFIRMED_SUBMISSION_MESSAGE, "submit", submissionIdentity!) === "superseded") {
              submissionSuperseded = true;
              return;
            }
            createApplyResultNotification({ userId, jobId, jobTitle: taskCtx.jobTitle, jobCompany: taskCtx.jobCompany, status: "manual" })
              .catch((e: Error) => console.warn("[notify] in-app notification failed:", e.message));
            return;
          }
        }

        browserAttemptStarted = true;
        console.log(
          `[apply-worker] Navigating to ${taskCtx.applyUrl} (user=${userId}, job=${jobId}, dryRun=${dryRun ?? false})`
        );

        await page.goto(taskCtx.applyUrl, {
          waitUntil: "domcontentloaded",
          timeout: 30_000,
        });
        if (!isAllowedAtsDestination(page.url(), flow, taskCtx.applyUrl)) {
          throw new Error("Application page redirected outside the approved ATS origin.");
        }

        let challengeBoundary: "captcha" | "detection_error" | null = null;
        const challengeAllowsAction = async (): Promise<boolean> => {
          try {
            if (await detectCaptcha(page)) {
              challengeBoundary = "captcha";
              return false;
            }
            return true;
          } catch (error) {
            challengeBoundary = "detection_error";
            console.warn("[apply-worker] Challenge detection failed; requesting user takeover.", error);
            return false;
          }
        };

        const applyTask: ApplyTask = {
          jobId,
          applyUrl: taskCtx.applyUrl,
          persona: {
            ...taskCtx.persona,
            coverLetter: taskCtx.coverLetterText ?? "",
          },
          jobTitle: taskCtx.jobTitle,
          jobCompany: taskCtx.jobCompany,
          jobKeywords: taskCtx.jobKeywords,
          resumePath: taskCtx.resumeTempPath ?? resumePath,
          coverLetterPath,
          dryRun: dryRun ?? false,
          allowSubmit: operation === "submit",
          confirmedAnswers: taskCtx.confirmedAnswers,
          ...(operation === "submit" ? {
            beforeSubmit: async (intent?: SubmissionRequestIntent) => {
              if (queueCatchStarted || stopController.signal.aborted || turnStopped || submissionFenceUnavailable) return false;
              if (!isValidSubmissionIntent(intent)) return false;
              const requestIntent = intent;
              if (!await challengeAllowsAction()) return false;
              if (await applyQueue.isPaused()) return false;
              if (!await applicationTaskStillActive(
                getPool(), applicationTaskId, userId, jobId,
                operation === "submit" ? "submit" : "fill", submissionIdentity ?? undefined,
              )) {
                if (approvedTurnScope) {
                  try {
                    if (await isApplicationSubmissionStopped(getPool(), approvedTurnScope)) await interruptStoppedTurn();
                    else submissionTaskInactive = true;
                  } catch {
                    submissionFenceUnavailable = true;
                  }
                }
                return false;
              }
              if (!isAllowedAtsDestination(page.url(), flow, taskCtx.applyUrl)) return false;
              if (!(await evaluateUnattendedApplyControl(getPool(), taskCtx.applyUrl, userId)).allowed) return false;
              if (queueCatchStarted || stopController.signal.aborted || turnStopped || submissionFenceUnavailable) return false;
              if (!approvedTurnScope) return true;
              if (armedSubmissionIntent || submissionCandidateSeen || submissionRequestStarted) return false;
              try {
                // Page routing does not see requests handled by a controlling
                // Service Worker. Fail closed before arming the final submit.
                const serviceWorkerControlsPage = await page.evaluate(
                  () => Boolean(navigator.serviceWorker?.controller),
                );
                if (serviceWorkerControlsPage) {
                  submissionFenceUnavailable = true;
                  return false;
                }

                const submissionContext = page.context();
                const submissionFrame = page.mainFrame();
                const pagesPresentWhenArmed = new Set(submissionContext.pages());
                // A context route is required to see a popup's first request.
                // Keep its lifetime bounded to this final-submit window and
                // immediately fall through every known unrelated request.
                const routeMatcher = (): boolean => true;
                const routeHandler = async (route: import("playwright-core").Route): Promise<void> => {
                  if (queueCatchStarted) {
                    await route.abort("aborted").catch(() => undefined);
                    return;
                  }
                  const request = route.request();
                  const armedIntent = armedSubmissionIntent;
                  let requestFrame: import("playwright-core").Frame;
                  let requestPage: import("playwright-core").Page;
                  try {
                    requestFrame = request.frame();
                    requestPage = requestFrame.page();
                  } catch {
                    // While submit is armed, routing provenance must remain
                    // readable so no new target can escape the page snapshot.
                    await route.abort("aborted").catch(() => undefined);
                    return;
                  }
                  let requestMethod: string;
                  let isNavigationRequest: boolean;
                  try {
                    requestMethod = request.method().toUpperCase();
                    // Playwright also reports document requests from subframes as navigations.
                    isNavigationRequest = request.isNavigationRequest();
                  } catch {
                    await route.abort("aborted").catch(() => undefined);
                    return;
                  }
                  const isSafeRead = requestMethod === "GET" || requestMethod === "HEAD" || requestMethod === "OPTIONS";
                  let requestTargetsArmedAction: boolean;
                  try {
                    // Match the exact action URL independently from method so
                    // a method mutation cannot use the safe-read exception.
                    requestTargetsArmedAction = matchesSubmissionRequest(requestIntent, {
                      url: () => request.url(),
                      method: () => requestIntent.method,
                    });
                  } catch {
                    await route.abort("aborted").catch(() => undefined);
                    return;
                  }
                  if (requestPage !== page) {
                    // A tab that existed before the final submit was armed is
                    // unrelated. Abort a new page's first request even when
                    // its URL differs from the form action. Once the approved
                    // write starts, read-only confirmation pages are allowed.
                    if (pagesPresentWhenArmed.has(requestPage)) {
                      if (requestTargetsArmedAction) {
                        // A pre-existing tab is unrelated unless it targets
                        // the exact action URL, which only the source page may
                        // submit regardless of HTTP method.
                        await route.abort("aborted").catch(() => undefined);
                      } else {
                        await route.fallback().catch(() => undefined);
                      }
                    } else if (submissionRequestStarted && requestTargetsArmedAction) {
                      // A new page may show confirmation content, but it may
                      // not issue another request to the approved action URL.
                      await route.abort("aborted").catch(() => undefined);
                    } else if (submissionRequestStarted && isSafeRead) {
                      await route.fallback().catch(() => undefined);
                    } else {
                      await route.abort("aborted").catch(() => undefined);
                    }
                    return;
                  }
                  if (requestFrame !== submissionFrame) {
                    // An iframe may not target the armed action URL, submit to
                    // a changed URL, or navigate the document while final
                    // submission is armed. Safe non-navigation reads may
                    // continue, and iframe traffic never starts the fence.
                    if (requestTargetsArmedAction || !isSafeRead || isNavigationRequest) {
                      await route.abort("aborted").catch(() => undefined);
                    } else {
                      await route.fallback().catch(() => undefined);
                    }
                    return;
                  }
                  if (submissionRequestStarted) {
                    if (requestTargetsArmedAction || !isSafeRead) {
                      await route.abort("aborted").catch(() => undefined);
                    } else {
                      // Once the authorized write has reached the network,
                      // allow read-only confirmation redirects and polling.
                      await route.fallback().catch(() => undefined);
                    }
                    return;
                  }
                  if (!requestTargetsArmedAction) {
                    if (isNavigationRequest || !isSafeRead) {
                      // A rewritten action URL or a write/navigation that
                      // differs from the declared intent is undeclared.
                      await route.abort("aborted").catch(() => undefined);
                    } else {
                      await route.fallback().catch(() => undefined);
                    }
                    return;
                  }
                  if (!armedIntent || !matchesSubmissionRequest(armedIntent, request)) {
                    // Only the source page's exact main-frame URL+method is a
                    // candidate. A method-changed request at this action URL
                    // must never escape via fallback.
                    await route.abort("aborted").catch(() => undefined);
                    return;
                  }
                  if (submissionCandidateSeen || submissionRequestStarted) {
                    await route.abort("aborted").catch(() => undefined);
                    return;
                  }

                  // This is the exact request named by the ATS flow. Keep it
                  // paused while Stop and this request serialize on the same
                  // Session -> Turn -> ApplicationTask row locks.
                  submissionCandidateSeen = true;
                  if (submissionFenceTimer) clearTimeout(submissionFenceTimer);
                  submissionFenceTimer = null;
                  const work = (async () => {
                    let continuationAttempted = false;
                    try {
                      if (queueCatchStarted || stopController.signal.aborted || turnStopped || submissionFenceUnavailable) {
                        await route.abort("aborted").catch(() => undefined);
                        return;
                      }
                      submissionExecutionStartAttempted = true;
                      const fence = await acquireApplicationSubmissionStartFence(getPool(), approvedTurnScope!);
                      if (fence.state === "uncertain") {
                        pendingSubmissionFence = fence;
                        submissionRequestStarted = true;
                        submissionFenceUnavailable = true;
                        await route.abort("failed").catch(() => undefined);
                        await releaseSubmissionFence(false).catch((releaseError: unknown) => {
                          console.warn(
                            "[apply-worker] Could not release ambiguous submission start fence:",
                            releaseError instanceof Error ? releaseError.message : String(releaseError),
                          );
                        });
                        try {
                          if (await finishApplicationTask(
                            getPool(),
                            applicationTaskId,
                            "waiting_for_user",
                            "submission_uncertain",
                            UNCONFIRMED_SUBMISSION_MESSAGE, "submit", submissionIdentity!,
                          ) === "superseded") submissionSuperseded = true;
                          applicationTaskFinalized = true;
                        } catch (stateError: unknown) {
                          console.warn(
                            "[apply-worker] Could not persist ambiguous submission start state:",
                            stateError instanceof Error ? stateError.message : String(stateError),
                          );
                        }
                        return;
                      }
                      if (fence.state !== "ready") {
                        if (fence.state === "stopped") await interruptStoppedTurn();
                        else submissionTaskInactive = true;
                        await route.abort("aborted").catch(() => undefined);
                        return;
                      }
                      pendingSubmissionFence = fence;
                      if (stopController.signal.aborted || turnStopped || queueCatchStarted) {
                        await route.abort("aborted").catch(() => undefined);
                        await releaseSubmissionFence(false);
                        return;
                      }

                      // The route is paused here. Mark uncertainty before
                      // invoking continue because a thrown continuation can
                      // still mean the browser sent the request.
                      submissionRequestStarted = true;
                      continuationAttempted = true;
                      let continuationFailed = false;
                      let continuationFailure: unknown;
                      const continuation = route.continue().then(
                        () => undefined,
                        (error: unknown) => {
                          continuationFailed = true;
                          continuationFailure = error;
                        },
                      );
                      await releaseSubmissionFence(true);
                      await continuation;
                      if (continuationFailed) throw continuationFailure;
                    } catch (error: unknown) {
                      submissionFenceUnavailable = true;
                      console.warn(
                        continuationAttempted
                          ? "[apply-worker] Submission continuation outcome is uncertain:"
                          : "[apply-worker] Could not establish submission request fence:",
                        error instanceof Error ? error.message : String(error),
                      );
                      if (!continuationAttempted) await route.abort("failed").catch(() => undefined);
                      if (pendingSubmissionFence) {
                        await releaseSubmissionFence(continuationAttempted).catch((releaseError: unknown) => {
                          submissionFenceUnavailable = true;
                          console.warn("[apply-worker] Could not release submission request fence:", releaseError instanceof Error ? releaseError.message : String(releaseError));
                        });
                      }
                      if (continuationAttempted && applicationTaskId && !applicationTaskFinalized) {
                        try {
                          if (await finishApplicationTask(
                            getPool(),
                            applicationTaskId,
                            "waiting_for_user",
                            "submission_uncertain",
                            UNCONFIRMED_SUBMISSION_MESSAGE, "submit", submissionIdentity!,
                          ) === "superseded") submissionSuperseded = true;
                          applicationTaskFinalized = true;
                        } catch (stateError: unknown) {
                          console.warn(
                            "[apply-worker] Could not promptly persist uncertain submission state:",
                            stateError instanceof Error ? stateError.message : String(stateError),
                          );
                        }
                      }
                      if (continuationAttempted) {
                        void closeActiveSubmissionContext();
                      } else {
                        void closeActivePage().catch(() => undefined);
                      }
                    } finally {
                      if (pendingSubmissionFence) {
                        await releaseSubmissionFence(continuationAttempted).catch((error: unknown) => {
                          submissionFenceUnavailable = true;
                          console.warn("[apply-worker] Could not finalize submission request fence:", error instanceof Error ? error.message : String(error));
                        });
                      }
                    }
                  })();
                  submissionRouteState.work = work;
                  try {
                    await work;
                  } finally {
                    if (submissionRouteState.work === work) submissionRouteState.work = null;
                  }
                };

                await submissionContext.route(routeMatcher, routeHandler);
                submissionRouteState.cleanup = async () => { await submissionContext.unroute(routeMatcher, routeHandler); };
                armedSubmissionIntent = requestIntent;
                submissionFenceTimer = setTimeout(() => {
                  if (!armedSubmissionIntent || submissionCandidateSeen || submissionRequestStarted) return;
                  submissionFenceUnavailable = true;
                  if (!stopController.signal.aborted) {
                    stopController.abort(new Error("The approved submission request did not start after the final approval gate."));
                  }
                  void closeActivePage();
                }, SUBMISSION_START_OBSERVATION_TIMEOUT_MS);
                submissionFenceTimer.unref?.();
                if (stopController.signal.aborted || turnStopped) {
                  armedSubmissionIntent = null;
                  await closeActivePage();
                  return false;
                }
                return true;
              } catch (error: unknown) {
                submissionFenceUnavailable = true;
                console.warn("[apply-worker] Could not arm exact submission request gate:", error instanceof Error ? error.message : String(error));
                return false;
              }
            },
          } : {}),
        };

        // Keep the existing ATS/pattern/harness execution as one provider so
        // the typed tool owns receipt validation, artifact freshness, and
        // idempotency before this callback can reach an external submit.
        const runBrowserFlow = async (typedSubmitGuard?: (intent?: SubmissionRequestIntent) => Promise<boolean>): Promise<HarnessResult> => {
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
          usedFlow = flow ? "programmatic" : null;

          const hasCaptcha = await challengeAllowsAction() === false;
          if (hasCaptcha) {
            // CAPTCHA, login and MFA are explicit human handoff boundaries.
            // Do not use third-party solvers or attempt to bypass platform controls.
            console.log("[apply-worker] Challenge boundary reached; requesting user takeover.");
            result = {
              status: "manual",
              turns: 0,
              error: challengeBoundary === "detection_error"
                ? CHALLENGE_DETECTION_FAILED_MESSAGE
                : CAPTCHA_USER_TAKEOVER_MESSAGE,
              durationMs: 0,
              log: [],
            };
            usedFlow = null;
          }

          if (result) {
            // CAPTCHA branch already decided the outcome.
          } else if (flow === "greenhouse") {
            console.log(`[apply-worker] Using Greenhouse pre-programmed flow`);
            result = await runGreenhouseFlow(page, browserTask);
          } else if (flow === "lever") {
            console.log(`[apply-worker] Using Lever pre-programmed flow`);
            result = await runLeverFlow(page, browserTask);
          } else if (flow === "workday") {
            console.log(`[apply-worker] Using Workday pre-programmed flow`);
            result = await runWorkdayFlow(page, browserTask);
          } else if (flow === "personio") {
            console.log(`[apply-worker] Using Personio pre-programmed flow`);
            result = await runPersonioFlow(page, browserTask);
          } else if (flow === "smartrecruiters") {
            console.log(`[apply-worker] Using SmartRecruiters pre-programmed flow`);
            result = await runSmartRecruitersFlow(page, browserTask);
          } else {
            // Phase 5: pattern cache -> replay -> AI fallback with budget cap.
            const budget = await checkBudget(userId);
            if (!budget.allowed) {
              console.log(`[apply-worker] AI budget exceeded: ${budget.used}/${budget.limit}`);
              result = {
                status: "manual",
                turns: 0,
                error: `AI fallback budget exceeded (${budget.used}/${budget.limit} this month)`,
                durationMs: 0,
                log: [],
              };
            } else {
              let host = "unknown";
              try { host = new URL(taskCtx.applyUrl).hostname; } catch { /* invalid URL: cache miss */ }
              const pathParts = taskCtx.applyUrl.replace(/^https?:\/\/[^/]+\//, "").split("/");
              const urlPattern = pathParts.slice(0, 2).join("/") + "/";

              const pattern = await findFormPattern(userId, host, urlPattern).catch((e: Error) => {
                console.warn("[apply-worker] Pattern lookup failed:", e.message);
                return null;
              });

              if (operation === "submit" && pattern && shouldUsePattern(pattern)) {
                const attempts = pattern.successCount + pattern.failureCount;
                console.log(
                  `[apply-worker] Pattern cache hit: ${host}/${urlPattern} (confidence=${pattern.successCount}/${attempts})`
                );
                result = await replayPattern(page, pattern, browserTask.persona, browserTask.beforeSubmit);

                if (result.status === "submission_blocked") {
                  usedFlow = "pattern-cache";
                } else if (result.status !== "submitted") {
                  await recordPatternFailure(pattern.id).catch((e: Error) =>
                    console.warn("[apply-worker] Pattern failure record failed:", e.message)
                  );
                  console.log("[apply-worker] Pattern replay failed, falling back to AgentHarness");
                  usedFlow = "llm";
                  const harness = new AgentHarness({
                    userId,
                    maxTurns: 30,
                    dryRun: dryRun ?? false,
                    mode: "dom",
                  });
                  result = await harness.run(page, browserTask);
                  if (result.status === "submitted") {
                    await incrementBudget(userId).catch((e: Error) =>
                      console.warn("[apply-worker] Budget increment failed:", e.message)
                    );
                    writeFormPattern(userId, taskCtx.applyUrl, result);
                  }
                } else {
                  usedFlow = "pattern-cache";
                }
              } else {
                console.log(`[apply-worker] AI fallback: budget ${budget.used}/${budget.limit}`);
                usedFlow = "llm";
                const harness = new AgentHarness({
                  userId,
                  maxTurns: 30,
                  dryRun: dryRun ?? false,
                  mode: "dom",
                });
                result = await harness.run(page, browserTask);
                if (result.status === "submitted") {
                  await incrementBudget(userId).catch((e: Error) =>
                    console.warn("[apply-worker] Budget increment failed:", e.message)
                  );
                  writeFormPattern(userId, taskCtx.applyUrl, result);
                }
              }
            }
          }

          if (!result) throw new Error("Apply completed without a harness result");
          return result;
        };

        let usedFlow: string | null = null;
        let harnessResult: HarnessResult;
        const hasCanonicalReceipt = operation === "submit" && submissionIdentity !== null;
        if (hasCanonicalReceipt) {
          if (!approvedTurnScope) throw new Error("Approved application submission is missing its durable Turn scope.");
          const submit = createBrowserApplicationSubmitProvider({
            run: runBrowserFlow,
            confirmationId: `application:${applicationTaskId}`,
            postSubmitUrl: () => page.url(),
          });
          const tool = createPgApplicationSubmitTool({ pool: getPool(), submit, identity: submissionIdentity! });
          const linkedSignal = linkAbortSignals([AbortSignal.timeout(APPLY_TIMEOUT_MS), stopController.signal]);
          let toolResult: ApplicationSubmitOutput;
          try {
            toolResult = await tool.execute(
              {
                scope: { userId },
                sessionId: approvedTurnScope.sessionId,
                turnId: approvedTurnScope.turnId,
                stepId: "application.submit",
                toolCallId: `application-submit:${applicationTaskId}`,
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
          if (queueCatchStarted) return;
          usedFlow = "application.submit";
          harnessResult = toolResult.status === "submitted" || toolResult.status === "replayed"
            ? { status: "submitted", turns: toolResult.status === "replayed" ? 0 : 1, durationMs: Date.now() - startedAt, error: null, log: [] }
            : {
                status: toolResult.errorCode === "browser_412"
                  ? "submission_blocked"
                  : toolResult.errorCode === "browser_manual"
                    ? "manual"
                    : "failed",
                turns: 0,
                durationMs: Date.now() - startedAt,
                error: toolResult.errorCode ?? "submission_failed",
                log: [],
              };
        } else {
          // Legacy queue payloads remain a fail-safe compatibility path while
          // all Web-created submit jobs now carry the canonical receipt.
          harnessResult = await runBrowserFlow();
        }
        if (queueCatchStarted || submissionSuperseded) return;

        if (turnStopped && !submissionRequestStarted && harnessResult.status !== "submitted") {
          harnessResult = { ...harnessResult, status: "failed", error: TURN_STOPPED_MESSAGE };
          usedFlow = hasCanonicalReceipt ? "application.submit" : usedFlow;
        } else if (submissionRequestStarted && harnessResult.status !== "submitted") {
          harnessResult = { ...harnessResult, status: "manual", error: UNCONFIRMED_SUBMISSION_MESSAGE };
          usedFlow = hasCanonicalReceipt ? "application.submit" : usedFlow;
        } else if (submissionTaskInactive && harnessResult.status === "submission_blocked") {
          harnessResult = { ...harnessResult, status: "failed", error: "The application task was cancelled before the submission request started." };
        } else if (submissionFenceUnavailable && !submissionRequestStarted && harnessResult.status === "submission_blocked") {
          harnessResult = { ...harnessResult, status: "failed", error: "Agent turn state could not be verified, so the application was not submitted." };
        }

        // A challenge can appear after navigation while a flow is filling the
        // form. The submit guard returns a generic blocked result in that case;
        // normalize it to the same human-handoff state as the preflight path.
        if (challengeBoundary && !turnStopped) {
          harnessResult = {
            ...harnessResult,
            status: "manual",
            error: challengeBoundary === "detection_error"
              ? CHALLENGE_DETECTION_FAILED_MESSAGE
              : CAPTCHA_USER_TAKEOVER_MESSAGE,
          };
          usedFlow = null;
        }

        const submissionUncertain = submissionRequestStarted && harnessResult.status !== "submitted";
        if (submissionUncertain) {
          if (await finishApplicationTask(
            getPool(),
            applicationTaskId,
            "waiting_for_user",
            "submission_uncertain",
            harnessResult.error ?? UNCONFIRMED_SUBMISSION_MESSAGE, "submit", submissionIdentity!,
          ) === "superseded") { submissionSuperseded = true; return; }
          applicationTaskFinalized = true;
          await closeActiveSubmissionContext();
        }
        if (queueCatchStarted || submissionSuperseded) return;

        if (operation === "fill") {
          const scope = { applicationTaskId, userId, jobId }; const outcome = await legacyFillOutcomes.persistLegacyFillHarnessOutcome({
            pool: getPool(), scope, harnessResult, flow, usedFlow, startedAt, task: taskCtx,
            inspectNeeds: () => inspectFormReviewNeeds(page), turnStopped, submissionRequestStarted, applicationTaskFinalized,
            needsUserTakeover, notifyInApp: createApplyResultNotification, notifyEmail: notifyApplyResult, purgeCoverLetters: purgeTemporaryGeneratedCoverLetters,
          });
          if (!outcome.persisted) return;
          resultWritten = true; applicationTaskFinalized = outcome.taskFinalized; return;
        }

        const durationMs = Date.now() - startedAt;
        resultWriteStarted = true;
        try {
          const resultId = await insertApplyResult({
            userId,
            jobId,
            status: harnessResult.status as InsertApplyResult["status"],
            mode: "unattended",
            atsType: flow ?? "unknown",
            flowUsed: usedFlow,
            error: harnessResult.error ?? null,
            durationMs,
            submissionIdentity: submissionIdentity!,
          });
          if (resultId === null) { submissionSuperseded = true; return; }
          resultWritten = true;
        } catch (error: unknown) {
          resultWriteStarted = false;
          throw error;
        }
        if (queueCatchStarted || submissionSuperseded) return;

        if (
          harnessResult.status === "submitted" ||
          harnessResult.status === "manual" ||
          harnessResult.status === "failed" ||
          harnessResult.status === "submission_blocked"
        ) {
          createApplyResultNotification({
            userId,
            jobId,
            jobTitle: taskCtx.jobTitle,
            jobCompany: taskCtx.jobCompany,
            status: harnessResult.status,
          }).catch((e: Error) => console.warn("[notify] in-app notification failed:", e.message));
        }

        // Send email notification (non-blocking, non-throwing)
        if (harnessResult.status !== 'dry-run') {
          notifyApplyResult({
            userId,
            jobTitle:   taskCtx.jobTitle,
            jobCompany: taskCtx.jobCompany,
            status:     harnessResult.status,
            error:      harnessResult.error ?? null,
            flowUsed:   usedFlow,
            jobUrl:     taskCtx.applyUrl,
          }).catch((e: Error) => console.warn('[notify] email failed:', e.message))
        }

        // Update Job status based on actual outcome
        const isSubmitted = harnessResult.status === 'submitted';
        const isSubmissionBlocked = harnessResult.status === "submission_blocked";
        const newJobStatus = isSubmitted ? 'applied' : 'saved';
        const newWorkflowState = isSubmitted ? 'submitted' : 'ready_to_apply';

        if (isSubmitted) {
          await purgeTemporaryGeneratedCoverLetters(userId, jobId).catch((error: Error) =>
            console.warn('[apply-worker] Could not apply cover-letter retention policy:', error.message)
          )
        }
        if (queueCatchStarted) return;
        // Keep the durable job-state write last in this block. The retention
        // cleanup is best-effort and must not obscure the submission outcome.
        const jobWrite = await updateJobForSubmission(getPool(), submissionIdentity!, { status: newJobStatus, workflowState: newWorkflowState, applied: isSubmitted }, "finish_apply_job_state");
        if (jobWrite.kind === "superseded") { submissionSuperseded = true; return; }
        if (queueCatchStarted) return;
        const requiresUserTakeover = harnessResult.status === "manual" || needsUserTakeover(harnessResult.error);
        const stoppedTask = turnStopped && !submissionRequestStarted
          ? await getPool().query<{ status: string }>(`SELECT "status" FROM application_tasks WHERE "id" = $1 AND "userId" = $2`, [applicationTaskId, userId])
          : null;
        if ((!applicationTaskFinalized || isSubmitted && submissionRequestStarted) && stoppedTask?.rows[0]?.status !== "cancelled") {
          const taskWrite = await finishApplicationTask(
            getPool(),
            applicationTaskId,
            isSubmitted ? "submitted" : submissionUncertain || requiresUserTakeover ? "waiting_for_user" : isSubmissionBlocked ? "waiting_for_authorization" : "failed",
            isSubmitted ? "submission_verified" : submissionUncertain ? "submission_uncertain" : turnStopped && !submissionRequestStarted ? "turn_stopped_before_submit" : isSubmissionBlocked ? "submission_blocked" : requiresUserTakeover ? USER_TAKEOVER_CHECKPOINT : "execution_failed",
            harnessResult.error ?? null, operation === "submit" ? "submit" : "fill", submissionIdentity ?? undefined,
          );
          if (taskWrite === "superseded") { submissionSuperseded = true; return; }
          applicationTaskFinalized = true;
        }

      });
      activeBrowserExecution = browserExecution;
      await Promise.race([
        browserExecution,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Apply timeout: exceeded 5 minutes')), APPLY_TIMEOUT_MS)
        ),
      ]);
      if (submissionSuperseded) return;
    } catch (err: unknown) {
      queueCatchStarted = true;
      if (!stopController.signal.aborted) stopController.abort(new Error(err instanceof Error ? err.message : String(err)));
      const durationMs = Date.now() - startedAt;
      const message = err instanceof Error ? err.message : String(err);
      const stoppedBeforeRequest = turnStopped && !submissionRequestStarted;
      const safeMessage = submissionRequestStarted
        ? `${UNCONFIRMED_SUBMISSION_MESSAGE} Original error: ${message}`
        : message;
      if (submissionRequestStarted) void closeActiveSubmissionContext();
      if (operation === "fill") {
        if (!applicationTaskId || stoppedBeforeRequest) return;
        const outcome = await legacyFillOutcomes.persistLegacyFillErrorOutcome({
          pool: getPool(), scope: { applicationTaskId, userId, jobId }, error: safeMessage, durationMs,
          task: { jobTitle: ctx?.jobTitle ?? null, jobCompany: ctx?.jobCompany ?? "Application" },
          shouldInsertResult: !resultWritten && !resultWriteStarted, browserAttemptStarted, applicationTaskFinalized, notifyInApp: createApplyResultNotification });
        if (!outcome) return;
        resultWritten = resultWritten || outcome.insertedResult; applicationTaskFinalized = applicationTaskFinalized || outcome.taskFinalized; return;
      }
      if (submissionRequestStarted && applicationTaskId && !applicationTaskFinalized) {
        try {
          const taskWrite = await finishApplicationTask(
            getPool(),
            applicationTaskId,
            "waiting_for_user",
            "submission_uncertain",
            safeMessage, "submit", submissionIdentity!,
          );
          if (taskWrite === "superseded") { submissionSuperseded = true; return; }
          applicationTaskFinalized = true;
        } catch (stateError: unknown) {
          console.warn("[apply-worker] Could not persist uncertain task state:", stateError instanceof Error ? stateError.message : String(stateError));
        }
        await closeActiveSubmissionContext();
      }
      if (submissionSuperseded) return;
      console.error(
        `[apply-worker] Failed for user=${userId}, job=${jobId}: ${message}`
      );
      if (operation === "submit" && !validSubmitPayload) return;

      if (stoppedBeforeRequest && !resultWritten) {
        const stoppedPersisted = await persistStoppedSubmission({
          identity: submissionIdentity!,
          jobTitle: ctx?.jobTitle ?? null,
          jobCompany: ctx?.jobCompany ?? "Application",
          startedAt,
        });
        if (!stoppedPersisted) { submissionSuperseded = true; return; }
        resultWritten = true;
      } else {
        const status = browserAttemptStarted ? "manual" : "failed";
        if (!resultWritten && !resultWriteStarted) {
          resultWriteStarted = true;
          try {
            const resultId = await insertApplyResult({
              userId,
              jobId,
              status,
              mode: "unattended",
              atsType: null,
              flowUsed: null,
              error: safeMessage,
              durationMs,
              submissionIdentity: submissionIdentity!,
            });
            if (resultId === null) { submissionSuperseded = true; return; }
            resultWritten = true;
          } finally {
            resultWriteStarted = false;
          }
          createApplyResultNotification({
            userId,
            jobId,
            jobTitle: ctx?.jobTitle ?? null,
            jobCompany: ctx?.jobCompany ?? "Application",
            status,
          }).catch((e: Error) => console.warn("[notify] in-app notification failed:", e.message));
        }
        if (!stoppedBeforeRequest && browserAttemptStarted) {
          const release = await releaseUncertainSubmission(getPool(), submissionIdentity!);
          if (release.kind === "superseded") { submissionSuperseded = true; return; }
        } else if (!stoppedBeforeRequest) {
          const jobWrite = await updateJobForSubmission(getPool(), submissionIdentity!, { status: "saved", workflowState: "ready_to_apply" }, "release_failed_submit_job");
          if (jobWrite.kind === "superseded") { submissionSuperseded = true; return; }
        }
      }
      if (applicationTaskId && !stoppedBeforeRequest && !applicationTaskFinalized) {
        const taskWrite = await finishApplicationTask(
          getPool(),
          applicationTaskId,
          browserAttemptStarted ? "waiting_for_user" : "failed",
          submissionRequestStarted ? "submission_uncertain" : browserAttemptStarted ? USER_TAKEOVER_CHECKPOINT : "worker_failed",
          safeMessage, operation === "submit" ? "submit" : "fill", submissionIdentity ?? undefined,
        ).catch((stateError: Error) => console.warn("[apply-worker] Could not persist task failure:", stateError.message));
        if (taskWrite === "superseded") { submissionSuperseded = true; return; }
        applicationTaskFinalized = true;
      }
      // Once a browser has started, BullMQ must not replay the task. A form
      // submit may have reached the ATS even when the worker lost its result.
      // Fail-safe review is preferable to an accidental duplicate application.
      return;
    } finally {
      stopProbe?.stop();
      if (submissionRequestStarted && (queueCatchStarted || submissionSuperseded || activeSubmissionContextClosePromise)) {
        await closeActiveSubmissionContext();
      } else if (submissionCandidateSeen || submissionRequestStarted) {
        const closePage = activePageCloseRef.current;
        if (submissionExecutionStartAttempted && closePage) {
          await closePage();
          submissionPageCloseConfirmed = true;
        } else {
          await closeActivePage().catch(() => undefined);
        }
      }
      const activeSubmissionRouteWork = submissionRouteState.work;
      if (activeSubmissionRouteWork) {
        const observedRouteWork = activeSubmissionRouteWork.catch((error: unknown) => {
          console.warn("[apply-worker] Submission route failed:", error instanceof Error ? error.message : String(error));
        });
        await observedRouteWork;
      }
      if ((submissionCandidateSeen || submissionRequestStarted) && activeBrowserExecution) {
        await activeBrowserExecution.catch((error: unknown) => {
          console.warn("[apply-worker] Browser submit execution failed after timeout:", error instanceof Error ? error.message : String(error));
        });
      }
      const removeSubmissionRoute = submissionRouteState.cleanup;
      if (removeSubmissionRoute) {
        const routeCleanup = removeSubmissionRoute().catch((error: unknown) =>
          console.warn("[apply-worker] Could not remove exact submission request route:", error instanceof Error ? error.message : String(error))
        );
        await routeCleanup;
      }
      if (armedSubmissionIntent && !submissionCandidateSeen && !submissionRequestStarted) await closeActivePage();
      if (pendingSubmissionFence && !submissionRequestStarted) await closeActivePage();
      await releaseSubmissionFence(submissionRequestStarted).catch((error: unknown) =>
        console.warn("[apply-worker] Could not clean up submission start fence:", error instanceof Error ? error.message : String(error))
      );
      if (submissionExecutionStartAttempted && approvedTurnScope) {
        if (!submissionContextCloseConfirmed && !submissionPageCloseConfirmed) {
          const closePage = activePageCloseRef.current;
          if (!closePage) throw new Error("Cannot confirm submission page closure for Worker execution evidence.");
          await closePage();
          submissionPageCloseConfirmed = true;
        }
        await recordSubmissionExecutionSettled(getPool(), approvedTurnScope);
      }
      if (submissionFenceTimer) clearTimeout(submissionFenceTimer);
      activePageCloseRef.current = null;
      // Clean up temp resume PDF to avoid accumulating files on disk
      if (ctx?.resumeTempPath) {
        try { unlinkSync(ctx.resumeTempPath!) } catch { /* ENOENT or already gone — ignore */ }
      }
    }
  },
  {
    connection,
    skipVersionCheck: true,
    ...workerPollingOptions(),
    concurrency: Number(process.env.CLOAK_MAX_WORKERS ?? "1"),
  }
);

async function loadApprovedTurnScope(
  pool: Pool,
  identity: ApplicationSubmitIdentity,
  executionId: string,
  workerTaskId: string,
): Promise<ApplicationSubmissionStartScope> {
  const approval = await createPgApprovalStore(pool, { userId: identity.userId }).inspectSubmission(identity.approvalId, identity);
  const payload = approval.payload;
  if (
    approval.id !== identity.approvalId ||
    approval.type !== "submit_application" ||
    approval.scope.action !== "submit_application" ||
    approval.scope.userId !== identity.userId ||
    approval.scope.sessionId !== identity.sessionId ||
    approval.scope.turnId !== identity.fillTurnId ||
    approval.scope.jobId !== identity.jobId ||
    approval.scope.toolCallId !== `application-submit:${identity.applicationTaskId}` ||
    !payload || typeof payload !== "object" || Array.isArray(payload) ||
    (payload as Record<string, unknown>).applicationTaskId !== identity.applicationTaskId ||
    (payload as Record<string, unknown>).jobId !== identity.jobId
  ) {
    throw new Error("Approval receipt does not match the queued application task lineage.");
  }
  return {
    ...identity,
    executionId,
    workerTaskId,
    userId: approval.scope.userId,
    sessionId: approval.scope.sessionId,
    turnId: identity.fillTurnId,
  };
}

async function reconcileStartedSubmission(input: {
  identity: ApplicationSubmitIdentity;
  startedAt: number;
}): Promise<boolean> {
  const { identity } = input;
  const submissionClaim = await claimUnattendedSubmission(getPool(), identity);
  if (submissionClaim === "superseded") return false;
  if (submissionClaim === "unavailable") return true;
  if (submissionClaim === "claimed") {
    const released = await releaseUncertainSubmission(getPool(), identity);
    if (released.kind === "superseded") return false;
  }
  if (await finishApplicationTask(
    getPool(),
    identity.applicationTaskId,
    "waiting_for_user",
    "submission_uncertain",
    UNCONFIRMED_SUBMISSION_MESSAGE, "submit", identity,
  ) === "superseded") return false;
  if (submissionClaim === "uncertain" || submissionClaim === "claimed") {
    const resultId = await insertApplyResult({
      userId: identity.userId,
      jobId: identity.jobId,
      status: "manual",
      mode: "unattended",
      atsType: null,
      flowUsed: "application.submit",
      error: UNCONFIRMED_SUBMISSION_MESSAGE,
      durationMs: Date.now() - input.startedAt,
      submissionIdentity: identity,
    });
    if (resultId === null) return false;
    createApplyResultNotification({ userId: identity.userId, jobId: identity.jobId, jobTitle: null, jobCompany: "Application", status: "manual" })
      .catch((error: Error) => console.warn("[notify] in-app notification failed:", error.message));
  }
  return true;
}

async function persistStoppedSubmission(input: {
  identity: ApplicationSubmitIdentity;
  jobTitle: string | null;
  jobCompany: string;
  startedAt: number;
}): Promise<boolean> {
  const { identity } = input;
  const resultId = await insertApplyResult({
    userId: identity.userId,
    jobId: identity.jobId,
    status: "failed",
    mode: "unattended",
    atsType: null,
    flowUsed: "application.submit",
    error: TURN_STOPPED_MESSAGE,
    durationMs: Date.now() - input.startedAt,
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
  createApplyResultNotification({ userId: identity.userId, jobId: identity.jobId, jobTitle: input.jobTitle, jobCompany: input.jobCompany, status: "failed" })
    .catch((error: Error) => console.warn("[notify] in-app notification failed:", error.message));
  return true;
}

async function createApplyResultNotification(params: {
  userId: string;
  jobId: string;
  jobTitle: string | null;
  jobCompany: string;
  status: "submitted" | "manual" | "failed" | "submission_blocked";
}): Promise<void> {
  await createNotification(params.userId, {
    type: notificationTypeForStatus(params.status),
    title: notificationTitle(params.jobCompany, params.status),
    body: params.jobTitle,
    jobId: params.jobId,
  });
}

async function handOffUnavailableUnattendedTask(params: {
  applicationTaskId: string;
  operation: ApplyTaskPayload["operation"];
  userId: string;
  jobId: string;
  submissionIdentity?: ApplicationSubmitIdentity;
  flow: FlowType;
  startedAt: number;
  jobTitle: string | null;
  jobCompany: string;
}): Promise<boolean> {
  if (params.operation === "fill") {
    await legacyFillOutcomes.persistUnavailableLegacyFillOutcome({
      pool: getPool(),
      scope: { applicationTaskId: params.applicationTaskId, userId: params.userId, jobId: params.jobId },
      task: { jobTitle: params.jobTitle, jobCompany: params.jobCompany },
      flow: params.flow,
      startedAt: params.startedAt,
      message: UNATTENDED_APPLY_UNAVAILABLE_MESSAGE,
      notifyInApp: createApplyResultNotification,
    });
    return true;
  }
  const identity = params.submissionIdentity;
  if (!identity) throw new Error("Unavailable submit handoff requires an exact application attempt identity.");
  const resultId = await insertApplyResult({
    userId: params.userId,
    jobId: params.jobId,
    status: "manual",
    mode: "unattended",
    atsType: params.flow,
    flowUsed: null,
    error: UNATTENDED_APPLY_UNAVAILABLE_MESSAGE,
    durationMs: Date.now() - params.startedAt,
    submissionIdentity: identity,
  });
  if (resultId === null) return false;
  const jobWrite = await updateJobForSubmission(getPool(), identity, { status: "saved", workflowState: "ready_to_apply" }, "handoff_unavailable_submit");
  if (jobWrite.kind === "superseded") return false;
  if (await finishApplicationTask(
    getPool(),
    params.applicationTaskId,
    params.operation === "submit" ? "waiting_for_authorization" : "waiting_for_user",
    params.operation === "submit" ? "form_filled" : "materials_ready",
    UNATTENDED_APPLY_UNAVAILABLE_MESSAGE, params.operation, identity,
  ) === "superseded") return false;
  createApplyResultNotification({
    userId: params.userId,
    jobId: params.jobId,
    jobTitle: params.jobTitle,
    jobCompany: params.jobCompany,
    status: "manual",
  }).catch((error: Error) => console.warn("[notify] in-app notification failed:", error.message));
  return true;
}

function writeFormPattern(userId: string, applyUrl: string, harnessResult: HarnessResult): void {
  if (!harnessResult.fieldMappings || Object.keys(harnessResult.fieldMappings).length === 0) {
    return;
  }

  let host = "unknown";
  try { host = new URL(applyUrl).hostname; } catch { /* invalid URL: write unknown host */ }
  const pathParts = applyUrl.replace(/^https?:\/\/[^/]+\//, "").split("/");
  const urlPattern = pathParts.slice(0, 2).join("/") + "/";

  upsertFormPattern({
    userId,
    atsHost: host,
    urlPattern,
    fieldMapping: harnessResult.fieldMappings,
  }).catch((e: Error) => console.warn("[apply-worker] Pattern write failed:", e.message));
}

function isAllowedAtsDestination(rawUrl: string, flow: FlowType | null, approvedUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "https:") return false;
    const host = url.hostname.toLowerCase();
    if (flow === "greenhouse") return host === "boards.greenhouse.io" || host.endsWith(".greenhouse.io");
    if (flow === "lever") return host === "jobs.lever.co" || host === "jobs.eu.lever.co" || host === "app.lever.co";
    if (flow === "workday") return host.endsWith(".myworkdayjobs.com");
    if (flow === "smartrecruiters") return host === "jobs.smartrecruiters.com" || host === "careers.smartrecruiters.com";
    if (flow === "personio") return host.endsWith(".jobs.personio.com");
    if (flow !== null) return false;
    return url.origin === new URL(approvedUrl).origin;
  } catch {
    return false;
  }
}

function notificationTypeForStatus(
  status: "submitted" | "manual" | "failed" | "submission_blocked"
): "apply_submitted" | "apply_manual" | "apply_failed" | "apply_blocked" {
  return status === "submitted"
    ? "apply_submitted"
    : status === "submission_blocked"
      ? "apply_blocked"
    : status === "manual"
      ? "apply_manual"
      : "apply_failed";
}

function notificationTitle(company: string, status: "submitted" | "manual" | "failed" | "submission_blocked"): string {
  return status === "submitted"
    ? `${company} ✅`
    : status === "submission_blocked"
      ? `${company} submission blocked`
    : status === "manual"
      ? `${company} ⚠️`
      : `${company} ❌`;
}


