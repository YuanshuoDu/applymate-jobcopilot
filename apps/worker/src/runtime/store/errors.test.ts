import { describe, expect, it } from "vitest"

import { AgentRepositoryConflictError, AgentRepositoryJsonError } from "./errors.js"

describe("worker repository errors", () => {
  it("exposes stable machine-readable codes", () => {
    expect(new AgentRepositoryConflictError("stale")).toMatchObject({ code: "agent_repository_conflict" })
    expect(new AgentRepositoryJsonError("payload")).toMatchObject({ code: "agent_repository_invalid_json" })
  })
})
