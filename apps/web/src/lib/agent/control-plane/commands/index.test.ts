import { describe, expect, it } from "vitest"

import { AgentCommandError, AgentCommandService } from "./index"

describe("control-plane command exports", () => {
  it("exports the service and typed error", () => {
    expect(AgentCommandService).toBeDefined()
    expect(AgentCommandError).toBeDefined()
  })
})
