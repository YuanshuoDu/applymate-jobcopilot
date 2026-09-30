import { describe, expect, it } from "vitest"

import { TaskGraphCommandError } from "./task-graph-command-port.js"

describe("TaskGraphCommandError", () => {
  it("exposes a stable name, code, message, and optional current revision", () => {
    const error = new TaskGraphCommandError("revision_mismatch", "TaskGraph revision is stale", 7)

    expect(error).toBeInstanceOf(Error)
    expect(error).toMatchObject({
      name: "TaskGraphCommandError",
      code: "revision_mismatch",
      message: "TaskGraph revision is stale",
      currentRevision: 7,
    })
  })

  it("leaves currentRevision undefined when the error has no current graph revision", () => {
    const error = new TaskGraphCommandError("idempotency_conflict", "Proposal key was already used")

    expect(error.name).toBe("TaskGraphCommandError")
    expect(error.code).toBe("idempotency_conflict")
    expect(error.currentRevision).toBeUndefined()
  })
})
