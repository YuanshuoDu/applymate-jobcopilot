import { describe, expect, it, vi } from "vitest"

import { createWriteTools } from "./write-tools.js"
import { ToolRegistry } from "./registry.js"
import type { ApplicationSubmitIdentity } from "../../queue/application-submit-fence.js"

const identity: ApplicationSubmitIdentity = { sessionId: "session-a", fillTurnId: "turn-a", applicationTaskId: "application-a", userId: "user-a", jobId: "job-a", approvalId: "receipt-a", constraintHash: "c".repeat(64) }

describe("write tool factory", () => {
  it("registers only the canonical application submit tool", () => {
    const tools = createWriteTools({
      pool: {} as never,
      submit: vi.fn(),
      identity,
    })

    expect(tools.map(tool => tool.name)).toEqual(["application.submit"])
    expect(tools[0]).toMatchObject({ risk: "external_write", idempotency: "requires_key", timeoutMs: 60_000, requiredCapabilities: ["submission"] })
    expect(tools[0]?.capabilities).toEqual(["write", "external_write", "coordination"])

    const registry = new ToolRegistry(tools)
    expect(registry.validateArguments("application.submit", { applicationTargetId: "job-a", receiptId: "receipt-a", constraintHash: "c".repeat(64) })).toBe(true)
    expect(registry.validateArguments("application.submit", { applicationTargetId: "job-a", receiptId: "receipt-a", constraintHash: "c".repeat(64), formData: {} })).not.toBe(true)
  })

  it("passes the immutable application attempt identity into the registered submit tool", async () => {
    const [tool] = createWriteTools({ pool: {} as never, submit: vi.fn(), identity })
    await expect(tool?.execute({ scope: { userId: identity.userId }, sessionId: identity.sessionId, turnId: "stale-turn", stepId: "application.submit", taskId: identity.applicationTaskId, signal: new AbortController().signal, capabilities: ["submission"], reportProgress: async () => undefined }, {
      applicationTargetId: identity.jobId, receiptId: identity.approvalId, constraintHash: identity.constraintHash,
    })).resolves.toMatchObject({ status: "failed", errorCode: "submission_scope_mismatch" })
  })
})
