import type { Queue } from "bullmq"
import type { Pool, PoolClient } from "pg"
import { matchesApplyTaskSubmitPayload, type ApplyTaskPayload, type ApplyTaskSubmitIdentity, type ApplyTaskSubmitPayload } from "@jobcopilot/shared"
import { reconcileClaimedSubmissionUncertain } from "../db/submission-guard.js"
import type { ApplicationSubmitIdentity } from "./application-submit-fence.js"

const ADD_OPTIONS = { attempts: 3, backoff: { type: "exponential" as const, delay: 60_000 }, removeOnComplete: 100, removeOnFail: 200 }
const RETRY_OPTIONS = { resetAttemptsMade: true, resetAttemptsStarted: true }
const RUNNABLE_STATES = new Set(["waiting", "wait", "active", "delayed", "prioritized", "waiting-children"])

export type SubmitOutboxIntent = ApplyTaskSubmitIdentity & Readonly<{
  workerTaskId: string
  submitPayload: ApplyTaskSubmitPayload
}>
export type SubmitOutboxQueue = Pick<Queue<ApplyTaskPayload>, "add" | "getJob" | "isPaused" | "client" | "toKey">
export type SubmitDeliveryState = "absent" | "terminal" | "deferred" | "missing" | "mismatch"

export async function validateCurrentSubmit(
  client: PoolClient, intent: SubmitOutboxIntent,
): Promise<string | null> {
  const task = (await client.query<{ status: string; checkpoint: string | null; workerTaskId: string | null }>(`SELECT "status", "checkpoint", "workerTaskId"
    FROM "application_tasks" WHERE "id" = $1 AND "userId" = $2 AND "jobId" = $3
      AND "sessionId" = $4 AND "fillTurnId" = $5 FOR UPDATE`,
  [intent.applicationTaskId, intent.userId, intent.jobId, intent.sessionId, intent.fillTurnId])).rows[0]
  if (!task) return "application_task_scope_mismatch"
  if (task.workerTaskId !== intent.workerTaskId) return "worker_task_id_mismatch"
  const claimed = task.status === "filling" && ["browser_active", "submission_request_started"].includes(task.checkpoint ?? "")
  if (claimed) {
    const job = (await client.query<{ status: string; workflowState: string }>(`SELECT "status", "workflowState" FROM "Job"
      WHERE "id" = $1 AND "userId" = $2 FOR UPDATE`, [intent.jobId, intent.userId])).rows[0]
    return job?.status === "saved" && job.workflowState === "submitting" ? "claimed_delivery_recovery" : "application_job_state_mismatch"
  }
  if (task.status !== "filling" || task.checkpoint !== "submission_authorized") return "attempt_already_claimed_or_terminal"
  const job = (await client.query<{ status: string; workflowState: string }>(`SELECT "status", "workflowState" FROM "Job"
    WHERE "id" = $1 AND "userId" = $2 FOR UPDATE`, [intent.jobId, intent.userId])).rows[0]
  if (!job || job.status !== "saved" || job.workflowState !== "queued") return "application_job_state_mismatch"
  const account = (await client.query<{ accountStatus: string }>(`SELECT "accountStatus" FROM "User" WHERE "id" = $1`, [intent.userId])).rows[0]
  if (account?.accountStatus !== "active") return "application_account_inactive"
  const approval = await client.query<{ expired: boolean }>(`SELECT "expiresAt" <= CURRENT_TIMESTAMP AS expired FROM "agent_approvals" WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3
    AND "taskId" = $4 AND "userId" = $5 AND "jobId" = $6 AND "toolCallId" = $7
    AND "type" = 'submit_application' AND "status" = 'approved' AND "scopeHash" = $8
    AND "payload"->>'applicationTaskId' = $4 AND "payload"->>'jobId' = $6 FOR UPDATE`,
  [intent.receiptId, intent.sessionId, intent.fillTurnId, intent.applicationTaskId, intent.userId, intent.jobId,
    `application-submit:${intent.applicationTaskId}`, intent.constraintHash])
  if (approval.rowCount !== 1) return "approval_scope_mismatch"
  const event = await client.query(`SELECT "id" FROM "application_task_events" WHERE "taskId" = $1 AND "type" = 'submission_queued' AND "actor" = 'user'
    AND "data"->>'applicationTaskId' = $1 AND "data"->>'userId' = $2 AND "data"->>'jobId' = $3
    AND "data"->>'sessionId' = $4 AND "data"->>'fillTurnId' = $5 AND "data"->>'approvalId' = $6
    AND "data"->>'constraintHash' = $7 AND "data"->>'workerTaskId' = $8 LIMIT 2`,
  [intent.applicationTaskId, intent.userId, intent.jobId, intent.sessionId, intent.fillTurnId, intent.receiptId,
    intent.constraintHash, intent.workerTaskId])
  if (event.rowCount !== 1) return "submission_queued_event_mismatch"
  return approval.rows[0]?.expired ? "approval_expired" : null
}

export function matchesSubmitJobPayload(actual: unknown, intent: SubmitOutboxIntent): boolean {
  if (!matchesApplyTaskSubmitPayload(actual, intent)) return false
  if (typeof actual !== "object" || actual === null || Array.isArray(actual)) return false
  const row = actual as unknown as Record<string, unknown>
  return Object.keys(row).sort().join(",") === Object.keys(intent.submitPayload).sort().join(",") &&
    Object.entries(intent.submitPayload).every(([key, value]) => row[key] === value)
}

export async function inspectSubmitDelivery(
  queue: SubmitOutboxQueue, intent: SubmitOutboxIntent, allowAbsent: boolean,
): Promise<SubmitDeliveryState> {
  if (await queue.isPaused()) return "deferred"
  const lock = await (await queue.client).get(queue.toKey(`${intent.workerTaskId}:lock`))
  if (lock !== null) return "deferred"
  const job = await queue.getJob(intent.workerTaskId)
  if (!job) return allowAbsent ? "absent" : "missing"
  if (job.id !== intent.workerTaskId || !matchesSubmitJobPayload(job.data, intent)) return "mismatch"
  const state = await job.getState()
  if (state === "completed") return "terminal"
  if (state !== "failed" || job.attemptsMade < (job.opts.attempts ?? 1)) return "deferred"
  return "terminal"
}

export async function ensureSubmitQueueJob(
  queue: SubmitOutboxQueue, intent: SubmitOutboxIntent,
): Promise<"ready" | "deferred" | "mismatch"> {
  if (await queue.isPaused()) return "deferred"
  let job = await queue.getJob(intent.workerTaskId)
  if (!job) {
    const added = await queue.add("apply", intent.submitPayload, { jobId: intent.workerTaskId, ...ADD_OPTIONS })
    if (added.id !== intent.workerTaskId) return "mismatch"
    job = await queue.getJob(intent.workerTaskId)
    if (!job) throw new Error("application_submit_queue_job_unconfirmed")
  }
  if (job.id !== intent.workerTaskId || !matchesSubmitJobPayload(job.data, intent)) return "mismatch"
  const state = await job.getState()
  const finalFailure = state === "failed" && job.attemptsMade >= (job.opts.attempts ?? 1)
  if (state === "completed" || finalFailure) {
    const lock = await (await queue.client).get(queue.toKey(`${intent.workerTaskId}:lock`))
    if (lock !== null) return "deferred"
    try { await job.retry(state, RETRY_OPTIONS) }
    catch (error: unknown) {
      if (!RUNNABLE_STATES.has(await job.getState().catch(() => "unknown"))) throw error
    }
    return "ready"
  }
  return RUNNABLE_STATES.has(state) ? "ready" : "deferred"
}

export async function resetExpiredSubmitAuthorization(client: PoolClient, intent: SubmitOutboxIntent): Promise<void> {
  const task = await client.query(`UPDATE application_tasks SET status = 'waiting_for_authorization', "checkpoint" = 'form_filled',
      error = 'Submission approval expired before dispatch. A fresh approval is required.', "completedAt" = NULL, "updatedAt" = NOW()
    WHERE id = $1 AND "userId" = $2 AND "jobId" = $3 AND "sessionId" = $4 AND "fillTurnId" = $5
      AND "workerTaskId" = $6 AND status = 'filling' AND "checkpoint" = 'submission_authorized' RETURNING id`,
  [intent.applicationTaskId, intent.userId, intent.jobId, intent.sessionId, intent.fillTurnId, intent.workerTaskId])
  if (task.rowCount !== 1) throw new Error("application_submit_expired_task_changed")
  const job = await client.query(`UPDATE "Job" SET "workflowState" = 'ready_to_apply', "updatedAt" = NOW()
    WHERE id = $1 AND "userId" = $2 AND status = 'saved' AND "workflowState" = 'queued' RETURNING id`,
  [intent.jobId, intent.userId])
  if (job.rowCount !== 1) throw new Error("application_submit_expired_job_changed")
  await client.query(`INSERT INTO application_task_events (id, "taskId", type, actor, body, data, "createdAt")
    VALUES ('evt_' || md5(random()::text || clock_timestamp()::text), $1, 'waiting_for_authorization', 'worker',
      'Submission approval expired before dispatch. A fresh approval is required.',
      jsonb_build_object('applicationTaskId', $1::text, 'userId', $2::text, 'jobId', $3::text, 'sessionId', $4::text,
        'fillTurnId', $5::text, 'approvalId', $6::text, 'workerTaskId', $7::text), NOW())`,
  [intent.applicationTaskId, intent.userId, intent.jobId, intent.sessionId, intent.fillTurnId, intent.receiptId, intent.workerTaskId])
}

export async function reconcileClaimedTerminalSubmit(
  pool: Pool, queue: SubmitOutboxQueue, intent: SubmitOutboxIntent,
): Promise<SubmitDeliveryState | "reconciled" | "unchanged"> {
  // A durable exact claim may only recover as uncertain after a pruned job also has no exact lock.
  const delivery = await inspectSubmitDelivery(queue, intent, true)
  if (delivery !== "terminal" && delivery !== "absent") return delivery
  const identity: ApplicationSubmitIdentity = {
    applicationTaskId: intent.applicationTaskId, userId: intent.userId, jobId: intent.jobId,
    sessionId: intent.sessionId, fillTurnId: intent.fillTurnId,
    approvalId: intent.receiptId, constraintHash: intent.constraintHash,
  }
  let fencedDelivery: SubmitDeliveryState | undefined
  const reconciled = await reconcileClaimedSubmissionUncertain(pool, identity, intent.workerTaskId, async () => {
    fencedDelivery = await inspectSubmitDelivery(queue, intent, true)
    return fencedDelivery === "terminal" || fencedDelivery === "absent"
  })
  if (reconciled) return "reconciled"
  return fencedDelivery && fencedDelivery !== "terminal" && fencedDelivery !== "absent" ? fencedDelivery : "unchanged"
}
