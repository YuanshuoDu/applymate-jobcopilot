import { getPool, insertApplyResult, type InsertApplyResult } from "../db/apply-results.js";
import * as legacyFillOutcomes from "./legacy-apply-outcomes.js";
import {
  finishApplicationTask,
  CAPTCHA_USER_TAKEOVER_MESSAGE,
  CHALLENGE_DETECTION_FAILED_MESSAGE,
  needsUserTakeover,
  USER_TAKEOVER_CHECKPOINT,
} from "../db/application-task-state.js";
import { updateJobForSubmission, UNCONFIRMED_SUBMISSION_MESSAGE } from "../db/submission-guard.js";
import { createNotification } from "../notifications/create-notification.js";
import { notifyApplyResult } from "../notifications/notify-apply-result.js";
import { purgeTemporaryGeneratedCoverLetters } from "../notifications/purge-cover-letters.js";
import { inspectFormReviewNeeds } from "../harness/form-review.js";
import { UNATTENDED_APPLY_UNAVAILABLE_MESSAGE } from "./unattended-apply-control.js";
import type { ApplyJobRunContext } from "./apply-job-runner.js";
import type { ApplicationSubmitIdentity } from "./application-submit-fence.js";
import type { ApplyTaskPayload } from "@jobcopilot/shared";
import type { FlowType } from "../flows/index.js";
import type { HarnessResult } from "../harness/agent-harness.js";
import type { Page } from "playwright-core";

export async function persistApplyJobOutcome(
  context: ApplyJobRunContext,
  page: Page,
  initialResult: HarnessResult,
): Promise<void> {
  const { payload, submissionIdentity, taskContext } = context;
  const { applicationTaskId, operation, userId, jobId } = payload;
  const { state } = context;
  let harnessResult = initialResult;
  let usedFlow = state.usedFlow;
  const flow = state.flow;

  if (state.submissionAcknowledgementUncertain) {
    harnessResult = { ...harnessResult, status: "manual", error: UNCONFIRMED_SUBMISSION_MESSAGE };
    usedFlow = submissionIdentity ? "application.submit" : usedFlow;
  } else if (state.turnStopped && !state.submissionRequestStarted && harnessResult.status !== "submitted") {
    harnessResult = { ...harnessResult, status: "failed", error: "Agent turn was stopped before the application submission request started." };
    usedFlow = submissionIdentity ? "application.submit" : usedFlow;
  } else if (state.submissionRequestStarted && harnessResult.status !== "submitted") {
    harnessResult = { ...harnessResult, status: "manual", error: UNCONFIRMED_SUBMISSION_MESSAGE };
    usedFlow = submissionIdentity ? "application.submit" : usedFlow;
  } else if (state.submissionTaskInactive && harnessResult.status === "submission_blocked") {
    harnessResult = { ...harnessResult, status: "failed", error: "The application task was cancelled before the submission request started." };
  } else if (state.submissionFenceUnavailable && !state.submissionRequestStarted && harnessResult.status === "submission_blocked") {
    harnessResult = { ...harnessResult, status: "failed", error: "Agent turn state could not be verified, so the application was not submitted." };
  }
  if (state.challengeBoundary && !state.turnStopped && !state.submissionAcknowledgementUncertain) {
    harnessResult = {
      ...harnessResult,
      status: "manual",
      error: state.challengeBoundary === "detection_error"
        ? CHALLENGE_DETECTION_FAILED_MESSAGE
        : CAPTCHA_USER_TAKEOVER_MESSAGE,
    };
    usedFlow = null;
  }
  state.harnessResult = harnessResult;
  state.usedFlow = usedFlow;

  const submissionUncertain = state.submissionRequestStarted && harnessResult.status !== "submitted";
  if (submissionUncertain) {
    if (!state.applicationTaskFinalized) {
      if (await finishApplicationTask(
        getPool(), applicationTaskId, "waiting_for_user", "submission_uncertain",
        harnessResult.error ?? UNCONFIRMED_SUBMISSION_MESSAGE, "submit", submissionIdentity!,
      ) === "superseded") { state.submissionSuperseded = true; return; }
      state.applicationTaskFinalized = true;
    }
    await context.lifecycle?.closeActiveSubmissionContext();
  }
  if (state.queueCatchStarted || state.submissionSuperseded) return;

  if (operation === "fill") {
    const outcome = await legacyFillOutcomes.persistLegacyFillHarnessOutcome({
      pool: getPool(), scope: { applicationTaskId, userId, jobId }, harnessResult, flow, usedFlow,
      startedAt: context.startedAt, task: taskContext!,
      inspectNeeds: () => inspectFormReviewNeeds(page), turnStopped: state.turnStopped,
      submissionRequestStarted: state.submissionRequestStarted,
      applicationTaskFinalized: state.applicationTaskFinalized,
      needsUserTakeover, notifyInApp: createApplyResultNotification,
      notifyEmail: notifyApplyResult, purgeCoverLetters: purgeTemporaryGeneratedCoverLetters,
    });
    if (!outcome.persisted) return;
    state.resultWritten = true;
    state.applicationTaskFinalized = outcome.taskFinalized;
    return;
  }

  state.resultWriteStarted = true;
  try {
    const resultId = await insertApplyResult({
      userId, jobId, status: harnessResult.status as InsertApplyResult["status"],
      mode: "unattended", atsType: flow ?? "unknown", flowUsed: usedFlow,
      error: harnessResult.error ?? null, durationMs: Date.now() - context.startedAt,
      submissionIdentity: submissionIdentity!,
    });
    if (resultId === null) { state.submissionSuperseded = true; return; }
    state.resultWritten = true;
  } catch (error: unknown) {
    state.resultWriteStarted = false;
    throw error;
  }

  if (state.queueCatchStarted || state.submissionSuperseded) return;

  if (["submitted", "manual", "failed", "submission_blocked"].includes(harnessResult.status)) {
    createApplyResultNotification({
      userId, jobId, jobTitle: taskContext!.jobTitle, jobCompany: taskContext!.jobCompany,
      status: harnessResult.status as "submitted" | "manual" | "failed" | "submission_blocked",
    }).catch((error: Error) => console.warn("[notify] in-app notification failed:", error.message));
  }
  if (harnessResult.status !== "dry-run") {
    notifyApplyResult({
      userId, jobTitle: taskContext!.jobTitle, jobCompany: taskContext!.jobCompany,
      status: harnessResult.status, error: harnessResult.error ?? null,
      flowUsed: usedFlow, jobUrl: taskContext!.applyUrl,
    }).catch((error: Error) => console.warn("[notify] email failed:", error.message));
  }

  const isSubmitted = harnessResult.status === "submitted";
  const isSubmissionBlocked = harnessResult.status === "submission_blocked";
  const newJobStatus = isSubmitted ? "applied" : "saved";
  const newWorkflowState = isSubmitted ? "submitted" : "submitting";
  if (isSubmitted) {
    await purgeTemporaryGeneratedCoverLetters(userId, jobId).catch((error: Error) =>
      console.warn("[apply-worker] Could not apply cover-letter retention policy:", error.message)
    );
  }
  if (state.queueCatchStarted) return;
  const jobWrite = await updateJobForSubmission(
    getPool(), submissionIdentity!, { status: newJobStatus, workflowState: newWorkflowState, applied: isSubmitted }, "finish_apply_job_state",
  );
  if (jobWrite.kind === "superseded") { state.submissionSuperseded = true; return; }
  if (state.queueCatchStarted) return;
  const requiresUserTakeover = harnessResult.status === "manual" || needsUserTakeover(harnessResult.error);
  const stoppedTask = state.turnStopped && !state.submissionRequestStarted
    ? await getPool().query<{ status: string }>('SELECT "status" FROM application_tasks WHERE "id" = $1 AND "userId" = $2', [applicationTaskId, userId])
    : null;
  if ((!state.applicationTaskFinalized || isSubmitted && state.submissionRequestStarted) && stoppedTask?.rows[0]?.status !== "cancelled") {
    const taskWrite = await finishApplicationTask(
      getPool(), applicationTaskId,
      isSubmitted ? "submitted" : submissionUncertain || requiresUserTakeover ? "waiting_for_user" : isSubmissionBlocked ? "waiting_for_authorization" : "failed",
      isSubmitted ? "submission_verified" : submissionUncertain ? "submission_uncertain" : state.turnStopped && !state.submissionRequestStarted ? "turn_stopped_before_submit" : isSubmissionBlocked ? "submission_blocked" : requiresUserTakeover ? USER_TAKEOVER_CHECKPOINT : "execution_failed",
      harnessResult.error ?? null, operation === "submit" ? "submit" : "fill", submissionIdentity ?? undefined,
    );
    if (taskWrite === "superseded") { state.submissionSuperseded = true; return; }
    state.applicationTaskFinalized = true;
  }
}

export async function handOffUnavailableUnattendedTask(params: {
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
      pool: getPool(), scope: { applicationTaskId: params.applicationTaskId, userId: params.userId, jobId: params.jobId },
      task: { jobTitle: params.jobTitle, jobCompany: params.jobCompany }, flow: params.flow,
      startedAt: params.startedAt, message: UNATTENDED_APPLY_UNAVAILABLE_MESSAGE,
      notifyInApp: createApplyResultNotification,
    });
    return true;
  }
  const identity = params.submissionIdentity;
  if (!identity) throw new Error("Unavailable submit handoff requires an exact application attempt identity.");
  const resultId = await insertApplyResult({
    userId: params.userId, jobId: params.jobId, status: "manual", mode: "unattended",
    atsType: params.flow, flowUsed: null, error: UNATTENDED_APPLY_UNAVAILABLE_MESSAGE,
    durationMs: Date.now() - params.startedAt, submissionIdentity: identity,
  });
  if (resultId === null) return false;
  const jobWrite = await updateJobForSubmission(getPool(), identity, { status: "saved", workflowState: "ready_to_apply" }, "handoff_unavailable_submit");
  if (jobWrite.kind === "superseded") return false;
  if (await finishApplicationTask(
    getPool(), params.applicationTaskId,
    params.operation === "submit" ? "waiting_for_authorization" : "waiting_for_user",
    params.operation === "submit" ? "form_filled" : "materials_ready",
    UNATTENDED_APPLY_UNAVAILABLE_MESSAGE, params.operation, identity,
  ) === "superseded") return false;
  createApplyResultNotification({
    userId: params.userId, jobId: params.jobId, jobTitle: params.jobTitle,
    jobCompany: params.jobCompany, status: "manual",
  }).catch((error: Error) => console.warn("[notify] in-app notification failed:", error.message));
  return true;
}

export async function createApplyResultNotification(params: {
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

function notificationTypeForStatus(
  status: "submitted" | "manual" | "failed" | "submission_blocked"
): "apply_submitted" | "apply_manual" | "apply_failed" | "apply_blocked" {
  return status === "submitted" ? "apply_submitted"
    : status === "submission_blocked" ? "apply_blocked"
    : status === "manual" ? "apply_manual" : "apply_failed";
}

function notificationTitle(company: string, status: "submitted" | "manual" | "failed" | "submission_blocked"): string {
  return status === "submitted" ? company + " ✅"
    : status === "submission_blocked" ? company + " submission blocked"
    : status === "manual" ? company + " ⚠️" : company + " ❌";
}
