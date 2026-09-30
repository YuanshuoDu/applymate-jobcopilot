import type { SubagentJobPayload, SubagentLease, SubagentLeaseError, SubagentStore } from "./types.js"

export type SubagentRunOutcome = {
  taskId: string
  status: "completed" | "retrying" | "failed" | "waiting" | "waiting_for_user" | "interrupted" | "skipped" | "lease_lost"
  reason?: string
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
