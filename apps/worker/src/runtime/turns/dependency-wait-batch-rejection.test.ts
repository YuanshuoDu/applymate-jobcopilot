import { describe, expect, it } from "vitest"
import type { TurnEngineToolResult } from "./turn-engine-types.js"
import {
  DEPENDENCY_WAIT_BATCH_REJECTION,
  DEPENDENCY_WAIT_BATCH_REJECTION_ITEM_KEY,
  DEPENDENCY_WAIT_BATCH_REJECTION_MARKER,
  readDependencyWaitBatchRejection,
} from "./dependency-wait-batch-rejection.js"

const callId = "call-1"
const stepId = "step-1"
const itemId = "call-item-1"
const base = {
  toolCallId: callId, toolName: "jobs.search", toolVersion: "1", input: { location: "Dublin" },
  [DEPENDENCY_WAIT_BATCH_REJECTION_ITEM_KEY]: DEPENDENCY_WAIT_BATCH_REJECTION_MARKER,
}
function call(status: "started" | "interrupted" | "completed" = "started") {
  const content = status === "started" ? { ...base } : status === "interrupted"
    ? { ...base, status, errorCode: "session_pause_requested" }
    : { ...base, status: "failed", errorCode: DEPENDENCY_WAIT_BATCH_REJECTION.code }
  return { id: itemId, stepId, taskId: "root-1", type: "tool_call", status, revision: 1, content }
}
function result(status: TurnEngineToolResult["status"] = "failed", output: unknown = DEPENDENCY_WAIT_BATCH_REJECTION): TurnEngineToolResult {
  return { id: callId, toolName: "jobs.search", toolVersion: "1", status, output,
    errorCode: DEPENDENCY_WAIT_BATCH_REJECTION.code }
}
function resultItem(status: "started" | "completed" = "started", output: unknown = DEPENDENCY_WAIT_BATCH_REJECTION) {
  return { id: "result-item-1", stepId, taskId: "root-1", type: "tool_result", status, revision: 0,
    content: { toolCallId: callId, output, errorCode: DEPENDENCY_WAIT_BATCH_REJECTION.code } }
}

describe("dependency wait batch rejection recovery", () => {
  it("reconstructs the fixed failure before the started event exists", () => {
    expect(readDependencyWaitBatchRejection({ callId, callItem: call() })).toEqual(result())
  })

  it("reconciles the persisted failed event result when the result item is absent", () => {
    expect(readDependencyWaitBatchRejection({ callId, callItem: call("completed"), durableResult: result() })).toEqual(result())
  })

  it("turns the fixed pause interruption into the same safe recovery result", () => {
    expect(readDependencyWaitBatchRejection({ callId, callItem: call("interrupted") })).toEqual(result())
  })

  it("accepts a matching started result item so recovery can finish its pair", () => {
    expect(readDependencyWaitBatchRejection({ callId, callItem: call("completed"), resultItem: resultItem(), durableResult: result() }))
      .toEqual(result())
  })

  it("returns no synthetic result for an ordinary unmarked call", () => {
    const ordinary = call()
    delete (ordinary.content as Record<string, unknown>)[DEPENDENCY_WAIT_BATCH_REJECTION_ITEM_KEY]
    expect(readDependencyWaitBatchRejection({ callId, callItem: ordinary })).toBeUndefined()
  })

  it.each([
    ["unknown marker", { [DEPENDENCY_WAIT_BATCH_REJECTION_ITEM_KEY]: "agent-harness.v3.unknown" }],
    ["wrong failure code", { status: "failed", errorCode: "other_failure" }],
    ["successful marked call", { status: "completed", errorCode: null }],
  ])("rejects a marked item with %s", (_label, patch) => {
    const marked = call("completed")
    Object.assign(marked.content as Record<string, unknown>, patch)
    expect(() => readDependencyWaitBatchRejection({ callId, callItem: marked })).toThrow("tool_result_replay_uncertain")
  })

  it("rejects contradictory terminal receipts or altered result output", () => {
    expect(() => readDependencyWaitBatchRejection({ callId, callItem: call("completed"), durableResult: result("completed") }))
      .toThrow("tool_result_replay_uncertain")
    expect(() => readDependencyWaitBatchRejection({ callId, callItem: call("completed"), resultItem: resultItem("started", { code: "other" }) }))
      .toThrow("tool_result_replay_uncertain")
  })

  it("rejects a marked native question call", () => {
    const question = call()
    ;(question.content as Record<string, unknown>).toolName = "agent.ask_user"
    expect(() => readDependencyWaitBatchRejection({ callId, callItem: question })).toThrow("tool_result_replay_uncertain")
  })
})
