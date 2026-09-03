import { describe, expect, it } from "vitest"

import { projectLegacySubAgentTask } from "./subagent-task-compat"

describe("legacy SubAgentTask projection", () => {
  it("keeps completed durable rows visible as passed to the old UI", () => {
    const projected = projectLegacySubAgentTask({
      id: "task_1",
      sessionId: "session_1",
      role: "scout",
      taskType: "job_search",
      status: "completed",
      goal: "Find EU roles",
      confidence: 0.95,
      failureReason: null,
      result: { jobs: 3 },
      createdAt: new Date("2026-09-02T00:00:00Z"),
      updatedAt: new Date("2026-09-02T00:01:00Z"),
    })

    expect(projected).toMatchObject({ status: "passed", hasResult: true })
    expect(projected).not.toHaveProperty("result")
  })

  it("leaves non-completion lifecycle states unchanged", () => {
    expect(projectLegacySubAgentTask({
      id: "task_2",
      sessionId: "session_1",
      role: "analyst",
      taskType: "score",
      status: "waiting_for_user",
      goal: "Ask for missing authorization",
      confidence: null,
      failureReason: null,
      result: null,
      createdAt: new Date("2026-09-02T00:00:00Z"),
      updatedAt: new Date("2026-09-02T00:01:00Z"),
    }).status).toBe("waiting_for_user")
  })
})
