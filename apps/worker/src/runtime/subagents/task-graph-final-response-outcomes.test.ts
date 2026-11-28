import { describe, expect, it } from "vitest"
import { renderTaskGraphFinalOutcomeLines } from "./task-graph-final-response-outcomes.js"
import type { TaskGraphExecutionFailureCategory } from "./task-graph-failure-category.js"

function outcome(taskId: string, taskStatus: string = "failed", resultState: string = "missing") {
  return { taskId, role: "analyst", taskStatus, resultState }
}

describe("TaskGraph final execution failure rendering", () => {
  it("groups only equal closed causes and gives unresolved failures a neutral evidence hint", () => {
    const failures = new Map<string, TaskGraphExecutionFailureCategory>([
      ["private-task-a", "execution_deadline_exceeded"],
      ["private-task-b", "execution_deadline_exceeded"],
      ["private-task-c", "resume_state_unavailable"],
      ["private-task-d", "execution_setup_unavailable"],
      ["not-in-summary", "structured_output_invalid"],
    ])
    const lines = renderTaskGraphFinalOutcomeLines([
      outcome("private-task-a"), outcome("private-task-b"), outcome("private-task-c"), outcome("private-task-d"),
    ], new Set(), failures)

    expect(lines).toEqual([
      "Task states:",
      "Analysis: 2 failed tasks; structured result missing.",
      "Execution blocker: The task exceeded its execution deadline. Inspect current evidence for the affected tasks before deciding what to do next.",
      "Analysis: 1 failed task; structured result missing.",
      "Execution blocker: Required resume state was unavailable. Inspect current evidence for the affected task before deciding what to do next.",
      "Analysis: 1 failed task; structured result missing.",
      "Execution blocker: Required setup or inputs were unavailable. Inspect current evidence for the affected task before deciding what to do next.",
    ])
    expect(lines.join("\n")).not.toMatch(/private-task|not-in-summary|retry|replace|approve|submit/i)
  })

  it("shows the fixed verified-repair direction only for the resolved group", () => {
    const failures = new Map<string, TaskGraphExecutionFailureCategory>([
      ["private-task-repaired", "structured_output_invalid"],
      ["private-task-current", "structured_output_invalid"],
    ])
    const lines = renderTaskGraphFinalOutcomeLines([
      outcome("private-task-repaired"), outcome("private-task-current"),
    ], new Set(["private-task-repaired"]), failures)

    expect(lines).toContain("Earlier execution issue: The structured result did not satisfy its contract. See the current verified results.")
    expect(lines).toContain("Execution blocker: The structured result did not satisfy its contract. Inspect current evidence for the affected task before deciding what to do next.")
    expect(lines.join("\n")).not.toContain("private-task")
    expect(lines.join("\n")).toContain("Verified repair evidence covers the affected criteria.")
  })

  it("uses no failure explanation for nonfailed, malformed, or unknown categories", () => {
    const failures = new Map<string, TaskGraphExecutionFailureCategory>([
      ["completed-task", "execution_deadline_exceeded"],
      ["failed-task", "raw_failure_reason" as unknown as TaskGraphExecutionFailureCategory],
    ])
    const lines = renderTaskGraphFinalOutcomeLines([
      outcome("completed-task", "completed", "missing"),
      outcome("failed-task"),
    ], new Set(), failures)

    expect(lines).toEqual([
      "Task states:",
      "Analysis: 1 completed task; structured result missing.",
      "Analysis: 1 failed task; structured result missing.",
    ])
  })

  it("keeps malformed arrays unavailable and bounds the number of rows", () => {
    expect(renderTaskGraphFinalOutcomeLines([outcome("task", "failed", "unknown")], new Set(), new Map()))
      .toEqual(["Task states: unavailable."])
    expect(renderTaskGraphFinalOutcomeLines(Array.from({ length: 12 }, (_, i) => outcome(`task-${i}`)), new Set(), new Map()))
      .toEqual(["Task states: unavailable."])
  })
})
