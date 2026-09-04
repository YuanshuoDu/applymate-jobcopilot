import { describe, expect, it, vi } from "vitest"

import { createWriteTools } from "./write-tools.js"
import { ToolRegistry } from "./registry.js"

describe("write tool factory", () => {
  it("registers only the canonical application submit tool", () => {
    const tools = createWriteTools({
      pool: {} as never,
      submit: vi.fn(),
    })

    expect(tools.map(tool => tool.name)).toEqual(["application.submit"])
    expect(tools[0]).toMatchObject({ risk: "external_write", idempotency: "requires_key", timeoutMs: 60_000, requiredCapabilities: ["submission"] })
    expect(tools[0]?.capabilities).toEqual(["write", "external_write", "coordination"])

    const registry = new ToolRegistry(tools)
    expect(registry.validateArguments("application.submit", { applicationTargetId: "job-a", receiptId: "receipt-a", constraintHash: "c".repeat(64) })).toBe(true)
    expect(registry.validateArguments("application.submit", { applicationTargetId: "job-a", receiptId: "receipt-a", constraintHash: "c".repeat(64), formData: {} })).not.toBe(true)
  })
})
