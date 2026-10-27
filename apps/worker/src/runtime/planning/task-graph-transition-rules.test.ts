import { describe, expect, it } from "vitest"
import { isTaskGraphBlocking, isTaskGraphTerminal, sameTaskGraphEvent, taskGraphEventAllowed, taskGraphNextStatus } from "./task-graph-transition-rules.js"
import { TASK_GRAPH_CHILD_DEADLINE_FAILURE_REASON } from "../subagents/task-graph-child-deadline.js"
import type { TaskGraphEvent } from "./task-graph.js"

const expiry = TASK_GRAPH_CHILD_DEADLINE_FAILURE_REASON

describe("TaskGraph transition rules", () => {
  it.each(["queued", "retrying", "waiting", "waiting_for_user"] as const)("allows only the trusted deadline failure from %s", status => {
    expect(taskGraphEventAllowed(status, "task.failed", expiry)).toBe(true)
    expect(taskGraphEventAllowed(status, "task.failed", "worker error")).toBe(false)
  })

  it("keeps running failures and stop events on their existing rules", () => {
    expect(taskGraphEventAllowed("running", "task.failed", "worker error")).toBe(true)
    expect(taskGraphEventAllowed("completed", "task.failed", expiry)).toBe(false)
    expect(taskGraphEventAllowed("queued", "task.interrupted")).toBe(true)
    expect(taskGraphEventAllowed("queued", "task.completed")).toBe(false)
  })

  it("maps event states and compares exact lifecycle identities", () => {
    expect(taskGraphNextStatus("task.failed")).toBe("failed")
    expect(isTaskGraphTerminal("cancelled")).toBe(true)
    expect(isTaskGraphBlocking("cancelled")).toBe(true)
    expect(isTaskGraphBlocking("completed")).toBe(false)
    const event: TaskGraphEvent = { type: "task.failed", nodeKey: "a", expectedRevision: 1, idempotencyKey: "a:1", failureReason: expiry }
    expect(sameTaskGraphEvent(event, { ...event })).toBe(true)
    expect(sameTaskGraphEvent(event, { ...event, failureReason: "other" })).toBe(false)
  })
})
