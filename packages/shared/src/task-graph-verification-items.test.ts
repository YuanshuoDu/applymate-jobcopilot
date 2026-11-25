import { describe, expect, it } from "vitest"
import { validateTaskGraphVerificationItems } from "./task-graph-tool-receipt-verification.js"

const scope = { sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", taskId: "task-1", attemptCount: 2 }
const pair = [
  { id: "call-item", sessionId: scope.sessionId, turnId: scope.turnId, taskId: scope.taskId, rootTaskId: scope.rootTaskId,
    turnRootTaskId: scope.rootTaskId, stepId: "step-1", joinedStepId: "step-1", attempt: 2, ordinal: 0, revision: 1,
    status: "completed", stepStatus: "completed", type: "tool_call", content: { toolCallId: "call-1", toolName: "jobs.get", toolVersion: "1", input: {}, status: "completed", errorCode: null } },
  { id: "result-item", sessionId: scope.sessionId, turnId: scope.turnId, taskId: scope.taskId, rootTaskId: scope.rootTaskId,
    turnRootTaskId: scope.rootTaskId, stepId: "step-1", joinedStepId: "step-1", attempt: 2, ordinal: 0, revision: 2,
    status: "completed", stepStatus: "completed", type: "tool_result", content: { toolCallId: "call-1", output: { job: { id: "job-1" } }, errorCode: null } },
]

describe("validateTaskGraphVerificationItems", () => {
  it("exports the exact paired item validation used by Worker receipts", () => {
    expect(validateTaskGraphVerificationItems(pair, scope)).toEqual(pair)
    expect(() => validateTaskGraphVerificationItems(pair.map(item => ({ ...item, taskId: "foreign" })), scope))
      .toThrow("task_graph_verification_item_invalid")
    expect(() => validateTaskGraphVerificationItems(pair.slice(0, 1), scope)).toThrow("task_graph_verification_pair_invalid")
  })
})
