import { describe, expect, it } from "vitest"
import type { TaskGraphScheduleInput } from "./task-graph-schedule-input.js"

describe("TaskGraph schedule input", () => {
  it("carries exactly the parsed operational failure mapping as a separate mode", () => {
    const replaceOperationalFailure = {
      root: { nodeKey: "analyst-old", taskId: "task-old" },
      sources: [{ nodeKey: "analyst-old", taskId: "task-old", replacementKey: "analyst-new" }],
    } as const
    const input: TaskGraphScheduleInput = {
      scope: { userId: "user", sessionId: "session", turnId: "turn", rootTaskId: "root", parentTaskId: "root",
        stepId: "step", turnLeaseOwner: "worker", turnLeaseVersion: 1, parentLeaseOwner: "worker", parentAttemptCount: 1 },
      proposal: { expectedRevision: 4, nodes: [] }, templates: {}, replaceOperationalFailure,
    }
    expect(input.replaceOperationalFailure).toEqual(replaceOperationalFailure)
    expect(input.replaceBranch).toBeUndefined()
    expect(input.replaceUnstarted).toBeUndefined()
  })
})
