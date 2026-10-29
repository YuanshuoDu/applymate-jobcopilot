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
  waitId: "wait-1", stepId: `task:child-1:step:4:attempt:2`, attempt: 2, ordinal: 4, toolCallId: "old-provider-call", sourceItemId: "old-result",
  input: { idempotencyKey: "wait-key", taskIds: ["leaf-a", "leaf-b"], mode: "all", timeoutMs: 5_000 },
  output: { waitId: "wait-1", status: "ready", taskIds: ["leaf-a", "leaf-b"], matchedTaskIds: ["leaf-a", "leaf-b"] },
  continuationStepId: `task:child-1:step:5:attempt:2`, continuationOrdinal: 9,
}

function fixture(options: { claimed?: boolean; extraCall?: boolean; orphanResult?: boolean; orphanStartedEvent?: boolean;
  modelCallCount?: number; completedCallWithoutEvent?: boolean; missingItemStarted?: boolean; completeLifecycle?: boolean;
  modelCost?: number; storedCost?: number } = {}) {
  const calls: Row[] = [], results: Row[] = [], events: Row[] = []
  const stepId = wait.continuationStepId!, claimKey = `task:${lease.id}:event:${childWaitClaimEventKey(wait.attempt, stepId)}`
  const step = { id: stepId, status: options.completeLifecycle ? "completed" : "streaming", attempt: wait.attempt, ordinal: wait.continuationOrdinal,
    inputTokens: options.completeLifecycle ? 37 : 0, outputTokens: options.completeLifecycle ? 13 : 0,
    estimatedCostUsd: options.storedCost ?? 0 }
  const start = { id: "model-started", sequence: "1", sessionId: lease.sessionId, turnId: lease.turnId, taskId: lease.id,
    itemId: null, type: "model.started", actor: "subagent", correlationId: stepId, causationId: null,
    idempotencyKey: `task:${lease.id}:event:model-started:${stepId}`, payload: { taskId: lease.id, provider: "fixture", model: "fixture-model" } }
  const complete = { id: "model-completed", sequence: "2", sessionId: lease.sessionId, turnId: lease.turnId, taskId: lease.id,
    itemId: null, type: "model.completed", actor: "subagent", correlationId: stepId, causationId: start.id,
    idempotencyKey: `task:${lease.id}:event:model-completed:${stepId}`, payload: { taskId: lease.id, provider: "fixture", model: "fixture-model", toolCallCount: options.modelCallCount ?? 1 } }
  const usage = { id: "model-usage", sequence: "3", sessionId: lease.sessionId, turnId: lease.turnId, taskId: lease.id,
    itemId: null, type: "model.usage", actor: "subagent", correlationId: stepId, causationId: complete.id,
    idempotencyKey: `task:${lease.id}:event:model-usage:${stepId}`, payload: { taskId: lease.id, provider: "fixture", model: "fixture-model",
      usage: { inputTokens: 37, outputTokens: 13, estimatedCostUsd: options.modelCost ?? 0.0042 } } }
  events.push(start, complete, usage)
  function addCall(callId: string, isClaimed: boolean): void {
    const id = `task:${lease.id}:item:tool-call:${callId}:attempt:${wait.attempt}`
    const started = { id: `event-${callId}-item-started`, sequence: String(events.length + 1), sessionId: lease.sessionId, turnId: lease.turnId, taskId: lease.id,
      itemId: id, type: "item.started", actor: "subagent", correlationId: stepId, causationId: usage.id,
      idempotencyKey: `task:${lease.id}:event:item-started:${id}`, payload: { itemId: id, type: "tool_call", phase: null } }
    const status = options.completedCallWithoutEvent || options.completeLifecycle ? "completed" : "started", revision = status === "completed" ? 1 : 0
    calls.push({ id, status, revision, content: { toolCallId: callId, toolName: "wait_subagents", toolVersion: "1", input: wait.input,
      ...(status === "completed" ? { status, errorCode: null } : {}) },
      stepId, attempt: wait.attempt, ordinal: wait.continuationOrdinal })
    if (!options.missingItemStarted) events.push(started)
    let claimEvent: Row | undefined
    if (isClaimed) {
      claimEvent = { id: `event-${callId}-claim`, sequence: String(events.length + 1), sessionId: lease.sessionId, turnId: lease.turnId, taskId: lease.id,
      itemId: id, type: "tool_call.started", actor: "subagent", correlationId: callId, causationId: started.id, idempotencyKey: claimKey,
      payload: { toolCallId: callId, toolName: "wait_subagents", taskId: lease.id } }
      events.push(claimEvent)
    }
    if (options.completeLifecycle) {
      const completeItem: Row = { id: `event-${callId}-item-completed`, sequence: String(events.length + 1), sessionId: lease.sessionId,
        turnId: lease.turnId, taskId: lease.id, itemId: id, type: "item.completed", actor: "subagent", correlationId: id,
        causationId: claimEvent!.id, idempotencyKey: `task:${lease.id}:event:tool-call-completed:${callId}:${id}:1`,
        payload: { itemId: id, status: "completed", content: { toolCallId: callId, toolName: "wait_subagents", toolVersion: "1",
          input: wait.input, status: "completed", errorCode: null } } }
      events.push(completeItem)
      const finished: Row = { id: `event-${callId}-tool-finished`, sequence: String(events.length + 1), sessionId: lease.sessionId,
        turnId: lease.turnId, taskId: lease.id, itemId: id, type: "tool_call.completed", actor: "subagent", correlationId: callId,
        causationId: completeItem.id, idempotencyKey: `task:${lease.id}:event:tool-finished:${callId}`,
        payload: { toolCallId: callId, toolName: "wait_subagents", status: "completed", errorCode: null, taskId: lease.id } }
      events.push(finished)
      const resultId = `task:${lease.id}:item:tool-result:${callId}:attempt:${wait.attempt}`
      results.push({ id: resultId, status: "completed", revision: 1, content: { toolCallId: callId, output: wait.output, errorCode: null }, stepId })
      const resultStart: Row = { id: `event-${callId}-result-started`, sequence: String(events.length + 1), sessionId: lease.sessionId,
        turnId: lease.turnId, taskId: lease.id, itemId: resultId, type: "item.started", actor: "subagent", correlationId: stepId,
        causationId: finished.id, idempotencyKey: `task:${lease.id}:event:item-started:${resultId}`,
        payload: { itemId: resultId, type: "tool_result", phase: null } }
      events.push(resultStart)
      events.push({ id: `event-${callId}-result-completed`, sequence: String(events.length + 1), sessionId: lease.sessionId,
        turnId: lease.turnId, taskId: lease.id, itemId: resultId, type: "item.completed", actor: "subagent", correlationId: resultId,
        causationId: resultStart.id, idempotencyKey: `task:${lease.id}:event:tool-result-completed:${callId}:${resultId}:1`,
        payload: { itemId: resultId, status: "completed", content: { toolCallId: callId, output: wait.output, errorCode: null } } })
    }
    if (options.orphanStartedEvent && !isClaimed) events.push({ id: `event-${callId}-alternate-start`, sequence: String(events.length + 1), sessionId: lease.sessionId,
      turnId: lease.turnId, taskId: lease.id, itemId: id, type: "tool_call.started", actor: "subagent", correlationId: callId,
      causationId: started.id, idempotencyKey: `task:${lease.id}:event:tool-started:${callId}`,
      payload: { toolCallId: callId, toolName: "wait_subagents", taskId: lease.id } })
    if (options.orphanResult && !isClaimed) results.push({ id: `task:${lease.id}:item:tool-result:${callId}:attempt:${wait.attempt}`,
      status: "started", revision: 0, content: { toolCallId: callId, output: wait.output, errorCode: null }, stepId })
  }
  const callId = "provider-call"
  addCall(callId, options.claimed ?? false)
  if (options.extraCall) addCall("second-provider-call", false)
  const client = { async query(sql: string) {
    if (sql.includes('FROM "agent_steps" AS step')) return { rows: [step], rowCount: 1 }
    if (sql.includes('JOIN "agent_steps" AS step')) return { rows: calls, rowCount: calls.length }
    if (sql.includes('item."type" = \'tool_result\'')) return { rows: results, rowCount: results.length }
    if (sql.includes('FROM "agent_events" AS event')) return { rows: events, rowCount: events.length }
    throw new Error(`unexpected query: ${sql}`)
  } }
  return { client, calls, results, events, step, claimKey, callId, claimedId: `task:${lease.id}:item:tool-call:${callId}:attempt:${wait.attempt}` }
}

describe("child resume wait-call recovery", () => {
  it("classifies a single complete preclaim orphan and carries logical ordinal plus usage", async () => {
    const fake = fixture()
    await expect(loadChildWaitCallRecovery(fake.client as never, lease, wait)).resolves.toMatchObject({
      orphanCallIds: [fake.callId], orphan: { call: { id: fake.callId }, stepOrdinal: 5, stepStatus: "streaming",
        modelUsage: { inputTokens: 37, outputTokens: 13, estimatedCostUsd: 0.0042 } },
    })
  })

  it("validates the stable claim against its receipt and preserves its original call ID", async () => {
    const fake = fixture({ claimed: true })
    const restored = await loadChildWaitCallRecovery(fake.client as never, lease, wait)
    expect(restored?.claim).toMatchObject({
      call: { id: fake.callId, name: "wait_subagents" }, claimEventId: `event-${fake.callId}-claim`,
      callItem: { status: "started", revision: 0 }, stepOrdinal: 5, modelUsage: { inputTokens: 37, outputTokens: 13 },
    })
    expect(restored?.orphanCallIds).toEqual([])
  })

  it("accepts the exact claim cut where the call row completed before its completion event", async () => {
    const fake = fixture({ claimed: true, completedCallWithoutEvent: true })
    const restored = await loadChildWaitCallRecovery(fake.client as never, lease, wait)
    expect(restored?.claim).toMatchObject({
      call: { id: fake.callId }, claimEventId: `event-${fake.callId}-claim`,
      callItem: { status: "completed", revision: 1 }, stepStatus: "streaming",
    })
    expect(fake.events.some(event => event.type === "item.completed" && event.itemId === fake.claimedId)).toBe(false)
  })

  it("matches a completed step against the PostgreSQL-rounded receipt cost", async () => {
    const fake = fixture({ claimed: true, completeLifecycle: true, modelCost: 0.123456789, storedCost: 0.12345679 })
    const restored = await loadChildWaitCallRecovery(fake.client as never, lease, wait)
    expect(restored?.claim?.modelUsage.estimatedCostUsd).toBe(0.123456789)
  })

  it("fails closed when completed-step cost differs or receipt cost overflows the database type", async () => {
    const mismatch = fixture({ claimed: true, completeLifecycle: true, modelCost: 0.123456789, storedCost: 0.12345678 })
    await expect(loadChildWaitCallRecovery(mismatch.client as never, lease, wait)).rejects.toThrow("child_resume_wait_tool_call_conflict")
    const overflow = fixture({ modelCost: 9999.999999995 })
    await expect(loadChildWaitCallRecovery(overflow.client as never, lease, wait)).rejects.toThrow("child_resume_wait_tool_call_conflict")
  })

  it.each([
    ["multiple provider calls despite a claim", { claimed: true, extraCall: true }],
    ["multiple unclaimed provider calls", { extraCall: true }],
    ["orphan result", { orphanResult: true }],
    ["unkeyed start event", { orphanStartedEvent: true }],
    ["multi-call model receipt", { modelCallCount: 2 }],
    ["completed call without its unique claim", { completedCallWithoutEvent: true }],
    ["preclaim call item without item.started event", { missingItemStarted: true }],
  ] as const)("fails closed for %s", async (_name, options) => {
    const fake = fixture(options)
    await expect(loadChildWaitCallRecovery(fake.client as never, lease, wait)).rejects.toThrow("child_resume_wait_tool_call_conflict")
  })
})
