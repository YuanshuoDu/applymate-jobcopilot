import { describe, expect, it, vi } from "vitest"

import { executeFollowup } from "./coordination-pending-replacement.js"
import type { CoordinationExecutorOptions } from "./coordination-executor-support.js"
import type { FollowupInput } from "./coordination-tools.js"
import type { ToolExecutionContext } from "./types.js"
import type { TaskGraphCommandPort, TaskGraphNativeCommandReceipt } from "../subagents/task-graph-command-port.js"

const context: ToolExecutionContext = {
  scope: { userId: "user" }, sessionId: "session", turnId: "turn", stepId: "step", toolCallId: "tool-call",
  taskId: "root", rootTaskId: "root", actorRole: "orchestrator", signal: new AbortController().signal,
  capabilities: ["canManageChildren"], reportProgress: async () => undefined,
}

const receipt: TaskGraphNativeCommandReceipt = {
  status: "accepted", replay: false, operationId: "operation", requestFingerprint: "a".repeat(64),
  graphRevision: 5, nodeKey: "replacement", dispatchDisposition: "pending",
  child: { taskId: "new-child", rootTaskId: "root", parentTaskId: "root", path: "/root/new-child", depth: 1,
    role: "scout", taskType: "research", status: "queued" },
}

function runtime(appendNativeCoordination: NonNullable<TaskGraphCommandPort["appendNativeCoordination"]>) {
  const getTask = vi.fn(), getSpawnReplay = vi.fn(), spawn = vi.fn(), appendActivity = vi.fn(async () => undefined)
  const options = {
    manager: { spawn, close: vi.fn() },
    store: { getTask, getSpawnReplay, appendActivity },
    nativeCoordination: {
      enabled: true, commandPort: { appendNativeCoordination } as unknown as TaskGraphCommandPort,
      turnLeaseOwner: "turn-owner", turnLeaseVersion: 7, parentLeaseOwner: "root-owner", parentAttemptCount: () => 2,
    },
  } as unknown as CoordinationExecutorOptions
  return { options, getTask, getSpawnReplay, spawn, appendActivity }
}

describe("native pending-task replacement executor", () => {
  it("forwards the exact replacement command and returns the durable receipt without legacy lookups", async () => {
    type NativeInput = Parameters<NonNullable<TaskGraphCommandPort["appendNativeCoordination"]>>[0]
    const append = vi.fn(async (_input: NativeInput) => receipt)
    const runtimeState = runtime(append)
    const input: FollowupInput = {
      taskId: "queued-source", idempotencyKey: "replace-key", goal: "Recheck the missing evidence",
      context: { note: "preserve caller context" }, mode: "replace_unstarted", expectedRevision: 4,
    }

    const result = await executeFollowup(context, input, runtimeState.options)

    expect(append).toHaveBeenCalledOnce()
    expect(append.mock.calls[0]?.[0].request).toMatchObject({
      kind: "followup", sourceTaskId: input.taskId, goal: input.goal, context: input.context,
      mode: "replace_unstarted", expectedRevision: 4,
    })
    expect(result).toMatchObject({
      taskId: receipt.child.taskId, sourceTaskId: input.taskId, rootTaskId: "root", replay: false,
      nativeCoordination: { operationKind: "followup", operationId: receipt.operationId, graphRevision: 5 },
    })
    expect(runtimeState.getTask).not.toHaveBeenCalled()
    expect(runtimeState.getSpawnReplay).not.toHaveBeenCalled()
    expect(runtimeState.spawn).not.toHaveBeenCalled()
    expect(runtimeState.appendActivity).toHaveBeenCalledOnce()
  })

  it("fails closed outside the enabled planner root before reading or mutating legacy state", async () => {
    type NativeInput = Parameters<NonNullable<TaskGraphCommandPort["appendNativeCoordination"]>>[0]
    const append = vi.fn(async (_input: NativeInput) => receipt)
    const runtimeState = runtime(append)
    const input: FollowupInput = {
      taskId: "queued-source", idempotencyKey: "replace-child", goal: "Retry", mode: "replace_unstarted", expectedRevision: 4,
    }

    await expect(executeFollowup({ ...context, taskId: "child", actorRole: "subagent" }, input, runtimeState.options))
      .rejects.toMatchObject({ code: "coordination_native_replacement_unavailable" })

    expect(append).not.toHaveBeenCalled()
    expect(runtimeState.getTask).not.toHaveBeenCalled()
    expect(runtimeState.getSpawnReplay).not.toHaveBeenCalled()
    expect(runtimeState.spawn).not.toHaveBeenCalled()
    expect(runtimeState.appendActivity).not.toHaveBeenCalled()
  })
})
