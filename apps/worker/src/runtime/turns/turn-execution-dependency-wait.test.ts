import { describe, expect, it } from "vitest"
import { dependencyWaitReceipt } from "./turn-execution-dependency-wait.js"

const taskId = "subagent-00000000-0000-4000-8000-000000000001"
const rootWaitId = "wait-12345678-1234-4234-9234-123456789012"
const taskWaitId = "12345678-1234-4234-9234-123456789012"

function output(waitId: string) {
  return {
    waitId, status: "waiting", taskIds: [taskId], deadlineAt: "2099-01-01T00:00:00.000Z", matchedTaskIds: [taskId],
    tasks: [{ taskId, status: "waiting", role: "scout", result: null, failureReason: null }],
  }
}

describe("owner-aware dependency wait receipt", () => {
  it("accepts root durable wait IDs for root wait tools", () => {
    expect(dependencyWaitReceipt(output(rootWaitId), "agent.wait", "turn")).toEqual({
      waitId: rootWaitId, deadlineAt: "2099-01-01T00:00:00.000Z", matchedTaskIds: [taskId],
    })
    expect(dependencyWaitReceipt(output(rootWaitId), "wait_subagents", "turn")?.waitId).toBe(rootWaitId)
  })

  it("accepts child raw wait IDs only for task wait_subagents", () => {
    expect(dependencyWaitReceipt(output(taskWaitId), "wait_subagents", "task")?.waitId).toBe(taskWaitId)
    expect(() => dependencyWaitReceipt(output(rootWaitId), "wait_subagents", "task"))
      .toThrow("Durable wait receipt is invalid")
    expect(() => dependencyWaitReceipt(output(taskWaitId), "agent.wait", "task"))
      .toThrow("Durable wait receipt is invalid")
  })

  it("ignores non-wait tools and rejects malformed wait outcomes", () => {
    expect(dependencyWaitReceipt(output(rootWaitId), "jobs.search", "turn")).toBeNull()
    expect(() => dependencyWaitReceipt({ ...output(rootWaitId), extra: true }, "agent.wait", "turn"))
      .toThrow("Durable wait receipt is invalid")
  })
})
