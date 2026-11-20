import { describe, expect, it, vi } from "vitest"

import type { AgentTreeManager } from "../subagents/manager.js"
import { TaskGraphCommandError, type TaskGraphCommandPort } from "../subagents/task-graph-command-port.js"
import { restoreToolCallState } from "../turns/persisted-tool-call-state.js"
import {
  TASK_GRAPH_SUPERSEDED_SCOUT_RETIREMENT_SCHEMA_VERSION,
  type TaskGraphScoutRetirementInput,
  type TaskGraphScoutRetirementResult,
  type TaskGraphSupersededScoutRetirementReceipt,
} from "../subagents/task-graph-scout-retirement-contract.js"
import { ToolRegistry } from "./registry.js"
import {
  createTaskGraphSupersededScoutRetirementTool,
} from "./task-graph-retire-superseded-scout.js"
import { InMemoryToolLifecycleSink, ToolLifecycle, type LifecycleCall } from "./lifecycle.js"
import type { ToolExecutionContext } from "./types.js"

const phoneLikeChildId = "subagent-00000000-0000-4000-8000-000000000001"

function receipt(overrides: Partial<TaskGraphSupersededScoutRetirementReceipt> = {}, taskId = "scout-1"): TaskGraphSupersededScoutRetirementReceipt {
  return {
    schemaVersion: TASK_GRAPH_SUPERSEDED_SCOUT_RETIREMENT_SCHEMA_VERSION,
    sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", nodeKey: "old-scout", taskId,
    attempt: 2, interruptRequestedAt: "2026-11-19T10:00:00.000Z", graphRevision: 4, acceptedPlanRevision: 3,
    acceptedSteerSequence: "8", reconciliationStepId: "step-reconcile", reconciliationThroughSequence: "9",
    reconciliationEventId: "event-reconcile", reconciliationEventSequence: "11",
    reconciliationIdempotencyKey: `agent.plan.reconciliation:sha256:${"a".repeat(64)}`,
    planEventId: "event-plan", planEventSequence: "10", planIdempotencyKey: `task-graph-${"b".repeat(64)}:proposal:4`,
    replacementNodeKey: "new-scout", replacementTaskId: "scout-2", replacementSourceSequence: "8",
    ...overrides,
  }
}

function fixture(status: "requested" | "duplicate" = "requested", targetTaskId = "scout-1") {
  const order: string[] = []
  const requestSupersededScoutRetirement = vi.fn(async (input: TaskGraphScoutRetirementInput): Promise<TaskGraphScoutRetirementResult> => {
    order.push("port")
    expect(input).toMatchObject({ expectedRevision: 4, taskId: targetTaskId, callId: "call-1" })
    return { status, taskId: targetTaskId, receiptEventId: "private-event-id", receipt: receipt({}, targetTaskId) }
  })
  const commandPort = { requestSupersededScoutRetirement } as unknown as TaskGraphCommandPort
  const signalTaskSubtree = vi.fn(() => { order.push("signal") })
  const manager = { signalTaskSubtree } as unknown as AgentTreeManager
  const options = { commandPort, manager, turnLeaseOwner: "turn-owner", turnLeaseVersion: 3,
    parentLeaseOwner: "root-owner", parentAttemptCount: () => 1 }
  const context: ToolExecutionContext = {
    scope: { userId: "user-1" }, sessionId: "session-1", turnId: "turn-1", stepId: "step-1",
    taskId: "root-1", rootTaskId: "root-1", toolCallId: "call-1", signal: new AbortController().signal,
    capabilities: ["coordination", "canManageChildren"], reportProgress: async () => undefined,
  }
  return { options, context, requestSupersededScoutRetirement, signalTaskSubtree, order, targetTaskId }
}

function lifecycleCall(context: ToolExecutionContext): LifecycleCall {
  return { id: context.toolCallId!, toolName: "agent.retire_superseded_scout", toolVersion: "1",
    sessionId: context.sessionId, turnId: context.turnId, stepId: context.stepId,
    taskId: context.taskId, rootTaskId: context.rootTaskId }
}

describe("agent.retire_superseded_scout", () => {
  it("requests only the exact Root-owned target, signals after commit, and returns no private receipt fields", async () => {
    const state = fixture()
    const tool = createTaskGraphSupersededScoutRetirementTool(state.options)
    const output = await tool.execute(state.context, { expectedRevision: 4, taskId: "scout-1" })

    expect(output).toEqual({ status: "interrupt_requested", taskId: "scout-1", attempt: 2 })
    expect(state.order).toEqual(["port", "signal"])
    expect(state.signalTaskSubtree).toHaveBeenCalledWith("session-1", "root-1", ["scout-1"])
    expect(JSON.stringify(output)).not.toContain("private-event-id")
    expect(output).not.toHaveProperty("acceptedSteerSequence")
  })

  it.each([
    ["requested", "interrupt_requested"],
    ["duplicate", "already_requested"],
  ] as const)("preserves the verified phone-like task ID through lifecycle and persisted Root replay for %s", async (portStatus, outputStatus) => {
    const state = fixture(portStatus, phoneLikeChildId)
    const output = await createTaskGraphSupersededScoutRetirementTool(state.options).execute(state.context,
      { expectedRevision: 4, taskId: phoneLikeChildId })
    const call = lifecycleCall(state.context), sink = new InMemoryToolLifecycleSink(), lifecycle = new ToolLifecycle({ sink })
    const expected = { taskId: phoneLikeChildId, status: outputStatus, attempt: 2 }
    await lifecycle.started(call, { expectedRevision: 4, taskId: phoneLikeChildId })
    const returned = await lifecycle.completed(call, output)
    expect(returned).toEqual(expected)
    const completed = sink.events.at(-1)!
    expect(completed.item).toMatchObject({ type: "tool_result", output: expected })
    expect(completed.payload.output).toEqual(expected)

    const restored = restoreToolCallState([
      { id: "call-item", stepId: call.stepId, type: "tool_call", status: "completed", revision: 1,
        content: { toolCallId: call.id, toolName: call.toolName, toolVersion: call.toolVersion, status: "completed", input: { expectedRevision: 4, taskId: phoneLikeChildId } } },
      { id: "result-item", stepId: call.stepId, type: "tool_result", status: "completed", revision: 1,
        content: { toolCallId: call.id, output: completed.payload.output, errorCode: null } },
    ], [{ type: completed.eventType, payload: completed.payload }])
    expect(restored.observations[0]?.content.output).toEqual(expected)
  })

  it("reports an idempotent replay as already requested and rejects mismatched receipts without signaling", async () => {
    const replay = fixture("duplicate")
    await expect(createTaskGraphSupersededScoutRetirementTool(replay.options).execute(replay.context,
      { expectedRevision: 4, taskId: "scout-1" })).resolves.toMatchObject({ status: "already_requested" })
    expect(replay.signalTaskSubtree).toHaveBeenCalledOnce()

    const invalid = fixture()
    invalid.requestSupersededScoutRetirement.mockResolvedValueOnce({ status: "requested", taskId: "scout-1",
      receiptEventId: "private-event-id", receipt: receipt({ taskId: "foreign-task" }) })
    await expect(createTaskGraphSupersededScoutRetirementTool(invalid.options).execute(invalid.context,
      { expectedRevision: 4, taskId: "scout-1" })).rejects.toMatchObject({
        code: "task_graph_scout_retirement_receipt_invalid",
      })
    expect(invalid.signalTaskSubtree).not.toHaveBeenCalled()
  })

  it("keeps the committed acknowledgement when the best-effort local signal throws", async () => {
    const state = fixture()
    state.signalTaskSubtree.mockImplementationOnce(() => { throw new Error("local signal unavailable") })
    await expect(createTaskGraphSupersededScoutRetirementTool(state.options).execute(state.context,
      { expectedRevision: 4, taskId: "scout-1" })).resolves.toEqual({
      status: "interrupt_requested", taskId: "scout-1", attempt: 2,
    })
    expect(state.requestSupersededScoutRetirement).toHaveBeenCalledOnce()
  })

  it("keeps stale and unavailable failures typed and bounded", async () => {
    const stale = fixture()
    stale.requestSupersededScoutRetirement.mockRejectedValueOnce(new TaskGraphCommandError("revision_mismatch", "unsafe", 5))
    await expect(createTaskGraphSupersededScoutRetirementTool(stale.options).execute(stale.context,
      { expectedRevision: 4, taskId: "scout-1" })).rejects.toMatchObject({
        code: "revision_mismatch", safeOutput: { code: "revision_mismatch", currentRevision: 5 },
      })

    const unavailable = fixture()
    const noPort = { ...unavailable.options, commandPort: {} as TaskGraphCommandPort }
    await expect(createTaskGraphSupersededScoutRetirementTool(noPort).execute(unavailable.context,
      { expectedRevision: 4, taskId: "scout-1" })).rejects.toMatchObject({
        code: "task_graph_scout_retirement_unavailable",
      })
  })

  it("rejects an invalid port status before signaling", async () => {
    const state = fixture()
    state.requestSupersededScoutRetirement.mockResolvedValueOnce({
      status: "finished", taskId: "scout-1", receiptEventId: "private-event-id", receipt: receipt(),
    } as unknown as TaskGraphScoutRetirementResult)
    await expect(createTaskGraphSupersededScoutRetirementTool(state.options).execute(state.context,
      { expectedRevision: 4, taskId: "scout-1" })).rejects.toMatchObject({ code: "task_graph_scout_retirement_receipt_invalid" })
    expect(state.signalTaskSubtree).not.toHaveBeenCalled()
  })

  it("exposes an exact bounded target and revision input", () => {
    const state = fixture()
    const registry = new ToolRegistry([createTaskGraphSupersededScoutRetirementTool(state.options)])
    expect(registry.validateArguments("agent.retire_superseded_scout", {
      expectedRevision: 4, taskId: "scout-1",
    })).toBe(true)
    expect(registry.validateArguments("agent.retire_superseded_scout", {
      expectedRevision: 4, taskId: "scout-1", userId: "forged",
    })).not.toBe(true)
    expect(registry.validateArguments("agent.retire_superseded_scout", {
      expectedRevision: -1, taskId: "scout-1",
    })).not.toBe(true)
  })
})
