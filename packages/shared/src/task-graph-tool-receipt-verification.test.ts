import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"

import {
  TASK_GRAPH_REPLAY_CALL_PREFIX,
  validateTaskGraphReplaySources,
  validateTaskGraphToolEvents,
} from "./task-graph-tool-receipt-verification.js"

const scope = {
  userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1",
  parentTaskId: "parent-1", taskId: "task-1", attemptCount: 2,
}
const tool = { toolName: "agent.search", toolVersion: "v1", input: { query: "roles" } }

function call(id: string, stepId: string, content: Record<string, unknown> = {}) {
  return { id, type: "tool_call", stepId, content: { ...tool, toolCallId: id, status: "completed", errorCode: null, ...content } }
}

function result(callId: string, stepId: string, output: unknown = { count: 2 }) {
  return { id: `${callId}-result`, type: "tool_result", stepId, content: { toolCallId: callId, output, errorCode: null } }
}

function lifecycleEvent(callItemId: string, callId: string, type: string, sequence: number, payload: Record<string, unknown> = {}) {
  return {
    itemId: callItemId, taskId: scope.taskId, correlationId: callId, type, sequence,
    payload: { taskId: scope.taskId, toolCallId: callId, toolName: tool.toolName,
      toolVersion: tool.toolVersion, ...payload },
  }
}

describe("validateTaskGraphToolEvents", () => {
  it("accepts one ordered completed lifecycle and returns its outcome", () => {
    const item = call("call-1", "step-1")
    const events = [
      lifecycleEvent("call-1", "call-1", "tool_call.started", 4, { status: "started" }),
      lifecycleEvent("call-1", "call-1", "tool_call.completed", 5, { status: "completed", errorCode: null }),
    ]

    expect(validateTaskGraphToolEvents(events, [item], scope)).toEqual({
      outcomes: new Map([["call-1", "completed"]]), replays: [],
    })
  })

  it("accepts failed calls only with the matching fixed terminal error", () => {
    const item = call("call-1", "step-1", { status: "failed", errorCode: "tool_unavailable" })
    const events = [
      lifecycleEvent("call-1", "call-1", "tool_call.started", 1, { status: "started" }),
      lifecycleEvent("call-1", "call-1", "tool_call.failed", 2, { status: "failed", errorCode: "tool_unavailable" }),
    ]
    expect(validateTaskGraphToolEvents(events, [item], scope).outcomes.get("call-1")).toBe("failed")
    expect(() => validateTaskGraphToolEvents([
      events[0], lifecycleEvent("call-1", "call-1", "tool_call.failed", 2, { status: "failed", errorCode: "other" }),
    ], [item], scope)).toThrow("task_graph_verification_event_ambiguous")
  })

  it("rejects a lifecycle tool-version mismatch", () => {
    const item = call("call-1", "step-1")
    const events = [
      lifecycleEvent("call-1", "call-1", "tool_call.started", 1, { status: "started" }),
      lifecycleEvent("call-1", "call-1", "tool_call.completed", 2,
        { status: "completed", errorCode: null, toolVersion: "v2" }),
    ]
    expect(() => validateTaskGraphToolEvents(events, [item], scope))
      .toThrow("task_graph_verification_event_ambiguous")
  })

  it("rejects missing, nonchronological, extra, and wrong-task lifecycle rows", () => {
    const item = call("call-1", "step-1")
    const start = lifecycleEvent("call-1", "call-1", "tool_call.started", 1, { status: "started" })
    const done = lifecycleEvent("call-1", "call-1", "tool_call.completed", 2, { status: "completed", errorCode: null })
    expect(() => validateTaskGraphToolEvents([start], [item], scope)).toThrow("task_graph_verification_event_ambiguous")
    expect(() => validateTaskGraphToolEvents([
      { ...start, sequence: 3 }, { ...done, sequence: 2 },
    ], [item], scope)).toThrow("task_graph_verification_event_ambiguous")
    expect(() => validateTaskGraphToolEvents([start, done, done], [item], scope)).toThrow("task_graph_verification_event_ambiguous")
    expect(() => validateTaskGraphToolEvents([start, { ...done, taskId: "foreign" }], [item], scope))
      .toThrow("task_graph_verification_event_invalid")
  })
})

describe("validateTaskGraphReplaySources", () => {
  const sourceCallId = "source-call-1"
  const sourceResultItemId = "source-result-1"
  const currentCallId = `${TASK_GRAPH_REPLAY_CALL_PREFIX}${createHash("sha256").update(JSON.stringify(["step-2", sourceCallId])).digest("hex")}`
  const sourceCallContent = { ...tool, toolCallId: sourceCallId, status: "completed", errorCode: null }
  const sourceResultContent = { toolCallId: sourceCallId, output: { count: 2 }, errorCode: null }
  const sourceRow = {
    sourceCallItemId: "source-call-item-1", sourceResultItemId,
    sourceSessionId: scope.sessionId, sourceTurnId: scope.turnId, sourceTaskId: scope.taskId,
    sourceRootTaskId: scope.rootTaskId, sourceTurnRootTaskId: scope.rootTaskId,
    sourceParentTaskId: scope.parentTaskId, sourceUserId: scope.userId,
    sourceCallStepId: "step-1", sourceResultStepId: "step-1", sourceCallAttempt: 1,
    sourceResultAttempt: 1, sourceCallOrdinal: 0, sourceResultOrdinal: 0,
    sourceCallType: "tool_call", sourceResultType: "tool_result",
    sourceCallStatus: "completed", sourceResultStatus: "completed",
    sourceCallRevision: 1, sourceResultRevision: 1,
    sourceCallContent, sourceResultContent,
  }
  const proof = { currentCallId, source: { toolCallId: sourceCallId, resultItemId: sourceResultItemId } }
  const items = [
    call("current-call-item", "step-2", { toolCallId: currentCallId }),
    result(currentCallId, "step-2"),
  ]
  const sourceEvents = [
    { ...lifecycleEvent("source-call-item-1", sourceCallId, "tool_call.started", 1, { status: "started" }),
      userId: scope.userId, sessionId: scope.sessionId, turnId: scope.turnId },
    { ...lifecycleEvent("source-call-item-1", sourceCallId, "tool_call.completed", 2, { status: "completed", errorCode: null }),
      userId: scope.userId, sessionId: scope.sessionId, turnId: scope.turnId },
  ]

  it("accepts an exact earlier completed source and returns item revision receipts", () => {
    const replayPayload = { status: "completed", errorCode: null, replaySource: proof.source }
    const currentEvents = [
      lifecycleEvent("current-call-item", currentCallId, "tool_call.started", 3, { status: "started", replaySource: proof.source }),
      lifecycleEvent("current-call-item", currentCallId, "tool_call.completed", 4, replayPayload),
    ]
    const validation = validateTaskGraphToolEvents(currentEvents, items, scope)
    expect(validation.replays).toEqual([proof])
    expect(validateTaskGraphReplaySources(validation.replays, [sourceRow], sourceEvents, items, scope)).toEqual([{
      currentCallId, sourceCallItem: ["source-call-item-1", 1], sourceResultItem: [sourceResultItemId, 1],
    }])
  })

  it("rejects a missing source, foreign scope, and changed replay output with stable errors", () => {
    expect(() => validateTaskGraphReplaySources([proof], [], sourceEvents, items, scope))
      .toThrow("task_graph_verification_replay_source_missing")
    expect(() => validateTaskGraphReplaySources([proof], [{ ...sourceRow, sourceUserId: "foreign" }], sourceEvents, items, scope))
      .toThrow("task_graph_verification_replay_source_mismatch")
    expect(() => validateTaskGraphReplaySources([proof], [{ ...sourceRow,
      sourceResultContent: { ...sourceResultContent, output: { count: 3 } },
    }], sourceEvents, items, scope)).toThrow("task_graph_verification_replay_source_mismatch")
  })

  it("rejects missing or mismatched replay lifecycle proof", () => {
    expect(() => validateTaskGraphReplaySources([proof], [sourceRow], [], items, scope))
      .toThrow("task_graph_verification_replay_lifecycle_invalid")
    expect(() => validateTaskGraphReplaySources([proof], [sourceRow], [
      sourceEvents[0], { ...sourceEvents[1], correlationId: "other-call" },
    ], items, scope)).toThrow("task_graph_verification_replay_lifecycle_invalid")
  })

  it("rejects a missing replay marker and a nondeterministic replay call id", () => {
    const start = lifecycleEvent("current-call-item", currentCallId, "tool_call.started", 3, { status: "started" })
    const done = lifecycleEvent("current-call-item", currentCallId, "tool_call.completed", 4,
      { status: "completed", errorCode: null, replaySource: proof.source })
    expect(() => validateTaskGraphToolEvents([start, done], items, scope))
      .toThrow("task_graph_verification_replay_source_missing")

    const wrongId = `${TASK_GRAPH_REPLAY_CALL_PREFIX}${"f".repeat(64)}`
    const wrongItems = [
      call("current-call-item", "step-2", { toolCallId: wrongId }),
      result(wrongId, "step-2"),
    ]
    expect(() => validateTaskGraphToolEvents([
      lifecycleEvent("current-call-item", wrongId, "tool_call.started", 3, { status: "started", replaySource: proof.source }),
      lifecycleEvent("current-call-item", wrongId, "tool_call.completed", 4,
        { status: "completed", errorCode: null, replaySource: proof.source }),
    ], wrongItems, scope)).toThrow("task_graph_verification_replay_source_invalid")
  })
})
