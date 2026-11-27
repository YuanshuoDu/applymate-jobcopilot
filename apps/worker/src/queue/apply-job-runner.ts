import { randomUUID } from "node:crypto";
import { matchesApplyTaskSubmitPayload, type ApplyTaskPayload } from "@jobcopilot/shared";
import type { Job } from "bullmq";
import { getPool } from "../db/apply-results.js";
import * as legacyFillOutcomes from "./legacy-apply-outcomes.js";
import { loadTaskContext, type TaskContext } from "../db/load-task-context.js";
import {
  claimApplicationTask,
  finishApplicationTask,
  isUserActive,
  type ApplicationSubmissionStartScope,
} from "../db/application-task-state.js";
import { checkRateLimit } from "../rate-limit.js";
import { evaluateUnattendedApplyControl } from "./unattended-apply-control.js";
import { claimUnattendedSubmission } from "../db/submission-guard.js";
import {
  isApplicationSubmissionStopped,
  startApplicationSubmissionStopProbe,
  type ApplicationSubmissionStartFence,
  type ApplicationSubmissionStopProbe,
} from "../runtime/interrupt/application-submission-probe.js";
import type { ApplicationSubmitIdentity } from "./application-submit-fence.js";
import type { FlowType } from "../flows/index.js";
import type { SubmissionRequestIntent } from "../flows/submission-intent.js";
import type { HarnessResult } from "../harness/agent-harness.js";
import { APPLY_TIMEOUT_MS, createApplyJobFinalization, finalizeApplyJob, handleApplyJobFailure, persistStoppedSubmission } from "./apply-job-finalization.js";
import { runApplyBrowserSession } from "./apply-browser-session.js";
import { loadApprovedTurnScope } from "./application-submission-route-gate.js";
import { handOffUnavailableUnattendedTask } from "./apply-job-outcomes.js";

export type ApplyJobRunState = {
  resultWritten: boolean;
  resultWriteStarted: boolean;
  browserAttemptStarted: boolean;
  submissionClaimed: boolean;
  approvedTurnScope: ApplicationSubmissionStartScope | null;
  turnStopped: boolean;
  submissionRequestStarted: boolean;
  submissionAcknowledgementUncertain: boolean;
  submissionExecutionStartAttempted: boolean;
  submissionContextCloseConfirmed: boolean;
  submissionPageCloseConfirmed: boolean;
  submissionFenceUnavailable: boolean;
  submissionTaskInactive: boolean;
  pendingSubmissionFence: ApplicationSubmissionStartFence | null;
  submissionFenceTimer: ReturnType<typeof setTimeout> | null;
  activePageCloseRef: { current: (() => Promise<void>) | null };
  submissionFenceRelease: Promise<void> | null;
  submissionRouteState: { work: Promise<void> | null; cleanup: (() => Promise<void>) | null };
  submissionCandidateSeen: boolean;
  armedSubmissionIntent: SubmissionRequestIntent | null;
  activeBrowserExecution: Promise<void> | null;
  activeSubmissionContextClose: (() => Promise<void>) | null;
  activeSubmissionContextClosePromise: Promise<void> | null;
  applicationTaskFinalized: boolean;
  submissionUncertainWrite: Promise<SubmissionUncertainTaskWrite> | null;
  queueCatchStarted: boolean;
  stopController: AbortController;
  stopProbe: ApplicationSubmissionStopProbe | null;
  submissionSuperseded: boolean;
  challengeBoundary: "captcha" | "detection_error" | null;
  flow: FlowType | null;
  usedFlow: string | null;
  harnessResult: HarnessResult | null;
};

export type ApplyJobLifecycle = {
  closeActivePage(): Promise<void>;
  closeActiveSubmissionContext(): Promise<void>;
  interruptStoppedTurn(): Promise<void>;
  releaseSubmissionFence(commit: boolean): Promise<void>;
  markSubmissionUncertain(message: string): Promise<SubmissionUncertainTaskWrite>;
};

export type SubmissionUncertainTaskWrite = "written" | "superseded" | "failed";

export type ApplyJobRunContext = {
  job: Job<ApplyTaskPayload>;
  payload: ApplyTaskPayload;
  workerTaskId: string;
  executionId: string;
  submissionIdentity: ApplicationSubmitIdentity | null;
  validSubmitPayload: boolean;
  domain: string | null;
  startedAt: number;
  taskContext: TaskContext | null;
  lifecycle: ApplyJobLifecycle | null;
  isQueuePaused(): Promise<boolean>;
  state: ApplyJobRunState;
};

export function createApplyJobProcessor(dependencies: { isQueuePaused(): Promise<boolean> }) {
  return async (job: Job<ApplyTaskPayload>): Promise<void> => {
    const payload = job.data;
    const workerTaskId = typeof job.id === "string" ? job.id : "";
    const executionId = randomUUID();
    const { applicationTaskId, operation, userId, jobId, applyUrl, constraintHash } = payload;
    const submissionIdentity: ApplicationSubmitIdentity | null = operation === "submit"
      ? {
          applicationTaskId, userId, jobId, sessionId: payload.sessionId, fillTurnId: payload.fillTurnId,
          approvalId: payload.receiptId, constraintHash,
        }
      : null;
    const validSubmitPayload = operation !== "submit" ||
      (workerTaskId.length > 0 && matchesApplyTaskSubmitPayload(payload, payload) && /^[a-f0-9]{64}$/.test(constraintHash));
    let domain: string | null = null;
    try { domain = new URL(applyUrl).hostname.replace(/^www[.]/, ""); } catch { /* invalid URL — skip domain check */ }
    const state: ApplyJobRunState = {
      resultWritten: false,
      resultWriteStarted: false,
      browserAttemptStarted: false,
      submissionClaimed: false,
      approvedTurnScope: null,
      turnStopped: false,
      submissionRequestStarted: false,
      submissionAcknowledgementUncertain: false,
      submissionExecutionStartAttempted: false,
      submissionContextCloseConfirmed: false,
      submissionPageCloseConfirmed: false,
      submissionFenceUnavailable: false,
      submissionTaskInactive: false,
      pendingSubmissionFence: null,
      submissionFenceTimer: null,
      activePageCloseRef: { current: null },
      submissionFenceRelease: null,
      submissionRouteState: { work: null, cleanup: null },
      submissionCandidateSeen: false,
      armedSubmissionIntent: null,
      activeBrowserExecution: null,
      activeSubmissionContextClose: null,
      activeSubmissionContextClosePromise: null,
      applicationTaskFinalized: false,
      submissionUncertainWrite: null,
      queueCatchStarted: false,
      stopController: new AbortController(),
      stopProbe: null,
      submissionSuperseded: false,
      challengeBoundary: null,
      flow: null,
      usedFlow: null,
      harnessResult: null,
    };
    const context: ApplyJobRunContext = {
      job, payload, workerTaskId, executionId, submissionIdentity, validSubmitPayload, domain,
      startedAt: Date.now(), taskContext: null, lifecycle: null,
      isQueuePaused: dependencies.isQueuePaused, state,
    };
    context.lifecycle = createApplyJobFinalization(context);

    try {
      if (!validSubmitPayload) throw new Error("Canonical application submission identity is missing or malformed.");
      if (!applicationTaskId || !operation) {
        console.warn("[apply-worker] Skipping stale or revoked application task for job=" + jobId);
        return;
      }
      if (!(await isUserActive(getPool(), userId))) {
        if (operation === "fill") {
          const legacyFillOutcomes = await import("./legacy-apply-outcomes.js");
          await legacyFillOutcomes.persistSuspendedLegacyFillOutcome(getPool(), { applicationTaskId, userId, jobId });
        } else if (submissionIdentity) {
          await finishApplicationTask(getPool(), applicationTaskId, "failed", "account_suspended", "Account suspended by an administrator.", "submit", submissionIdentity);
        }
        console.warn("[apply-worker] Skipping suspended account for job=" + jobId);
        return;
      }
      if (operation === "fill" && !await claimApplicationTask(getPool(), applicationTaskId, userId, jobId)) {
        console.warn("[apply-worker] Skipping stale or revoked application task for job=" + jobId);
        return;
      }
      const initialControl = await evaluateUnattendedApplyControl(getPool(), applyUrl, userId);
      if (!initialControl.allowed) {
        const handedOff = await handOffUnavailableUnattendedTask({
          applicationTaskId, operation, userId, jobId, submissionIdentity: submissionIdentity ?? undefined,
          flow: initialControl.flow, startedAt: context.startedAt, jobTitle: null, jobCompany: "Application",
        });
        if (!handedOff) { state.submissionSuperseded = true; return; }
        state.resultWritten = true;
        return;
      }
      const limit = await checkRateLimit(userId, domain);
      if (!limit.allowed) throw new Error("RATE_LIMITED:" + (limit.retryAfterMs ?? 60_000));

      context.taskContext = await loadTaskContext(getPool(), userId, jobId, applyUrl, applicationTaskId);
      const actualUrlControl = context.taskContext.applyUrl === applyUrl
        ? initialControl
        : await evaluateUnattendedApplyControl(getPool(), context.taskContext.applyUrl, userId);
      if (!actualUrlControl.allowed) {
        const handedOff = await handOffUnavailableUnattendedTask({
          applicationTaskId, operation, userId, jobId, submissionIdentity: submissionIdentity ?? undefined,
          flow: actualUrlControl.flow, startedAt: context.startedAt,
          jobTitle: context.taskContext.jobTitle, jobCompany: context.taskContext.jobCompany,
        });
        if (!handedOff) { state.submissionSuperseded = true; return; }
        state.resultWritten = true;
        return;
      }
      state.flow = actualUrlControl.flow;

      if (operation === "submit" && submissionIdentity) {
        state.approvedTurnScope = await loadApprovedTurnScope(submissionIdentity, executionId, workerTaskId);
        const claim = await claimUnattendedSubmission(getPool(), submissionIdentity, workerTaskId);
        if (claim === "superseded") { state.submissionSuperseded = true; return; }
        if (claim !== "claimed") {
          console.warn("[apply-worker] Skipping stale or duplicate submit task for job=" + jobId);
          return;
        }
        state.submissionClaimed = true;
        if (await isApplicationSubmissionStopped(getPool(), state.approvedTurnScope)) {
          if (!await persistStoppedSubmission({
            identity: submissionIdentity, jobTitle: context.taskContext.jobTitle,
            jobCompany: context.taskContext.jobCompany, startedAt: context.startedAt,
          })) { state.submissionSuperseded = true; return; }
          state.resultWritten = true;
          return;
        }
        state.stopProbe = startApplicationSubmissionStopProbe({
          pool: getPool(), scope: state.approvedTurnScope, closePage: context.lifecycle.closeActivePage,
          controller: state.stopController, hasSubmissionStarted: () => state.submissionRequestStarted,
          onStopped: () => { state.turnStopped = true; },
          onUnavailable: (error) => {
            state.submissionFenceUnavailable = true;
            console.warn("[apply-worker] Agent turn state probe failed:", error instanceof Error ? error.message : String(error));
          },
        });
      }

      const browserExecution = runApplyBrowserSession(context);
      state.activeBrowserExecution = browserExecution;
      await Promise.race([
        browserExecution,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Apply timeout: exceeded 5 minutes")), APPLY_TIMEOUT_MS)),
      ]);
    } catch (error: unknown) {
      if (await handleApplyJobFailure(context, error)) throw error;
    } finally {
      await finalizeApplyJob(context);
    }
  };
}
