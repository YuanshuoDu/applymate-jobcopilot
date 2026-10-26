import { isSessionPauseRequestedError } from "../session-gate.js"
import { SubagentLeaseError } from "./types.js"
import type { SubagentExecutionResult, SubagentFinishResult, SubagentJobPayload, SubagentLease, SubagentMailboxContinuation, SubagentStore } from "./types.js"

const MAX_MAILBOX_CONTINUATIONS = 3
const MAX_PENDING_MESSAGE_IDS = 20

function uniqueIds(ids: readonly string[] | undefined): string[] {
  return [...new Set((ids ?? []).filter(id => typeof id === "string" && id.trim().length > 0))]
}

function pendingIds(result: SubagentFinishResult): readonly string[] | undefined {
  return typeof result === "object" && result.status === "input_pending" ? result.messageIds : undefined
}

export type SubagentRunOutcome = {
  taskId: string
  status: "completed" | "retrying" | "failed" | "waiting" | "waiting_for_user" | "interrupted" | "skipped" | "lease_lost"
  reason?: string
}

export async function runClaimedSubagent(
  store: Pick<SubagentStore, "finish" | "release">,
  payload: SubagentJobPayload,
  lease: SubagentLease,
  active: { lost: Promise<SubagentLeaseError>; interrupted: boolean },
  execute: (input: { lease: SubagentLease; continuation?: SubagentMailboxContinuation }) => Promise<SubagentExecutionResult>,
  now: () => Date,
  dispose: () => void,
): Promise<SubagentRunOutcome> {
  try {
    const observed = new Set<string>()
    let continuation: SubagentMailboxContinuation | undefined
    let continuationCount = 0
    let result: SubagentExecutionResult
    while (true) {
      try {
        if (lease.signal.aborted) throw new SubagentLeaseError("lost", "Subagent lease was lost")
        result = await Promise.race([
          execute(continuation ? { lease, continuation } : { lease }),
          active.lost.then(error => { throw error }),
        ])
      } catch (error: unknown) {
        if (isSessionPauseRequestedError(error)) {
          const released = await store.release?.({ taskId: payload.taskId, sessionId: payload.sessionId, ownerId: payload.ownerId, attemptCount: lease.attemptCount, now: now() }).catch(() => false)
          return { taskId: payload.taskId, status: released ? "retrying" : "skipped", reason: "session_pause_requested" }
        }
        if (error instanceof SubagentLeaseError) {
          if (!active.interrupted) return { taskId: payload.taskId, status: "lease_lost", reason: error.message }
          return await finishInterrupted(store, payload, lease, error, now())
        }
        const failureReason = error instanceof Error ? error.message : "Subagent execution failed"
        result = {
          status: "failed",
          failureReason: failureReason === "child_resume_unavailable" || failureReason === "child_resume_evidence_unavailable"
            ? "Subagent execution failed"
            : failureReason,
        }
      }
      for (const id of uniqueIds(result.mailboxMessageIds)) observed.add(id)
      if (continuation && result.status === "failed") {
        result = { ...result, failureReason: result.failureReason ?? "subagent_mailbox_continuation_failed", retryDisposition: "terminal" }
      } else if (continuation && result.status === "completed" && !continuation.missingMessageIds.every(id => observed.has(id))) {
        result = { status: "failed", failureReason: "subagent_mailbox_input_unavailable", retryDisposition: "terminal" }
      }
      const finished = await store.finish({
        taskId: payload.taskId, sessionId: payload.sessionId, ownerId: payload.ownerId,
        attemptCount: lease.attemptCount,
        status: result.status, result: result.result, failureReason: result.failureReason, retryDisposition: result.retryDisposition, now: now(),
        ...(result.status === "completed" ? { mailboxMessageIds: [...observed] } : {}),
      })
      if (!finished) return { taskId: payload.taskId, status: "lease_lost", reason: "Subagent lease was fenced" }
      if (typeof finished === "string") return { taskId: payload.taskId, status: finished }
      const rawMissingMessageIds = pendingIds(finished) ?? []
      const missingMessageIds = uniqueIds(rawMissingMessageIds)
      if (result.status !== "completed" || missingMessageIds.length === 0 || missingMessageIds.length !== rawMissingMessageIds.length
        || missingMessageIds.length > MAX_PENDING_MESSAGE_IDS || missingMessageIds.some(id => observed.has(id))) {
        return await finishMailboxFailure(store, payload, lease, "subagent_mailbox_no_progress", now)
      }
      if (continuationCount >= MAX_MAILBOX_CONTINUATIONS) {
        return await finishMailboxFailure(store, payload, lease, "subagent_mailbox_continuation_limit", now)
      }
      continuationCount += 1
      continuation = { kind: "mailbox_input_pending", missingMessageIds: uniqueIds(missingMessageIds), observedMessageIds: [...observed] }
    }
  } finally {
    dispose()
  }
}

async function finishMailboxFailure(
  store: Pick<SubagentStore, "finish">,
  payload: SubagentJobPayload,
  lease: SubagentLease,
  failureReason: string,
  now: () => Date,
): Promise<SubagentRunOutcome> {
  const status = await store.finish({ taskId: payload.taskId, sessionId: payload.sessionId, ownerId: payload.ownerId,
    attemptCount: lease.attemptCount, status: "failed", failureReason, retryDisposition: "terminal", now: now() })
  if (!status) return { taskId: payload.taskId, status: "lease_lost", reason: "Subagent lease was fenced" }
  const finalStatus = status === "retrying" || status === "interrupted" || status === "waiting" || status === "waiting_for_user" ? status : "failed"
  return { taskId: payload.taskId, status: finalStatus, reason: failureReason }
}

export async function finishInterrupted(
  store: Pick<SubagentStore, "finish">,
  payload: SubagentJobPayload,
  lease: SubagentLease,
  error: SubagentLeaseError,
  now: Date,
): Promise<SubagentRunOutcome> {
  const status = await store.finish({
    taskId: payload.taskId, sessionId: payload.sessionId, ownerId: payload.ownerId,
    attemptCount: lease.attemptCount, status: "failed", failureReason: error.message, now,
  })
  if (status !== "interrupted") return { taskId: payload.taskId, status: "lease_lost", reason: status ? "Subagent interruption was fenced" : "Subagent lease was fenced" }
  return { taskId: payload.taskId, status: "interrupted", reason: error.message }
}
