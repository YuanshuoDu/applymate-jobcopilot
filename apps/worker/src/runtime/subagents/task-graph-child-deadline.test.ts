import { describe, expect, it } from "vitest"

import {
  isTaskGraphChildDeadlineReached,
  TASK_GRAPH_CHILD_ABSOLUTE_LIFETIME_MS,
  TASK_GRAPH_CHILD_DEADLINE_FAILURE_REASON,
  TASK_GRAPH_CHILD_RUNNING_SEGMENT_MS,
} from "./task-graph-child-deadline.js"

describe("TaskGraph child deadline contract", () => {
  it("keeps the server-owned lifetime, segment, and terminal reason stable", () => {
    expect(TASK_GRAPH_CHILD_ABSOLUTE_LIFETIME_MS).toBe(3_600_000)
    expect(TASK_GRAPH_CHILD_RUNNING_SEGMENT_MS).toBe(300_000)
    expect(TASK_GRAPH_CHILD_DEADLINE_FAILURE_REASON).toBe("task_graph_child_deadline_exceeded")
  })

  it("treats equality as expired and leaves null deadlines unbounded", () => {
    const deadline = new Date("2026-10-26T12:00:00.000Z")
    expect(isTaskGraphChildDeadlineReached(deadline, new Date(deadline.getTime() - 1))).toBe(false)
    expect(isTaskGraphChildDeadlineReached(deadline, deadline)).toBe(true)
    expect(isTaskGraphChildDeadlineReached(null, deadline)).toBe(false)
  })
})
