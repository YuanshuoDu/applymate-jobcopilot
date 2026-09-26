import { describe, expect, it } from "vitest"

import { restoreToolCallState } from "./persisted-tool-call-state.js"

describe("restoreToolCallState", () => {
  it("returns an unfinished persisted call for registry-based restart recovery", () => {
    const restored = restoreToolCallState([
      { id: "call-item", stepId: "step-0", type: "tool_call", status: "started", revision: 0, content: { toolCallId: "call-1", toolName: "jobs.search", input: { location: "Dublin" } } },
    ], [{ type: "tool_call.started", payload: { toolCallId: "call-1", toolName: "jobs.search" } }])

    expect(restored.pending).toEqual([{
      call: { id: "call-1", name: "jobs.search", arguments: { location: "Dublin" } }, toolVersion: "1", stepId: "step-0",
      callItem: { id: "call-item", revision: 0 },
    }])
    expect(restored.observations).toEqual([])
  })

  it("uses a durable lifecycle result if it landed before item completion", () => {
    const restored = restoreToolCallState([
      { id: "call-item", stepId: "step-0", type: "tool_call", status: "started", revision: 0, content: { toolCallId: "call-1", toolName: "jobs.search", input: {} } },
    ], [
      { type: "tool_call.completed", payload: { toolCallId: "call-1", toolName: "jobs.search", toolVersion: "1", status: "completed", output: { jobs: ["one"] } } },
      { type: "tool_call.completed", payload: { toolCallId: "call-1", toolName: "jobs.search", status: "completed", taskId: "root-1" } },
    ])

    expect(restored.pending[0]?.durableResult).toMatchObject({ status: "completed", output: { jobs: ["one"] } })
    expect(restored.pending[0]?.callItem).toEqual({ id: "call-item", revision: 0 })
  })

  it("restores event output when the terminal result item stores only a reference marker", () => {
    const restored = restoreToolCallState([
      { type: "tool_call", content: { toolCallId: "call-1", toolName: "jobs.search", input: {}, status: "completed" } },
      { type: "tool_result", content: { toolCallId: "call-1", outputAvailable: true, errorCode: null } },
    ], [{ type: "tool_call.completed", payload: { toolCallId: "call-1", output: { jobs: [{ id: "job-1" }] }, errorCode: null } }])
    expect(restored.observations[0]?.content.output).toEqual({ jobs: [{ id: "job-1" }] })
  })

  it("rejects a terminal event whose payload status contradicts its event type", () => {
    const call = { id: "call-item", stepId: "step-0", type: "tool_call", status: "started", revision: 0, content: { toolCallId: "call-1", toolName: "jobs.search" } }
    expect(() => restoreToolCallState([call], [{ type: "tool_call.completed", payload: { toolCallId: "call-1", status: "failed" } }])).toThrow("tool_result_replay_uncertain")
    expect(() => restoreToolCallState([call], [{ type: "tool_call.failed", payload: { toolCallId: "call-1", status: "completed" } }])).toThrow("tool_result_replay_uncertain")
  })

  it.each([
    ["terminal status", [{ type: "tool_call.completed", payload: { toolCallId: "call-1", status: "completed" } }, { type: "tool_call.failed", payload: { toolCallId: "call-1", status: "failed" } }]],
    ["toolVersion", [{ type: "tool_call.completed", payload: { toolCallId: "call-1", status: "completed", toolVersion: "1" } }, { type: "tool_call.completed", payload: { toolCallId: "call-1", status: "completed", toolVersion: "2" } }]],
    ["output", [{ type: "tool_call.completed", payload: { toolCallId: "call-1", status: "completed", output: { count: 1 } } }, { type: "tool_call.completed", payload: { toolCallId: "call-1", status: "completed", output: { count: 2 } } }]],
    ["errorCode", [{ type: "tool_call.failed", payload: { toolCallId: "call-1", status: "failed", errorCode: "first_error" } }, { type: "tool_call.failed", payload: { toolCallId: "call-1", status: "failed", errorCode: "second_error" } }]],
  ])("rejects conflicting terminal receipts with different %s", (_label, events) => {
    const call = { id: "call-item", stepId: "step-0", type: "tool_call", status: "started", revision: 0, content: { toolCallId: "call-1", toolName: "jobs.search" } }
    expect(() => restoreToolCallState([call], events)).toThrow("tool_result_replay_uncertain")
  })

  it("rejects a terminal event that contradicts persisted tool-result outcome status", () => {
    const call = { id: "call-item", stepId: "step-0", type: "tool_call", status: "started", revision: 0, content: { toolCallId: "call-1", toolName: "jobs.search", status: "failed" } }
    const event = { type: "tool_call.completed", payload: { toolCallId: "call-1", status: "completed", output: { count: 1 } } }
    expect(() => restoreToolCallState([call], [event])).toThrow("tool_result_replay_uncertain")
  })

  it("rejects a completed lifecycle event paired with a failed result item", () => {
    const call = { id: "call-item", stepId: "step-0", type: "tool_call", status: "started", revision: 0, content: { toolCallId: "call-1", toolName: "jobs.search" } }
    const result = { id: "result-item", stepId: "step-0", type: "tool_result", status: "failed", revision: 0, content: { toolCallId: "call-1", errorCode: "tool_execution_failed" } }
    const event = { type: "tool_call.completed", payload: { toolCallId: "call-1", status: "completed", output: { count: 1 } } }
    expect(() => restoreToolCallState([call, result], [event])).toThrow("tool_result_replay_uncertain")
  })

  it("rejects lifecycle output or error codes that disagree with persisted result content", () => {
    const call = { id: "call-item", stepId: "step-0", type: "tool_call", status: "completed", revision: 1, content: { toolCallId: "call-1", toolName: "jobs.search", status: "completed" } }
    const result = { id: "result-item", stepId: "step-0", type: "tool_result", status: "completed", revision: 1, content: { toolCallId: "call-1", output: { count: 1 }, errorCode: "first_error" } }
    expect(() => restoreToolCallState([call, result], [{ type: "tool_call.completed", payload: { toolCallId: "call-1", output: { count: 2 }, errorCode: "first_error" } }])).toThrow("tool_result_replay_uncertain")
    expect(() => restoreToolCallState([call, result], [{ type: "tool_call.completed", payload: { toolCallId: "call-1", output: { count: 1 }, errorCode: "second_error" } }])).toThrow("tool_result_replay_uncertain")
  })

  it("accepts matching full outputs and ordinary failed tool receipts", () => {
    const successful = restoreToolCallState([
      { id: "call-item", stepId: "step-0", type: "tool_call", status: "completed", revision: 1, content: { toolCallId: "call-1", toolName: "jobs.search", status: "completed" } },
      { id: "result-item", stepId: "step-0", type: "tool_result", status: "completed", revision: 1, content: { toolCallId: "call-1", output: { count: 1 }, errorCode: null } },
    ], [{ type: "tool_call.completed", payload: { toolCallId: "call-1", status: "completed", output: { count: 1 }, errorCode: null } }])
    expect(successful.observations[0]?.content.output).toEqual({ count: 1 })

    const failed = restoreToolCallState([
      { id: "failed-call", stepId: "step-0", type: "tool_call", status: "completed", revision: 1, content: { toolCallId: "call-2", toolName: "jobs.search", status: "failed", errorCode: "tool_execution_failed" } },
      { id: "failed-result", stepId: "step-0", type: "tool_result", status: "completed", revision: 1, content: { toolCallId: "call-2", output: null, errorCode: "tool_execution_failed" } },
    ], [{ type: "tool_call.failed", payload: { toolCallId: "call-2", status: "failed", errorCode: "tool_execution_failed" } }])
    expect(failed.observations[0]?.content).toMatchObject({ status: "failed", errorCode: "tool_execution_failed" })
  })

  it("preserves an explicit cancelled outcome with its cancellation errorCode", () => {
    const call = { id: "call-item", stepId: "step-0", type: "tool_call", status: "completed", revision: 1, content: { toolCallId: "call-1", toolName: "jobs.search", status: "cancelled", errorCode: "cancelled" } }
    const result = { id: "result-item", stepId: "step-0", type: "tool_result", status: "completed", revision: 1, content: { toolCallId: "call-1", status: "cancelled", output: null, errorCode: "cancelled" } }
    const restored = restoreToolCallState([call, result], [{ type: "tool_call.failed", payload: { toolCallId: "call-1", status: "cancelled", output: null, errorCode: "cancelled" } }])
    expect(restored.observations[0]?.content).toMatchObject({ status: "cancelled", errorCode: "cancelled" })

    const recovered = restoreToolCallState([
      { ...call, status: "started", revision: 0 },
      { ...result, status: "completed", revision: 0 },
    ], [])
    expect(recovered.pending[0]?.durableResult).toMatchObject({ status: "cancelled", errorCode: "cancelled" })
  })

  it("rejects explicit event errorCode null against persisted error but accepts an omitted field", () => {
    const call = { id: "call-item", stepId: "step-0", type: "tool_call", status: "completed", revision: 1, content: { toolCallId: "call-1", toolName: "jobs.search", status: "failed", errorCode: "tool_execution_failed" } }
    const result = { id: "result-item", stepId: "step-0", type: "tool_result", status: "completed", revision: 1, content: { toolCallId: "call-1", output: null, errorCode: "tool_execution_failed" } }
    expect(() => restoreToolCallState([call, result], [{ type: "tool_call.failed", payload: { toolCallId: "call-1", status: "failed", errorCode: null } }])).toThrow("tool_result_replay_uncertain")
    expect(restoreToolCallState([call, result], [{ type: "tool_call.failed", payload: { toolCallId: "call-1", status: "failed" } }]).observations[0]?.content)
      .toMatchObject({ status: "failed", errorCode: "tool_execution_failed" })
  })

  it("rejects disagreeing paired item statuses without a lifecycle event", () => {
    expect(() => restoreToolCallState([
      { id: "call-item", stepId: "step-0", type: "tool_call", status: "completed", revision: 1, content: { toolCallId: "call-1", toolName: "jobs.search", status: "completed" } },
      { id: "result-item", stepId: "step-0", type: "tool_result", status: "failed", revision: 1, content: { toolCallId: "call-1", output: { count: 1 }, errorCode: null } },
    ], [])).toThrow("tool_result_replay_uncertain")
  })

  it("uses legacy event toolName only when a matching persisted call exists", () => {
    const call = { id: "call-item", stepId: "step-0", type: "tool_call", status: "started", revision: 0, content: { toolCallId: "call-1", toolName: "jobs.search", input: {} } }
    const restored = restoreToolCallState([call], [{ type: "tool_call.completed", payload: { toolCallId: "call-1", output: { count: 1 } } }])
    expect(restored.pending[0]?.durableResult).toMatchObject({ toolName: "jobs.search", output: { count: 1 } })
    expect(restoreToolCallState([], [{ type: "tool_call.completed", payload: { toolCallId: "orphan", toolName: "jobs.search", output: { count: 1 } } }])).toEqual({ observations: [], pending: [] })
    expect(() => restoreToolCallState([call], [{ type: "tool_call.completed", payload: { toolCallId: "call-1", toolName: "jobs.get", output: { count: 1 } } }])).toThrow("tool_result_replay_uncertain")
  })

  it("keeps a terminal paired tool observation out of the pending recovery set", () => {
    const restored = restoreToolCallState([
      { id: "call-item", stepId: "step-0", type: "tool_call", status: "completed", revision: 1, content: { toolCallId: "call-1", toolName: "jobs.search", input: {}, status: "completed" } },
      { id: "result-item", stepId: "step-0", type: "tool_result", status: "completed", revision: 1, content: { toolCallId: "call-1", output: { count: 1 }, errorCode: null } },
    ], [])

    expect(restored.pending).toEqual([])
    expect(restored.observations).toEqual([{ id: "tool-result:call-1", content: { toolCallId: "call-1", toolName: "jobs.search", input: {}, status: "completed", output: { count: 1 }, errorCode: null } }])
  })

  it("fails closed when an incomplete item has no fenced item identity", () => {
    expect(() => restoreToolCallState([
      { type: "tool_call", status: "started", content: { toolCallId: "call-1", toolName: "jobs.search" } },
    ], [])).toThrow("tool_result_replay_uncertain")
  })

  it.each([
    ["unknown status", [{ id: "call-item", stepId: "step-0", type: "tool_call", status: "processing", revision: 0, content: { toolCallId: "call-1", toolName: "jobs.search" } }]],
    ["legacy status without a paired result", [{ id: "call-item", stepId: "step-0", type: "tool_call", revision: 0, content: { toolCallId: "call-1", toolName: "jobs.search" } }]],
  ])("fails closed for %s", (_label, items) => {
    expect(() => restoreToolCallState(items, [])).toThrow("tool_result_replay_uncertain")
  })

  it("accepts a paired legacy terminal result but never infers terminality from status absence alone", () => {
    const legacy = restoreToolCallState([
      { type: "tool_call", content: { toolCallId: "call-1", toolName: "jobs.search", status: "completed" } },
      { type: "tool_result", content: { toolCallId: "call-1", output: { count: 1 }, errorCode: null } },
    ], [])
    expect(legacy.pending).toEqual([])
    expect(legacy.observations[0]?.content.output).toEqual({ count: 1 })
    expect(() => restoreToolCallState([
      { id: "call-item", stepId: "step-0", type: "tool_call", revision: 0, content: { toolCallId: "call-2", toolName: "jobs.search" } },
    ], [])).toThrow("tool_result_replay_uncertain")
  })
})
