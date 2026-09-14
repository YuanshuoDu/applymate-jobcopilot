import { describe, expect, it } from "vitest"

import { inspectJoinFailureEvidence, replanRequiredControl } from "./plan-replan-signal.js"

const ids = ["child-a", "child-b", "child-c"]

function task(taskId: string, status = "completed", failureReason: string | null = null) {
  return { taskId, status, result: null, failureReason }
}

describe("plan replan signal", () => {
  it("sorts failed child IDs and preserves the bounded control shape", () => {
    const evidence = inspectJoinFailureEvidence({
      status: "ready",
      tasks: [task("child-c", "cancelled"), task("child-a", "failed", "provider stopped"), task("child-b", "completed")],
    }, ids)
    expect(evidence).toEqual({ valid: true, failedTaskIds: ["child-a", "child-c"] })
    if (!evidence.valid) throw new Error("expected valid evidence")
    expect(replanRequiredControl("join", ["child-a", "child-b", "child-c"], evidence.failedTaskIds)).toEqual({
      localId: "join:replan", kind: "replan_required", dependsOn: ids, reason: "child_failure", failedTaskIds: ["child-a", "child-c"],
    })
  })

  it("accepts a pure successful join without creating a signal", () => {
    const evidence = inspectJoinFailureEvidence({ status: "timed_out", tasks: ids.map(id => task(id)) }, ids)
    expect(evidence).toEqual({ valid: true, failedTaskIds: [] })
    if (!evidence.valid) throw new Error("expected valid evidence")
    expect(replanRequiredControl("join", ids, evidence.failedTaskIds)).toBeUndefined()
  })

  it("fails closed for malformed failure evidence and bounded overflow", () => {
    expect(inspectJoinFailureEvidence({ status: "ready", tasks: [{ taskId: "child-a", status: "failed", result: null }] }, ["child-a"])).toEqual({ valid: false })
    expect(inspectJoinFailureEvidence({ status: "ready", tasks: [task("child-a", "failed", "x".repeat(8 * 1024 + 1))] }, ["child-a"])).toEqual({ valid: false })
    expect(replanRequiredControl("join", ids, Array.from({ length: 9 }, (_, index) => `child-${index}`))).toBeUndefined()
  })
})
