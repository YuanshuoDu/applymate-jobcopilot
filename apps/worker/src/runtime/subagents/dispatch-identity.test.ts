import { describe, expect, it } from "vitest"
import {
  parseSubagentDispatchIdentity,
  parseSubagentDispatchJobId,
  subagentDispatchJobId,
} from "./dispatch-identity.js"

describe("canonical private subagent dispatch identity", () => {
  it("round-trips task-bound Bull IDs across generations without changing producer bytes", () => {
    for (const taskId of ["task-1", "task:with/slash", "任务-😀"]) {
      for (const generation of [0, 1, 42]) {
        const jobId = subagentDispatchJobId(taskId, generation)
        expect(jobId).toBe(`agent-subagent-${Buffer.from(taskId, "utf8").toString("base64url")}-${generation}`)
        expect(parseSubagentDispatchJobId(jobId, taskId)).toEqual({ jobId, taskId, generation })
      }
    }
  })

  it("rejects missing, foreign, noncanonical, and out-of-range job IDs", () => {
    const taskId = "task-1"
    const valid = subagentDispatchJobId(taskId, 2)
    for (const invalid of [undefined, null, 1, "", "agent-subagent-Zm9yZWlnbg-2", valid.replace(/-2$/, "-02"), valid.replace(/-2$/, "--2"), valid.replace(/-2$/, "-2.0"), `${valid}x`]) {
      expect(parseSubagentDispatchJobId(invalid, taskId)).toBeNull()
    }
    expect(parseSubagentDispatchJobId(valid, "other-task")).toBeNull()
    expect(parseSubagentDispatchJobId(`agent-subagent-${Buffer.from(taskId).toString("base64url")}-${Number.MAX_SAFE_INTEGER}`, taskId)).toBeNull()
    expect(() => subagentDispatchJobId(taskId, -1)).toThrow(RangeError)
    expect(() => subagentDispatchJobId(taskId, Number.MAX_SAFE_INTEGER)).toThrow(RangeError)
    expect(() => subagentDispatchJobId("", 0)).toThrow(RangeError)
  })

  it("accepts only the exact private identity shape bound to its canonical ID", () => {
    const identity = { taskId: "task-1", generation: 3, jobId: subagentDispatchJobId("task-1", 3) }
    expect(parseSubagentDispatchIdentity(identity, "task-1")).toEqual(identity)
    expect(parseSubagentDispatchIdentity({ ...identity, generation: 4 }, "task-1")).toBeNull()
    expect(parseSubagentDispatchIdentity({ ...identity, taskId: "other-task" }, "task-1")).toBeNull()
    expect(parseSubagentDispatchIdentity({ ...identity, extra: true }, "task-1")).toBeNull()
    const accessor = { taskId: "task-1", generation: 3, get jobId() { return identity.jobId } }
    expect(parseSubagentDispatchIdentity(accessor, "task-1")).toBeNull()
    const symbolField = { ...identity, [Symbol("private")]: true }
    expect(parseSubagentDispatchIdentity(symbolField, "task-1")).toBeNull()
  })
})
