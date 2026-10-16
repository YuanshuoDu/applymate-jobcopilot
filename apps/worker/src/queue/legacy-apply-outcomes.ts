import type { Pool, PoolClient } from "pg";

import type { InsertApplyResult } from "../db/apply-results.js";
import type { ApplyTask, HarnessResult } from "../harness/agent-harness.js";
import { finishApplicationTask } from "../db/application-task-state.js";
import {
  persistLegacyApplicationTaskOutcome,
  writeLegacyFillErrorOutcome as writeError,
  writeLegacyFillReviewOutcome as writeReview,
  writeLegacyFillSuccessOutcome as writeSuccess,
  writeLegacyFillUnavailableOutcome as writeUnavailable,
  type LegacyApplicationTaskOutcomeResult,
  type LegacyApplicationTaskOutcomeScope,
} from "../db/legacy-application-task-outcome.js";
import type { FlowType } from "../flows/index.js";
import { formNeedsMessage } from "../harness/form-review.js";
import type { FormReviewNeeds } from "../harness/form-review.js";
import type { NotifyApplyResultParams } from "../notifications/notify-apply-result.js";

type SuppressedStatus = Extract<LegacyApplicationTaskOutcomeResult<unknown>, { status: "taskgraph_bound" | "task_inactive" | "missing" }>['status'];
type NotifiableStatus = "submitted" | "manual" | "failed" | "submission_blocked";
type TaskNotificationContext = { jobTitle: string | null; jobCompany: string };
type InAppNotifier = (params: {
  userId: string; jobId: string; jobTitle: string | null; jobCompany: string; status: NotifiableStatus;
}) => Promise<void>;

async function withLegacyFillOutcome<T>(
  pool: Pool,
  scope: LegacyApplicationTaskOutcomeScope,
  write: (client: PoolClient) => Promise<T>,
  options: { readonly lockLatestTurn?: boolean } = {},
): Promise<LegacyApplicationTaskOutcomeResult<T>> {
  const client = await pool.connect();
  let transactionOpen = false;
  try {
    await client.query("BEGIN");
    transactionOpen = true;
    await client.query("SELECT set_config($1, $2, true)", ["app.user_id", scope.userId]);
    const result = await persistLegacyApplicationTaskOutcome(client, scope, write, options);
    await client.query("COMMIT");
    transactionOpen = false;
    return result;
  } catch (error: unknown) {
    if (transactionOpen) await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function reportSuppressed(scope: LegacyApplicationTaskOutcomeScope, status: SuppressedStatus): void {
  console.info(`[apply-worker] Suppressed legacy fill outcome (${status}) for task=${scope.applicationTaskId}`);
}

function makeResult(
  scope: LegacyApplicationTaskOutcomeScope,
  status: string,
  atsType: string | null,
  flowUsed: string | null,
  error: string | null,
  durationMs: number,
): InsertApplyResult {
  return { userId: scope.userId, jobId: scope.jobId, status, mode: "unattended", atsType, flowUsed, error, durationMs };
}

export async function persistSuspendedLegacyFillOutcome(
  pool: Pool,
  scope: LegacyApplicationTaskOutcomeScope,
): Promise<void> {
  const outcome = await withLegacyFillOutcome(pool, scope, async (client) => {
    await finishApplicationTask(client, scope.applicationTaskId, "failed", "account_suspended", "Account suspended by an administrator.", "fill");
    return true;
  });
  if (outcome.status !== "persisted") reportSuppressed(scope, outcome.status);
}

export async function persistLegacyFillHarnessOutcome(input: {
  readonly pool: Pool;
  readonly scope: LegacyApplicationTaskOutcomeScope;
  readonly harnessResult: HarnessResult;
  readonly flow: FlowType;
  readonly usedFlow: string | null;
  readonly startedAt: number;
  readonly task: Pick<ApplyTask, "jobTitle" | "jobCompany" | "applyUrl">;
  readonly inspectNeeds: () => Promise<FormReviewNeeds>;
  readonly turnStopped: boolean;
  readonly submissionRequestStarted: boolean;
  readonly applicationTaskFinalized: boolean;
  readonly needsUserTakeover: (error: string | null | undefined) => boolean;
  readonly notifyInApp: InAppNotifier;
  readonly notifyEmail: (params: NotifyApplyResultParams) => Promise<void>;
  readonly purgeCoverLetters: (userId: string, jobId: string) => Promise<unknown>;
}): Promise<{ persisted: boolean; taskFinalized: boolean }> {
  const { pool, scope, harnessResult } = input;
  const durationMs = Date.now() - input.startedAt;

  if (harnessResult.reviewReady) {
    const needs = await input.inspectNeeds();
    const needMessage = formNeedsMessage(needs);
    const outcome = await withLegacyFillOutcome(pool, scope, (client) => writeReview(pool, client, scope, {
      result: makeResult(scope, "manual", input.flow ?? "unknown", input.usedFlow,
        needMessage ?? harnessResult.error ?? "Form filled and ready for user review.", durationMs),
      needMessage,
      needs,
    }), { lockLatestTurn: !needMessage });
    if (outcome.status !== "persisted") {
      reportSuppressed(scope, outcome.status);
      return { persisted: false, taskFinalized: input.applicationTaskFinalized };
    }
    if (outcome.value) input.notifyInApp({
      userId: scope.userId, jobId: scope.jobId, jobTitle: input.task.jobTitle, jobCompany: input.task.jobCompany, status: "manual",
    }).catch((error: Error) => console.warn("[notify] in-app notification failed:", error.message));
    return { persisted: true, taskFinalized: input.applicationTaskFinalized };
  }

  const isSubmitted = harnessResult.status === "submitted";
  const outcome = await withLegacyFillOutcome(pool, scope, (client) => writeSuccess(client, scope, {
    result: makeResult(scope, harnessResult.status, input.flow ?? "unknown", input.usedFlow, harnessResult.error ?? null, durationMs),
    isSubmitted,
    isSubmissionBlocked: harnessResult.status === "submission_blocked",
    requiresUserTakeover: harnessResult.status === "manual" || input.needsUserTakeover(harnessResult.error),
    turnStopped: input.turnStopped,
    submissionRequestStarted: input.submissionRequestStarted,
    applicationTaskFinalized: input.applicationTaskFinalized,
  }));
  if (outcome.status !== "persisted") {
    reportSuppressed(scope, outcome.status);
    return { persisted: false, taskFinalized: input.applicationTaskFinalized };
  }

  if (isSubmitted) {
    await input.purgeCoverLetters(scope.userId, scope.jobId).catch((error: Error) =>
      console.warn("[apply-worker] Could not apply cover-letter retention policy:", error.message));
  }
  if (["submitted", "manual", "failed", "submission_blocked"].includes(harnessResult.status)) {
    input.notifyInApp({
      userId: scope.userId, jobId: scope.jobId, jobTitle: input.task.jobTitle, jobCompany: input.task.jobCompany,
      status: harnessResult.status as NotifiableStatus,
    }).catch((error: Error) => console.warn("[notify] in-app notification failed:", error.message));
  }
  if (harnessResult.status !== "dry-run") input.notifyEmail({
    userId: scope.userId, jobTitle: input.task.jobTitle, jobCompany: input.task.jobCompany,
    status: harnessResult.status, error: harnessResult.error ?? null, flowUsed: input.usedFlow, jobUrl: input.task.applyUrl,
  }).catch((error: Error) => console.warn("[notify] email failed:", error.message));
  return { persisted: true, taskFinalized: outcome.value.taskFinalized };
}

export async function persistLegacyFillErrorOutcome(input: {
  readonly pool: Pool;
  readonly scope: LegacyApplicationTaskOutcomeScope;
  readonly error: string;
  readonly durationMs: number;
  readonly task: TaskNotificationContext;
  readonly shouldInsertResult: boolean;
  readonly browserAttemptStarted: boolean;
  readonly applicationTaskFinalized: boolean;
  readonly notifyInApp: InAppNotifier;
}): Promise<{ insertedResult: boolean; taskFinalized: boolean } | null> {
  const status = input.browserAttemptStarted ? "manual" : "failed";
  const outcome = await withLegacyFillOutcome(input.pool, input.scope, (client) => writeError(client, input.scope, {
    result: makeResult(input.scope, status, null, null, input.error, input.durationMs),
    shouldInsertResult: input.shouldInsertResult,
    browserAttemptStarted: input.browserAttemptStarted,
    applicationTaskFinalized: input.applicationTaskFinalized,
  }));
  if (outcome.status !== "persisted") {
    reportSuppressed(input.scope, outcome.status);
    return null;
  }
  if (outcome.value.insertedResult) input.notifyInApp({
    userId: input.scope.userId, jobId: input.scope.jobId, jobTitle: input.task.jobTitle ?? null,
    jobCompany: input.task.jobCompany, status,
  }).catch((error: Error) => console.warn("[notify] in-app notification failed:", error.message));
  return outcome.value;
}

export async function persistUnavailableLegacyFillOutcome(input: {
  readonly pool: Pool;
  readonly scope: LegacyApplicationTaskOutcomeScope;
  readonly task: TaskNotificationContext;
  readonly flow: FlowType;
  readonly startedAt: number;
  readonly message: string;
  readonly notifyInApp: InAppNotifier;
}): Promise<void> {
  const outcome = await withLegacyFillOutcome(input.pool, input.scope, (client) => writeUnavailable(
    client,
    input.scope,
    makeResult(input.scope, "manual", input.flow, null, input.message, Date.now() - input.startedAt),
    input.message,
  ));
  if (outcome.status === "persisted") input.notifyInApp({
    userId: input.scope.userId, jobId: input.scope.jobId, jobTitle: input.task.jobTitle ?? null,
    jobCompany: input.task.jobCompany, status: "manual",
  }).catch((error: Error) => console.warn("[notify] in-app notification failed:", error.message));
  else reportSuppressed(input.scope, outcome.status);
}
