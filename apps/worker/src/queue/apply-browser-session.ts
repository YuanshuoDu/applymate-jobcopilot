import { withCloakContext } from "../cloak/pool.js";
import { getPool } from "../db/apply-results.js";
import { detectCaptcha } from "../cloak/captcha.js";
import { applicationTaskStillActive } from "../db/application-task-state.js";
import { evaluateUnattendedApplyControl } from "./unattended-apply-control.js";
import { isApplicationSubmissionStopped } from "../runtime/interrupt/application-submission-probe.js";
import { isValidSubmissionIntent, type SubmissionRequestIntent } from "../flows/submission-intent.js";
import type { FlowType } from "../flows/index.js";
import type { ApplyTask } from "../harness/agent-harness.js";
import type { Page } from "playwright-core";
import type { ApplyJobRunContext } from "./apply-job-runner.js";
import { SUBMISSION_START_OBSERVATION_TIMEOUT_MS } from "./apply-job-finalization.js";
import { createApplicationSubmissionRouteHandler } from "./application-submission-route-gate.js";
import { createSubmissionRouteObservation } from "./application-submission-route-observation.js";
import { runApplyBrowserStrategy, runApplySubmitStrategy } from "./apply-browser-strategy.js";
import { persistApplyJobOutcome } from "./apply-job-outcomes.js";

export async function runApplyBrowserSession(context: ApplyJobRunContext): Promise<void> {
  const { payload, state } = context;
  const { applicationTaskId, operation, userId, jobId, applyUrl, resumePath, coverLetterPath, dryRun } = payload;
  const taskContext = context.taskContext!;
  await withCloakContext(userId, async (page) => {
    state.activePageCloseRef.current = async () => { await page.close(); };
    const submissionBrowserContext = page.context();
    state.activeSubmissionContextClose = async () => { await submissionBrowserContext.close(); };
    if (state.stopController.signal.aborted || state.turnStopped) {
      await context.lifecycle!.closeActivePage();
      if (state.submissionClaimed) throw new Error("Agent turn was stopped before the application submission request started.");
      return;
    }
    if (!await applicationTaskStillActive(
      getPool(),
      applicationTaskId, userId, jobId, operation === "submit" ? "submit" : "fill", context.submissionIdentity ?? undefined,
    )) {
      if (state.approvedTurnScope && await isApplicationSubmissionStopped(
        getPool(), state.approvedTurnScope,
      )) {
        await context.lifecycle!.interruptStoppedTurn();
        if (state.submissionClaimed) throw new Error("Agent turn was stopped before the application submission request started.");
      }
      return;
    }

    state.browserAttemptStarted = true;
    console.log("[apply-worker] Navigating to " + taskContext.applyUrl + " (user=" + userId + ", job=" + jobId + ", dryRun=" + (dryRun ?? false) + ")");
    await page.goto(taskContext.applyUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    if (!isAllowedAtsDestination(page.url(), state.flow, taskContext.applyUrl)) {
      throw new Error("Application page redirected outside the approved ATS origin.");
    }

    const challengeAllowsAction = async (): Promise<boolean> => {
      try {
        if (await detectCaptcha(page)) {
          state.challengeBoundary = "captcha";
          return false;
        }
        return true;
      } catch (error: unknown) {
        state.challengeBoundary = "detection_error";
        console.warn("[apply-worker] Challenge detection failed; requesting user takeover.", error);
        return false;
      }
    };
    const applyTask: ApplyTask = {
      jobId,
      applyUrl: taskContext.applyUrl,
      persona: { ...taskContext.persona, coverLetter: taskContext.coverLetterText ?? "" },
      jobTitle: taskContext.jobTitle,
      jobCompany: taskContext.jobCompany,
      jobKeywords: taskContext.jobKeywords,
      resumePath: taskContext.resumeTempPath ?? resumePath,
      coverLetterPath,
      dryRun: dryRun ?? false,
      allowSubmit: operation === "submit",
      confirmedAnswers: taskContext.confirmedAnswers,
      ...(operation === "submit" ? {
        beforeSubmit: async (intent?: SubmissionRequestIntent): Promise<boolean> => {
          if (state.queueCatchStarted || state.stopController.signal.aborted || state.turnStopped || state.submissionFenceUnavailable) return false;
          if (!isValidSubmissionIntent(intent)) return false;
          const requestIntent = intent;
          if (!await challengeAllowsAction()) return false;
          if (await context.isQueuePaused()) return false;
          if (!await applicationTaskStillActive(
            getPool(),
            applicationTaskId, userId, jobId, "submit", context.submissionIdentity ?? undefined,
          )) {
            if (state.approvedTurnScope) {
              try {
                if (await isApplicationSubmissionStopped(
                  getPool(), state.approvedTurnScope,
                )) await context.lifecycle!.interruptStoppedTurn();
                else state.submissionTaskInactive = true;
              } catch {
                state.submissionFenceUnavailable = true;
              }
            }
            return false;
          }
          if (!isAllowedAtsDestination(page.url(), state.flow, taskContext.applyUrl)) return false;
          if (!(await evaluateUnattendedApplyControl(
            getPool(), taskContext.applyUrl, userId,
          )).allowed) return false;
          if (state.queueCatchStarted || state.stopController.signal.aborted || state.turnStopped || state.submissionFenceUnavailable) return false;
          if (!state.approvedTurnScope) return true;
          if (state.armedSubmissionIntent || state.submissionCandidateSeen || state.submissionRequestStarted) return false;
          let routeObservation: ReturnType<typeof createSubmissionRouteObservation> | null = null;
          try {
            const serviceWorkerControlsPage = await page.evaluate(() => Boolean(navigator.serviceWorker?.controller));
            if (serviceWorkerControlsPage) {
              state.submissionFenceUnavailable = true;
              return false;
            }
            const submissionContext = page.context();
            const submissionFrame = page.mainFrame();
            const pagesPresentWhenArmed = new Set(submissionContext.pages());
            const routeMatcher = (): boolean => true;
            const routeHandler = createApplicationSubmissionRouteHandler(
              context, page, requestIntent, submissionFrame, pagesPresentWhenArmed,
            );
            routeObservation = createSubmissionRouteObservation(state.stopController.signal);
            state.submissionRouteState.observation = routeObservation;
            await submissionContext.route(routeMatcher, routeHandler);
            state.submissionRouteState.cleanup = async () => {
              routeObservation?.dispose();
              await submissionContext.unroute(routeMatcher, routeHandler);
            };
            state.armedSubmissionIntent = requestIntent;
            state.submissionFenceTimer = setTimeout(() => {
              if (!state.armedSubmissionIntent || state.submissionCandidateSeen || state.submissionRequestStarted) return;
              state.submissionFenceUnavailable = true;
              if (!state.stopController.signal.aborted) {
                state.stopController.abort(new Error("The approved submission request did not start after the final approval gate."));
              }
              void context.lifecycle!.closeActivePage().catch(() => undefined);
              routeObservation?.close();
            }, SUBMISSION_START_OBSERVATION_TIMEOUT_MS);
            state.submissionFenceTimer.unref?.();
            if (state.stopController.signal.aborted || state.turnStopped) {
              state.armedSubmissionIntent = null;
              routeObservation?.close();
              await context.lifecycle!.closeActivePage();
              return false;
            }
            return true;
          } catch (error: unknown) {
            routeObservation?.dispose();
            state.submissionFenceUnavailable = true;
            console.warn("[apply-worker] Could not arm exact submission request gate:", error instanceof Error ? error.message : String(error));
            return false;
          }
        },
      } : {}),
    };
    const runBrowserFlow = (typedSubmitGuard?: (intent?: SubmissionRequestIntent) => Promise<boolean>, reviewedCoverLetter?: string) =>
      runApplyBrowserStrategy(context, page, applyTask, challengeAllowsAction, typedSubmitGuard, reviewedCoverLetter);
    const harnessResult = await runApplySubmitStrategy(context, page, runBrowserFlow);
    if (state.queueCatchStarted || state.submissionSuperseded) return;
    await persistApplyJobOutcome(context, page, harnessResult);
  });
}

export function isAllowedAtsDestination(rawUrl: string, flow: FlowType | null, approvedUrl: string): boolean {
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
