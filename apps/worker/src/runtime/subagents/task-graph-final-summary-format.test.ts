import { describe, expect, it } from "vitest"
import { formatTaskGraphFinalSummary } from "./task-graph-final-summary-format.js"
import type { TaskGraphFinalSummary } from "./task-graph-final-summary.js"

function summary(): TaskGraphFinalSummary {
  return {
    graphRevision: 17,
    counts: {
      discoveredJobs: { knownCount: 0, coverage: "complete" },
      analyzedJobs: { knownCount: 2, coverage: "partial" },
      artifactReferences: { knownCount: null, coverage: "unavailable" },
      reviewOutcomes: { knownCount: null, coverage: "not_requested" },
    },
    discoveredJobs: [{ jobId: "PRIVATE_JOB_ID", taskIds: ["PRIVATE_TASK_ID"] }],
    analyzedJobs: [],
    artifactReferences: [],
    reviewOutcomes: [],
    taskOutcomes: [{ taskId: "PRIVATE_TASK_ID", role: "scout", taskStatus: "completed", resultState: "valid" }],
  }
}

describe("TaskGraph final-summary formatter", () => {
  it("renders only known counts and honest coverage, including a complete empty result", () => {
    const formatted = formatTaskGraphFinalSummary(summary())
    expect(formatted).toBe("Task-reported results: discovered jobs: 0 (complete); analyzed jobs: 2 observed (partial); artifact references: unavailable; review outcomes: not requested.")
    expect(formatted.length).toBeLessThanOrEqual(1_000)
    expect(formatted).not.toContain("PRIVATE")
    expect(formatted).not.toContain("17")
  })

  it("fails closed for malformed counts without rendering untrusted fields", () => {
    const malformed = {
      ...summary(),
      counts: {
        ...summary().counts,
        discoveredJobs: { knownCount: "PRIVATE_COUNT", coverage: "private coverage" },
      },
    } as unknown as TaskGraphFinalSummary
    const formatted = formatTaskGraphFinalSummary(malformed)
    expect(formatted).toContain("discovered jobs: unavailable")
    expect(formatted).not.toContain("PRIVATE")
    expect(formatted.length).toBeLessThanOrEqual(1_000)
  })
})
