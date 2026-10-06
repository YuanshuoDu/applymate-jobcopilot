import { describe, expect, it, vi } from "vitest"

vi.mock("@prisma/client", () => ({
  Prisma: { sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }) },
  PrismaClient: class { $extends() { return this } },
}))

import { AgentCommandError, AgentCommandService, AgentSessionControlService } from "./index"

describe("control-plane command exports", () => {
  it("exports the service and typed error", () => {
    expect(AgentCommandService).toBeDefined()
    expect(AgentCommandError).toBeDefined()
    expect(AgentSessionControlService).toBeDefined()
  })
})
