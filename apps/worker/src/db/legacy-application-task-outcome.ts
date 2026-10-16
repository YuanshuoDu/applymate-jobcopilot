import type { Pool, PoolClient } from "pg";

import type { InsertApplyResult } from "./apply-results.js";
import { completeFillForReview, finishApplicationTask, pauseForFormInput, USER_TAKEOVER_CHECKPOINT } from "./application-task-state.js";
import type { FormReviewNeeds } from "../harness/form-review.js";

export type LegacyApplicationTaskOutcomeScope = {
  readonly applicationTaskId: string;
  readonly userId: string;
  readonly jobId: string;
};

export type LegacyApplicationTaskOutcomeResult<T> =
  | { readonly status: "persisted"; readonly value: T }
  | { readonly status: "taskgraph_bound" | "task_inactive" | "missing" };

type LockedApplicationTask = {
  id: string;
  fillTurnId: string | null;
  sessionId: string | null;
  status: string;
  checkpoint: string | null;
};

/** Persists a legacy outcome only while the exact unbound task remains worker-completable. Caller owns the transaction. */
export async function persistLegacyApplicationTaskOutcome<T>(
  client: PoolClient,
  scope: LegacyApplicationTaskOutcomeScope,
  write: (client: PoolClient) => Promise<T>,
  options: { readonly lockLatestTurn?: boolean } = {},
): Promise<LegacyApplicationTaskOutcomeResult<T>> {
  const snapshot = await client.query<{ sessionId: string | null }>(
    `SELECT "sessionId" FROM application_tasks WHERE "id" = $1 AND "userId" = $2 AND "jobId" = $3`,
    [scope.applicationTaskId, scope.userId, scope.jobId],
  );
  if (!snapshot.rows[0]) return { status: "missing" };

  const sessionId = snapshot.rows[0].sessionId;
  if (sessionId) {
    await client.query(
      `SELECT "id" FROM agent_sessions WHERE "id" = $1 AND "userId" = $2 FOR UPDATE`,
      [sessionId, scope.userId],
    );
    if (options.lockLatestTurn) {
      await client.query(
        `SELECT "id" FROM agent_turns WHERE "sessionId" = $1 AND "userId" = $2 ORDER BY "createdAt" DESC LIMIT 1 FOR UPDATE`,
        [sessionId, scope.userId],
      );
    }
  }

  const locked = await client.query<LockedApplicationTask>(
    `SELECT "id", "fillTurnId", "sessionId", "status", "checkpoint" FROM application_tasks
      WHERE "id" = $1 AND "userId" = $2 AND "jobId" = $3 AND "sessionId" IS NOT DISTINCT FROM $4
      FOR UPDATE`,
    [scope.applicationTaskId, scope.userId, scope.jobId, sessionId],
  );
  const task = locked.rows[0];
  if (!task) return { status: "missing" };
  if (task.fillTurnId !== null) return { status: "taskgraph_bound" };
  if (task.status !== "filling" || !["form_fill_queued", "browser_active"].includes(task.checkpoint ?? "")) {
    return { status: "task_inactive" };
  }
  return { status: "persisted", value: await write(client) };
}

/** Inserts an ApplyResult on the caller's outcome transaction. */
export async function insertApplyResultWithClient(
  client: PoolClient,
  result: InsertApplyResult,
): Promise<number> {
  const inserted = await client.query<{ id: number }>(
    `INSERT INTO apply_results (user_id, job_id, mode, ats_type, flow_used, status, error, duration_ms)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [result.userId, result.jobId, result.mode ?? "unattended", result.atsType ?? null, result.flowUsed ?? null,
      result.status, result.error ?? null, result.durationMs ?? null],
  );
  const id = inserted.rows[0]?.id;
  if (id === undefined) throw new Error("Legacy application result was not persisted");
  return id;
}

/** Outcome writers use the same caller-owned transaction after the unbound task row is locked. */
export async function writeLegacyFillReviewOutcome(
  pool: Pool,
  client: PoolClient,
  scope: LegacyApplicationTaskOutcomeScope,
  input: { readonly result: InsertApplyResult; readonly needMessage: string | null; readonly needs: FormReviewNeeds },
): Promise<boolean> {
  await insertApplyResultWithClient(client, input.result);
  if (input.needMessage) {
    await pauseForFormInput(client, scope.applicationTaskId, input.needMessage, input.needs);
    return true;
  }
  return completeFillForReview(pool, scope.applicationTaskId, scope.userId, scope.jobId, client);
}

export async function writeLegacyFillSuccessOutcome(
  client: PoolClient,
  scope: LegacyApplicationTaskOutcomeScope,
  input: {
    readonly result: InsertApplyResult;
    readonly isSubmitted: boolean;
    readonly isSubmissionBlocked: boolean;
    readonly requiresUserTakeover: boolean;
    readonly turnStopped: boolean;
    readonly submissionRequestStarted: boolean;
    readonly applicationTaskFinalized: boolean;
  },
): Promise<{ taskFinalized: boolean }> {
  await insertApplyResultWithClient(client, input.result);
  await client.query(
    'UPDATE "Job" SET status = $1, "workflowState" = $2, "appliedAt" = CASE WHEN $1 = \'applied\' THEN NOW() ELSE "appliedAt" END, "updatedAt" = NOW() WHERE id = $3 AND "userId" = $4',
    [input.isSubmitted ? "applied" : "saved", input.isSubmitted ? "submitted" : "ready_to_apply", scope.jobId, scope.userId],
  );
  const stoppedTask = input.turnStopped && !input.submissionRequestStarted
    ? await client.query<{ status: string }>(`SELECT "status" FROM application_tasks WHERE "id" = $1 AND "userId" = $2`, [scope.applicationTaskId, scope.userId])
    : null;
  const finalizeTask = !input.applicationTaskFinalized || input.isSubmitted && input.submissionRequestStarted;
  const taskFinalized = finalizeTask && stoppedTask?.rows[0]?.status !== "cancelled";
  if (taskFinalized) {
    await finishApplicationTask(
      client, scope.applicationTaskId,
      input.isSubmitted ? "submitted" : input.requiresUserTakeover ? "waiting_for_user" : input.isSubmissionBlocked ? "waiting_for_authorization" : "failed",
      input.isSubmitted ? "submission_verified" : input.turnStopped && !input.submissionRequestStarted ? "turn_stopped_before_submit" : input.isSubmissionBlocked ? "submission_blocked" : input.requiresUserTakeover ? USER_TAKEOVER_CHECKPOINT : "execution_failed",
      input.result.error ?? null, "fill",
    );
  }
  return { taskFinalized };
}

export async function writeLegacyFillErrorOutcome(
  client: PoolClient,
  scope: LegacyApplicationTaskOutcomeScope,
  input: {
    readonly result: InsertApplyResult;
    readonly shouldInsertResult: boolean;
    readonly browserAttemptStarted: boolean;
    readonly applicationTaskFinalized: boolean;
  },
): Promise<{ insertedResult: boolean; taskFinalized: boolean }> {
  if (input.shouldInsertResult) await insertApplyResultWithClient(client, input.result);
  if (input.browserAttemptStarted) {
    await client.query(
      `UPDATE "Job" SET "workflowState" = 'ready_to_apply', "analysisNote" = $3, "updatedAt" = NOW()
        WHERE id = $1 AND "userId" = $2 AND "workflowState" = 'submitting'`,
      [scope.jobId, scope.userId, `[Autopilot needs review] ${input.result.error}`],
    );
  } else {
    await client.query(
      'UPDATE "Job" SET status = $1, "workflowState" = $2, "updatedAt" = NOW() WHERE id = $3 AND "userId" = $4',
      ["saved", "ready_to_apply", scope.jobId, scope.userId],
    );
  }
  const taskFinalized = !input.applicationTaskFinalized;
  if (taskFinalized) {
    await finishApplicationTask(
      client, scope.applicationTaskId, input.browserAttemptStarted ? "waiting_for_user" : "failed",
      input.browserAttemptStarted ? USER_TAKEOVER_CHECKPOINT : "worker_failed", input.result.error ?? null, "fill",
    );
  }
  return { insertedResult: input.shouldInsertResult, taskFinalized };
}

export async function writeLegacyFillUnavailableOutcome(
  client: PoolClient,
  scope: LegacyApplicationTaskOutcomeScope,
  result: InsertApplyResult,
  message: string,
): Promise<boolean> {
  await insertApplyResultWithClient(client, result);
  await client.query(
    'UPDATE "Job" SET status = $1, "workflowState" = $2, "updatedAt" = NOW() WHERE id = $3 AND "userId" = $4',
    ["saved", "ready_to_apply", scope.jobId, scope.userId],
  );
  await finishApplicationTask(client, scope.applicationTaskId, "waiting_for_user", "materials_ready", message, "fill");
  return true;
}
