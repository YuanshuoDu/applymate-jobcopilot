import { describe, expect, it } from "vitest"

import { markScoutDelegateOutput, prepareScoutDelegateLifecycleOutput, type ScoutDelegateOutputIdentity } from "./scout-delegate-output-redaction.js"

const taskId = "subagent-00000000-0000-4000-8000-000000000002"
const identity: ScoutDelegateOutputIdentity = {
  sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "parent-1", stepId: "step-1", toolCallId: "call-1",
}
const call = { ...identity, id: identity.toolCallId, toolName: "scout.delegate", taskId: identity.parentTaskId, rootTaskId: identity.rootTaskId }

describe("Scout delegate output redaction provenance", () => {
  it("projects only the exact marked two-field receipt for its matching invocation", () => {
    const output = { taskId, status: "queued" as const }
    expect(markScoutDelegateOutput(output, identity, taskId, "queued")).toBe(true)
    expect(prepareScoutDelegateLifecycleOutput(output, call)?.safe).toEqual({ taskId, status: "queued" })
  })

  it("accepts duplicate receipts but rejects substituted or extra fields", () => {
    const duplicate = { taskId, status: "duplicate" as const }
    expect(markScoutDelegateOutput(duplicate, identity, taskId, "duplicate")).toBe(true)
    const extra = { taskId, status: "queued" as const, note: "untrusted" }
    expect(markScoutDelegateOutput(extra, identity, taskId, "queued")).toBe(false)
    expect(markScoutDelegateOutput({ taskId: "other", status: "queued" }, identity, taskId, "queued")).toBe(false)
  })

  it("consumes provenance and rejects a different call or mutated receipt", () => {
    const crossCall = { taskId, status: "queued" as const }
    expect(markScoutDelegateOutput(crossCall, identity, taskId, "queued")).toBe(true)
    expect(prepareScoutDelegateLifecycleOutput(crossCall, { ...call, id: "call-2" })).toBeNull()
    expect(prepareScoutDelegateLifecycleOutput(crossCall, call)).toBeNull()

    const changed = { taskId, status: "queued" as const }
    expect(markScoutDelegateOutput(changed, identity, taskId, "queued")).toBe(true)
    changed.taskId = "subagent-11111111-1111-4111-8111-111111111111"
    expect(prepareScoutDelegateLifecycleOutput(changed, call)).toBeNull()
  })

  it("binds preservation to the exact session, Turn, Root, parent, Step, and call", () => {
    const mismatches = [
      { ...call, sessionId: "session-2" }, { ...call, turnId: "turn-2" }, { ...call, rootTaskId: "root-2" },
      { ...call, taskId: "parent-2" }, { ...call, stepId: "step-2" }, { ...call, id: "call-2" },
    ]
    for (const mismatchedCall of mismatches) {
      const output = { taskId, status: "queued" as const }
      expect(markScoutDelegateOutput(output, identity, taskId, "queued")).toBe(true)
      expect(prepareScoutDelegateLifecycleOutput(output, mismatchedCall)).toBeNull()
    }
  })

  it("does not invoke accessors or trust an unmarked value", () => {
    let getterInvoked = false
    const accessor = { status: "queued" }
    Object.defineProperty(accessor, "taskId", { enumerable: true, get: () => { getterInvoked = true; return taskId } })
    expect(markScoutDelegateOutput(accessor, identity, taskId, "queued")).toBe(false)
    expect(getterInvoked).toBe(false)
    expect(markScoutDelegateOutput({ taskId: "+353 87 123 4567", status: "queued" }, identity, "+353 87 123 4567", "queued")).toBe(false)
    expect(prepareScoutDelegateLifecycleOutput({ taskId, status: "queued" }, call)).toBeNull()
  })
})
