import { describe, expect, it } from "vitest"
import { restoreToolCallState } from "./task-graph-tool-receipt-verification.js"

describe("restoreToolCallState", () => {
  it("preserves pending recovery handles and completed observations", () => {
    const pending = restoreToolCallState([{
      id: "call-item", stepId: "step-1", type: "tool_call", status: "started", revision: 3,
      content: { toolCallId: "call-pending", toolName: "jobs.get", input: { jobId: "job-1" } },
    }], [])
    expect(pending).toEqual({
      observations: [],
      pending: [{ call: { id: "call-pending", name: "jobs.get", arguments: { jobId: "job-1" } }, toolVersion: "1",
        stepId: "step-1", callItem: { id: "call-item", revision: 3 } }],
    })

    const complete = restoreToolCallState([
      { id: "call-done", stepId: "step-2", type: "tool_call", status: "completed", revision: 1,
        content: { toolCallId: "call-done-id", toolName: "jobs.get", status: "completed", errorCode: null, input: {} } },
      { id: "result-done", stepId: "step-2", type: "tool_result", status: "completed", revision: 2,
        content: { toolCallId: "call-done-id", output: { job: { id: "job-2" } }, errorCode: null } },
    ], [])
    expect(complete.pending).toEqual([])
    expect(complete.observations).toEqual([{ id: "tool-result:call-done-id", content: {
      toolCallId: "call-done-id", toolName: "jobs.get", input: {}, status: "completed", output: { job: { id: "job-2" } }, errorCode: null,
    } }])
  })

  it("preserves the uncertain-replay error for duplicate persisted calls", () => {
    const call = { id: "call-item", type: "tool_call", content: { toolCallId: "duplicate", toolName: "jobs.get" } }
    expect(() => restoreToolCallState([call, { ...call, id: "other-call-item" }], [])).toThrow("tool_result_replay_uncertain")
  })
})
