import { describe, expect, it } from "vitest"
import type { DurableWaitResume } from "./child-resume-observations.js"
import type { SubagentLease } from "./types.js"
import { buildChildResumeReplayReceipts } from "./child-resume-replay-receipts.js"

type Row = Record<string, unknown>
const callId = "toolcall-historical-1"

function lease(overrides: Partial<SubagentLease> = {}): SubagentLease {
  return { id: "child-1", userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1",
    parentTaskId: "root-1", path: "/root-1/child-1", depth: 1, role: "scout", taskType: "research", status: "running",
    goal: "Find jobs", constraints: [], successCriteria: [], allowedActions: ["jobs.search"], context: {}, expectedOutputSchema: {},
    modelProfileSnapshot: {}, result: null, failureReason: null, attemptCount: 2, maxAttempts: 3, leaseOwner: "worker-1",
    leaseExpiresAt: new Date("2099-09-14T12:00:00.000Z"), interruptRequestedAt: null, budgetSnapshot: {}, toolPolicySnapshot: {},
    ownerId: "worker-1", signal: new AbortController().signal, ...overrides }
}

function pair(overrides: { attempt?: number; stepId?: string; callId?: string; revision?: number } = {}): Row[] {
  const child = lease(), attempt = overrides.attempt ?? 1, stepId = overrides.stepId ?? "step-1", id = overrides.callId ?? callId
  const common = { sessionId: child.sessionId, turnId: child.turnId, taskId: child.id, rootTaskId: child.rootTaskId,
    stepId, attempt, ordinal: 0 }
  return [
    { ...common, id: "call-item", revision: overrides.revision ?? 2, type: "tool_call", status: "completed",
      content: { toolCallId: id, toolName: "jobs.search", input: { query: "Dublin" } } },
    { ...common, id: "result-item", revision: 3, type: "tool_result", status: "completed",
      content: { toolCallId: id, output: { jobs: [] }, errorCode: null } },
  ]
}

describe("child resume replay receipts", () => {
  it("binds terminal tool receipts to exact historical attempt, step, item IDs, and revisions", () => {
    const restored = buildChildResumeReplayReceipts(pair(), lease())
    expect(restored.childToolReplayReceipts).toHaveLength(1)
    expect(restored.childWaitReplayReceipts).toEqual([])
    expect(restored.childToolReplayReceipts[0]).toMatchObject({
      userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", taskId: "child-1",
      attempt: 1, stepId: "step-1", toolCallId: callId, toolName: "jobs.search", callItem: { id: "call-item", revision: 2 },
      resultItem: { id: "result-item", revision: 3 }, result: { status: "completed", output: { jobs: [] }, errorCode: null },
    })
    expect(Object.isFrozen(restored.childToolReplayReceipts[0])).toBe(true)
  })

  it("preserves the source attempt when a provider reuses a call ID across attempts", () => {
    const rows = [...pair({ attempt: 1 }), ...pair({ attempt: 2, stepId: "step-2" }).map((row, index) => ({
      ...row, id: index === 0 ? "call-item-2" : "result-item-2",
    }))]
    const restored = buildChildResumeReplayReceipts(rows, lease(), 0)
    expect(restored.childToolReplayReceipts.map(receipt => [receipt.attempt, receipt.stepId, receipt.resultItem.id]))
      .toEqual([[1, "step-1", "result-item"], [2, "step-2", "result-item-2"]])
  })

  it("leaves incomplete or cross-attempt pairs without replay authority and rejects cross-step bindings", () => {
    const missingRevision = pair().map(row => ({ ...row }))
    delete missingRevision[0]!.revision
    expect(buildChildResumeReplayReceipts(missingRevision, lease()).childToolReplayReceipts).toEqual([])
    const missingOutput = pair().map((row, index) => index ? { ...row, content: { toolCallId: callId, errorCode: null } } : row)
    expect(buildChildResumeReplayReceipts(missingOutput, lease()).childToolReplayReceipts).toEqual([])
    const mismatched = pair().map((row, index) => index ? { ...row, attempt: 2 } : row)
    expect(buildChildResumeReplayReceipts(mismatched, lease(), 0).childToolReplayReceipts).toEqual([])
    const crossStep = pair().map((row, index) => index ? { ...row, stepId: "other-step" } : row)
    expect(() => buildChildResumeReplayReceipts(crossStep, lease())).toThrow("child_resume_tool_call_conflict")
    expect(() => buildChildResumeReplayReceipts(pair().map(row => ({ ...row, sessionId: "other-session" })), lease()))
      .toThrow("child_resume_item_lineage")
  })

  it("keeps durable wait replay in a separate loader-backed receipt with its waiting source result", () => {
    const input = { idempotencyKey: "wait-key", taskIds: ["grandchild-1"], mode: "all", timeoutMs: 5_000 }
    const output = { waitId: "wait-1", status: "ready", taskIds: ["grandchild-1"], deadlineAt: "2099-01-01T00:00:00.000Z",
      matchedTaskIds: ["grandchild-1"], tasks: [{ taskId: "grandchild-1", status: "completed", role: "scout", result: null, failureReason: null }] }
    const rows = pair().map((row, index) => index === 0
      ? { ...row, content: { toolCallId: callId, toolName: "wait_subagents", input } }
      : { ...row, id: "wait-result", content: { toolCallId: callId, output: { ...output, status: "waiting", matchedTaskIds: [] }, errorCode: null } })
    const wait: DurableWaitResume = { waitId: "wait-1", stepId: "step-1", attempt: 1, ordinal: 0, toolCallId: callId,
      sourceItemId: "wait-result", input, output, continuationStepId: "step-2", continuationOrdinal: 1 }
    const restored = buildChildResumeReplayReceipts(rows, lease(), undefined, [wait])
    expect(restored.childToolReplayReceipts).toEqual([])
    expect(restored.childWaitReplayReceipts).toHaveLength(1)
    expect(restored.childWaitReplayReceipts[0]).toMatchObject({ toolCallId: callId, waitId: "wait-1",
      source: { sourceItemId: "wait-result", attempt: 1, continuationStepId: "step-2", continuationOrdinal: 1,
        persistedResult: { status: "completed", output: { status: "waiting" }, errorCode: null } },
      result: { output: { status: "ready", waitId: "wait-1" } } })
  })
})
