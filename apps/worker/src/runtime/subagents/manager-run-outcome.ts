import { isSessionPauseRequestedError } from "../session-gate.js"
import { SubagentLeaseError } from "./types.js"
import type { SubagentExecutionResult, SubagentJobPayload, SubagentLease, SubagentStore } from "./types.js"

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
  execute: (input: { lease: SubagentLease }) => Promise<SubagentExecutionResult>,
  now: () => Date,
  dispose: () => void,
): Promise<SubagentRunOutcome> {
  try {
    let result: SubagentExecutionResult
    try {
      result = await Promise.race([execute({ lease }), active.lost.then(error => { throw error })])
    } catch (error: unknown) {
      if (isSessionPauseRequestedError(error)) {
        const released = await store.release?.({ taskId: payload.taskId, sessionId: payload.sessionId, ownerId: payload.ownerId, attemptCount: lease.attemptCount, now: now() }).catch(() => false)
        return { taskId: payload.taskId, status: released ? "retrying" : "skipped", reason: "session_pause_requested" }
      }
      if (error instanceof SubagentLeaseError) {
        if (!active.interrupted) return { taskId: payload.taskId, status: "lease_lost", reason: error.message }
        return await finishInterrupted(store, payload, lease, error, now())
      }
      result = { status: "failed", failureReason: error instanceof Error ? error.message : "Subagent execution failed" }
    }
    const status = await store.finish({
      taskId: payload.taskId, sessionId: payload.sessionId, ownerId: payload.ownerId,
      attemptCount: lease.attemptCount,
      status: result.status, result: result.result, failureReason: result.failureReason, retryDisposition: result.retryDisposition, now: now(),
      ...(result.status === "completed" ? { mailboxMessageIds: result.mailboxMessageIds } : {}),
    })
    if (!status) return { taskId: payload.taskId, status: "lease_lost", reason: "Subagent lease was fenced" }
    return { taskId: payload.taskId, status }
  } finally {
    dispose()
  }
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
