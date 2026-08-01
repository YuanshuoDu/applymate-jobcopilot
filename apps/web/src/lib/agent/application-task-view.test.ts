import { describe, expect, it } from "vitest"
import { applicationTaskSummary, mayCancelApplicationTask } from "./application-task-view"

describe("application task view", () => {
  it("groups the durable task states for the Agent summary", () => {
    expect(applicationTaskSummary([
      { status: "submitted" }, { status: "waiting_for_user" }, { status: "waiting_for_authorization" },
      { status: "failed" }, { status: "filling" },
    ])).toEqual({ submitted: 1, needsUser: 2, failed: 1, inProgress: 1 })
  })

  it("never offers cancellation for a completed submission", () => {
    expect(mayCancelApplicationTask("submitted")).toBe(false)
    expect(mayCancelApplicationTask("waiting_for_user")).toBe(true)
  })
})
