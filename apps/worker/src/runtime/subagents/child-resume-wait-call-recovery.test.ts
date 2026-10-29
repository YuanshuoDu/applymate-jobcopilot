import { describe, expect, it } from "vitest"

import { childWaitClaimEventKey } from "./child-durable-wait-replay.js"
import { loadChildWaitCallRecovery } from "./child-resume-wait-call-recovery.js"
import type { DurableWaitResume } from "./child-resume-observations.js"
import type { SubagentLease } from "./types.js"

type Row = Record<string, unknown>
const lease: SubagentLease = {
  id: "child-1", userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1",
  path: "/root-1/child-1", depth: 2, role: "scout", taskType: "research", status: "running", goal: "", constraints: [], successCriteria: [],
  allowedActions: ["wait_subagents"], context: {}, expectedOutputSchema: {}, result: null, failureReason: null, attemptCount: 2, maxAttempts: 3,
  leaseOwner: "worker-1", leaseExpiresAt: new Date("2099-01-01T00:00:00.000Z"), interruptRequestedAt: null,
  budgetSnapshot: {}, toolPolicySnapshot: {}, ownerId: "worker-1", signal: new AbortController().signal,
}
const wait: DurableWaitResume = {
  waitId: "wait-1", stepId: "waiting-step", attempt: 2, ordinal: 4, toolCallId: "old-provider-call", sourceItemId: "old-result",
  input: { idempotencyKey: "wait-key", taskIds: ["leaf-a", "leaf-b"], mode: "all", timeoutMs: 5_000 },
  output: { waitId: "wait-1", status: "ready", taskIds: ["leaf-a", "leaf-b"], matchedTaskIds: ["leaf-a", "leaf-b"] },
  continuationStepId: "continuation-step", continuationOrdinal: 9,
}

function fixture(options: { claimed?: boolean; orphanCount?: number; orphanResult?: boolean; orphanStartedEvent?: boolean } = {}) {
  const calls: Row[] = [], results: Row[] = [], events: Row[] = []
  const stepId = wait.continuationStepId!, claimKey = `task:${lease.id}:event:${childWaitClaimEventKey(wait.attempt, stepId)}`
  function addCall(callId: string, isClaimed: boolean): string {
    const id = `task:${lease.id}:item:tool-call:${callId}:attempt:${wait.attempt}`
    const started = { id: `event-${callId}-item-started`, sessionId: lease.sessionId, turnId: lease.turnId, taskId: lease.id,
      itemId: id, type: "item.started", actor: "subagent", correlationId: stepId, causationId: null,
      idempotencyKey: `task:${lease.id}:event:item-started:${id}`, payload: { itemId: id, type: "tool_call", phase: null } }
    calls.push({ id, status: "started", revision: 0, content: { toolCallId: callId, toolName: "wait_subagents", toolVersion: "1", input: wait.input },
      stepId, attempt: wait.attempt, ordinal: wait.continuationOrdinal })
    events.push(started)
    if (isClaimed) events.push({ id: `event-${callId}-claim`, sessionId: lease.sessionId, turnId: lease.turnId, taskId: lease.id,
      itemId: id, type: "tool_call.started", actor: "subagent", correlationId: callId, causationId: started.id, idempotencyKey: claimKey,
      payload: { toolCallId: callId, toolName: "wait_subagents", taskId: lease.id } })
    if (options.orphanStartedEvent && !isClaimed) events.push({ id: `event-${callId}-alternate-start`, sessionId: lease.sessionId,
      turnId: lease.turnId, taskId: lease.id, itemId: id, type: "tool_call.started", actor: "subagent", correlationId: callId,
      causationId: started.id, idempotencyKey: `task:${lease.id}:event:tool-started:${callId}`,
      payload: { toolCallId: callId, toolName: "wait_subagents", taskId: lease.id } })
    if (options.orphanResult && !isClaimed) results.push({ id: `task:${lease.id}:item:tool-result:${callId}:attempt:${wait.attempt}`,
      status: "started", revision: 0, content: { toolCallId: callId, output: wait.output, errorCode: null }, stepId })
    return id
  }
  const claimedId = options.claimed === false ? undefined : "claimed-call"
  const orphanIds: string[] = []
  if (claimedId) addCall(claimedId, true)
  for (let index = 0; index < (options.orphanCount ?? (claimedId ? 0 : 1)); index += 1) {
    const callId = `orphan-call-${index + 1}`
    orphanIds.push(callId)
    addCall(callId, false)
  }
  const client = { async query(sql: string) {
    if (sql.includes('JOIN "agent_steps" AS step')) return { rows: calls, rowCount: calls.length }
    if (sql.includes('item."type" = \'tool_result\'')) return { rows: results, rowCount: results.length }
    if (sql.includes('FROM "agent_events" AS event')) return { rows: events, rowCount: events.length }
    throw new Error(`unexpected query: ${sql}`)
  } }
  return { client, calls, results, events, claimKey, claimedId, orphanIds }
}

describe("child resume wait-call recovery", () => {
  it("classifies one complete preclaim orphan without claiming or counting it", async () => {
    const fake = fixture({ claimed: false })
    await expect(loadChildWaitCallRecovery(fake.client as never, lease, wait)).resolves.toEqual({ orphanCallIds: fake.orphanIds })
  })

  it("recovers only the stable claimed call when a preclaim orphan coexists", async () => {
    const fake = fixture({ orphanCount: 1 })
    const restored = await loadChildWaitCallRecovery(fake.client as never, lease, wait)
    expect(restored?.claim).toMatchObject({
      call: { id: fake.claimedId, name: "wait_subagents" }, claimEventId: `event-${fake.claimedId}-claim`,
      callItem: { status: "started", revision: 0 },
    })
    expect(restored?.orphanCallIds).toEqual(fake.orphanIds)
  })

  it.each([
    ["multiple orphans", { claimed: false, orphanCount: 2 }],
    ["orphan result", { orphanCount: 1, orphanResult: true }],
    ["unkeyed start event", { claimed: false, orphanStartedEvent: true }],
  ] as const)("fails closed for %s", async (_name, options) => {
    const fake = fixture(options)
    await expect(loadChildWaitCallRecovery(fake.client as never, lease, wait)).rejects.toThrow("child_resume_wait_tool_call_conflict")
  })
})
