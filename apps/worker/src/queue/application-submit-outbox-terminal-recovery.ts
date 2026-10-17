import type { Queue } from "bullmq"
import type { Pool, PoolClient } from "pg"
import { matchesApplyTaskSubmitPayload, type ApplyTaskPayload, type ApplyTaskSubmitIdentity, type ApplyTaskSubmitPayload } from "@jobcopilot/shared"
import { reconcileClaimedSubmissionUncertain } from "../db/submission-guard.js"
import {
  isValidApplicationSubmitTerminalObservation,
  matchesExactApplicationSubmitTerminalProof,
  type ApplicationSubmitIdentity,
  type ApplicationSubmitTerminalObservation,
} from "./application-submit-fence.js"

const ADD_OPTIONS = { attempts: 3, backoff: { type: "exponential" as const, delay: 60_000 }, removeOnComplete: false, removeOnFail: false }
const RETRY_OPTIONS = { resetAttemptsMade: true, resetAttemptsStarted: true }
const RUNNABLE_STATES = new Set(["waiting", "wait", "active", "delayed", "prioritized", "waiting-children"])

export type SubmitOutboxIntent = ApplyTaskSubmitIdentity & Readonly<{
  workerTaskId: string
  submitPayload: ApplyTaskSubmitPayload
}>
export type SubmitOutboxQueue = Pick<Queue<ApplyTaskPayload>, "add" | "getJob" | "isPaused" | "client" | "toKey">
export type SubmitDeliveryState = "absent" | "terminal" | "deferred" | "missing" | "mismatch"
export type SubmitTerminalObservation = ApplicationSubmitTerminalObservation

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

async function readTerminalProof(client: PoolClient, intent: SubmitOutboxIntent): Promise<{ present: boolean; valid: boolean }> {
  const rows = await client.query<{ data: unknown }>(`SELECT "data" FROM "application_task_events"
    WHERE "taskId" = $1 AND "type" = 'submission_terminal_observed' AND "actor" = 'worker'
      AND "data"->>'fillTurnId' = $2 FOR SHARE`, [intent.applicationTaskId, intent.fillTurnId])
  return { present: rows.rows.length > 0, valid: rows.rows.length === 1 && matchesExactApplicationSubmitTerminalProof(rows.rows[0]?.data, intent) }
}

async function persistTerminalProof(
  client: PoolClient, intent: SubmitOutboxIntent, observation: SubmitTerminalObservation,
): Promise<boolean> {
  if (!isValidApplicationSubmitTerminalObservation(observation)) return false
  const existing = await readTerminalProof(client, intent)
  if (existing.present) return existing.valid
  const data = {
    applicationTaskId: intent.applicationTaskId, userId: intent.userId, jobId: intent.jobId,
    sessionId: intent.sessionId, fillTurnId: intent.fillTurnId, workerTaskId: intent.workerTaskId,
    approvalId: intent.receiptId, receiptId: intent.receiptId, constraintHash: intent.constraintHash,
    terminalState: observation.terminalState, attemptsMade: observation.attemptsMade, attempts: observation.attempts,
  }
  const inserted = await client.query(`INSERT INTO "application_task_events" ("id", "taskId", "type", "actor", "body", "data", "createdAt")
    VALUES ('evt_' || md5(random()::text || clock_timestamp()::text), $1, 'submission_terminal_observed', 'worker',
      'Worker observed a final terminal submit delivery', $2::jsonb, NOW())`, [intent.applicationTaskId, JSON.stringify(data)])
  return inserted.rowCount === 1
}

async function observedTerminalJob(queue: SubmitOutboxQueue, intent: SubmitOutboxIntent): Promise<SubmitTerminalObservation | null> {
  const job = await queue.getJob(intent.workerTaskId)
  if (!job || job.id !== intent.workerTaskId || !matchesSubmitJobPayload(job.data, intent)) return null
  const attempts = job.opts.attempts ?? 1, attemptsMade = job.attemptsMade
  const state = await job.getState()
  if (state !== "completed" && (state !== "failed" || attemptsMade < attempts)) return null
  return { terminalState: state, attemptsMade, attempts }
}

async function removeTerminalJobAfterProof(
  queue: SubmitOutboxQueue, intent: SubmitOutboxIntent,
): Promise<"removed" | "absent" | "deferred" | "mismatch"> {
  const job = await queue.getJob(intent.workerTaskId)
  if (!job) return "absent"
  if (job.id !== intent.workerTaskId || !matchesSubmitJobPayload(job.data, intent)) return "mismatch"
  const state = await job.getState()
  if (state !== "completed" && (state !== "failed" || job.attemptsMade < (job.opts.attempts ?? 1))) return "deferred"
  if (await (await queue.client).get(queue.toKey(`${intent.workerTaskId}:lock`)) !== null) return "deferred"
  await job.remove()
  return "removed"
}

async function terminalAttemptDisposition(client: PoolClient, intent: SubmitOutboxIntent): Promise<"claimed" | "uncertain" | "final" | "stale"> {
  const task = (await client.query<{ status: string; checkpoint: string | null }>(`SELECT "status", "checkpoint" FROM "application_tasks"
    WHERE "id" = $1 AND "userId" = $2 AND "jobId" = $3 AND "sessionId" = $4 AND "fillTurnId" = $5 AND "workerTaskId" = $6 FOR UPDATE`,
  [intent.applicationTaskId, intent.userId, intent.jobId, intent.sessionId, intent.fillTurnId, intent.workerTaskId])).rows[0]
  if (!task) return "stale"
  if (task.status === "filling" && ["browser_active", "submission_request_started"].includes(task.checkpoint ?? "")) return "claimed"
  if (task.status === "waiting_for_user" && task.checkpoint === "submission_uncertain") return "uncertain"
  if (["submitted", "failed"].includes(task.status) || task.status === "waiting_for_authorization" && task.checkpoint === "form_filled" ||
    task.status === "waiting_for_user" && ["submission_blocked", "user_takeover"].includes(task.checkpoint ?? "") ||
    task.status === "cancelled" && task.checkpoint === "turn_stopped_before_submit") return "final"
  return "stale"
}

export async function reconcileClaimedTerminalSubmit(
  pool: Pool, queue: SubmitOutboxQueue, intent: SubmitOutboxIntent, observed?: SubmitTerminalObservation,
): Promise<SubmitDeliveryState | "reconciled" | "unchanged"> {
  // A missing queue record is not terminal evidence by itself; the attempt fence must find proof.
  const delivery = await inspectSubmitDelivery(queue, intent, true)
  if (delivery !== "terminal" && delivery !== "absent") return delivery
  const identity: ApplicationSubmitIdentity = {
    applicationTaskId: intent.applicationTaskId, userId: intent.userId, jobId: intent.jobId,
    sessionId: intent.sessionId, fillTurnId: intent.fillTurnId,
    approvalId: intent.receiptId, constraintHash: intent.constraintHash,
  }
  let fencedDelivery: SubmitDeliveryState | undefined
  let terminalOutcomeDurable = false
  const reconciled = await reconcileClaimedSubmissionUncertain(pool, identity, intent.workerTaskId, async client => {
    fencedDelivery = await inspectSubmitDelivery(queue, intent, true)
    if (fencedDelivery !== "terminal" && fencedDelivery !== "absent") return false
    const disposition = await terminalAttemptDisposition(client, intent)
    if (disposition === "final") { terminalOutcomeDurable = true; return false }
    if (disposition === "stale") return false
    if (fencedDelivery === "absent") {
      terminalOutcomeDurable = observed
        ? await persistTerminalProof(client, intent, observed)
        : (await readTerminalProof(client, intent)).valid
      return terminalOutcomeDurable
    }
    const terminal = await observedTerminalJob(queue, intent)
    terminalOutcomeDurable = disposition === "uncertain" && !terminal && !observed
      ? (await readTerminalProof(client, intent)).valid
      : terminal ? await persistTerminalProof(client, intent, terminal)
      : observed ? await persistTerminalProof(client, intent, observed) : false
    return terminalOutcomeDurable
  })
  if (terminalOutcomeDurable) {
    const removal = await removeTerminalJobAfterProof(queue, intent)
    if (removal === "mismatch") return "mismatch"
    if (removal === "deferred") return "deferred"
    return "reconciled"
  }
  if (reconciled) return "reconciled"
  return fencedDelivery && fencedDelivery !== "terminal" && fencedDelivery !== "absent" ? fencedDelivery : "unchanged"
}

export async function reconcileTerminalSubmitJob(
  pool: Pool,
  queue: SubmitOutboxQueue,
  job: { id?: string; data: ApplyTaskPayload; attemptsMade?: number; opts?: { attempts?: number } } | undefined,
  terminalState?: "completed" | "failed",
): Promise<void> {
  if (!job || typeof job.id !== "string" || !job.id || job.data.operation !== "submit") return
  const submitPayload = job.data
  if (!matchesApplyTaskSubmitPayload(submitPayload, submitPayload) || !/^[a-f0-9]{64}$/.test(submitPayload.constraintHash)) return
  const attemptsMade = job.attemptsMade ?? 0, attempts = job.opts?.attempts ?? 1
  if (terminalState === "failed" && attemptsMade < attempts) return
  const observed = terminalState ? { terminalState, attemptsMade, attempts } : undefined
  await reconcileClaimedTerminalSubmit(pool, queue, {
    ...submitPayload,
    workerTaskId: job.id,
    submitPayload,
  }, observed)
}
