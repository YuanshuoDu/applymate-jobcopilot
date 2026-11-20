import { describe, expect, it } from "vitest"

import {
  markTaskGraphRetirementOutput,
  prepareTaskGraphRetirementLifecycleOutput,
  type TaskGraphRetirementOutputIdentity,
} from "./task-graph-retirement-output-redaction.js"

const taskId = "subagent-00000000-0000-4000-8000-000000000001"
const identity: TaskGraphRetirementOutputIdentity = {
  sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1",
  stepId: "step-1", toolCallId: "call-1",
}
const call = { ...identity, id: identity.toolCallId, toolName: "agent.retire_superseded_scout", taskId: identity.parentTaskId }

describe("TaskGraph retirement output redaction provenance", () => {
  it.each([
    ["interrupt_requested", 2],
    ["already_requested", 3],
  ] as const)("preserves only the exact %s acknowledgement", (status, attempt) => {
    const output = { taskId, status, attempt }
    expect(markTaskGraphRetirementOutput(output, identity, taskId, status, attempt)).toBe(true)
    expect(prepareTaskGraphRetirementLifecycleOutput(output, call)?.safe).toEqual({ taskId, status, attempt })
    expect(prepareTaskGraphRetirementLifecycleOutput(output, call)).toBeNull()
  })

  it("consumes proof once and binds preservation to the exact Root invocation", () => {
    const mismatches = [
      { ...call, sessionId: "session-2" }, { ...call, turnId: "turn-2" }, { ...call, rootTaskId: "root-2" },
      { ...call, taskId: "other-root" }, { ...call, stepId: "step-2" }, { ...call, id: "call-2" },
      { ...call, toolName: "agent.interrupt" },
    ]
    for (const mismatchedCall of mismatches) {
      const output = { taskId, status: "interrupt_requested" as const, attempt: 2 }
      expect(markTaskGraphRetirementOutput(output, identity, taskId, output.status, output.attempt)).toBe(true)
      expect(prepareTaskGraphRetirementLifecycleOutput(output, mismatchedCall)).toBeNull()
      expect(prepareTaskGraphRetirementLifecycleOutput(output, call)).toBeNull()
    }
  })

  it("rejects unmarked, substituted, extra, and malformed output", () => {
    const unmarked = { taskId, status: "interrupt_requested" as const, attempt: 2 }
    expect(prepareTaskGraphRetirementLifecycleOutput(unmarked, call)).toBeNull()
    expect(markTaskGraphRetirementOutput({ taskId: "other", status: "interrupt_requested", attempt: 2 }, identity,
      taskId, "interrupt_requested", 2)).toBe(false)
    expect(markTaskGraphRetirementOutput({ taskId, status: "interrupt_requested", attempt: 2, receipt: "private" }, identity,
      taskId, "interrupt_requested", 2)).toBe(false)
    expect(markTaskGraphRetirementOutput({ taskId, status: "interrupt_requested", attempt: 0 }, identity,
      taskId, "interrupt_requested", 0)).toBe(false)
    expect(markTaskGraphRetirementOutput({ taskId: "scout-1", status: "interrupt_requested", attempt: 2 }, identity,
      "scout-1", "interrupt_requested", 2)).toBe(false)
  })

  it("rejects accessors without invoking them or changing the identity", () => {
    let getterInvoked = false
    const accessor = { status: "interrupt_requested", attempt: 2 }
    Object.defineProperty(accessor, "taskId", { enumerable: true, get: () => { getterInvoked = true; return taskId } })
    expect(markTaskGraphRetirementOutput(accessor, identity, taskId, "interrupt_requested", 2)).toBe(false)
    expect(getterInvoked).toBe(false)
    expect(identity.parentTaskId).toBe(identity.rootTaskId)
  })
})
