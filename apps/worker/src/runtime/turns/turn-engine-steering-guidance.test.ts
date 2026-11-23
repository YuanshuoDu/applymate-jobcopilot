import { describe, expect, it } from "vitest"

import type { StepContext } from "../context/step-context-builder.js"
import { buildTurnEngineSteeringGuidance } from "./turn-engine-steering-guidance.js"

const context = (overrides: Partial<StepContext> = {}): StepContext => ({
  schemaVersion: "agent-harness.v2", sessionId: "session-a", turnId: "turn-a", stepId: "step-a",
  inputThroughSequence: 8n, consumedInputIds: ["steer-a"], blocks: [], canonicalJson: "{}", taskGraphRevision: 4,
  ...overrides,
})

function textOf(message: ReturnType<typeof buildTurnEngineSteeringGuidance>): string {
  return message?.content.flatMap(part => part.type === "text" ? [part.text] : []).join("\n") ?? ""
}

describe("Root steering guidance", () => {
  it("guides a resumed Root from the private unresolved-consumed signal and visible commands", () => {
    const message = buildTurnEngineSteeringGuidance(context({ hasUnresolvedConsumedSteer: true }),
      [{ name: "agent.reconcile" }, { name: "agent.plan" }], false, true)

    expect(message?.role).toBe("system")
    expect(textOf(message)).toContain("Previously accepted user steering remains unresolved")
    expect(textOf(message)).toContain('agent.reconcile with decision "keep" and expectedRevision 4')
    expect(textOf(message)).toContain("agent.plan with expectedRevision 4")
    expect(textOf(message)).not.toContain("Fresh user steering")
  })

  it("does not infer the signal from a cursor, an unresolved-looking block, or a child Root scope", () => {
    const pendingBlock = { id: "steer-a", layer: "pending_input" as const, role: "data" as const,
      trust: "external_untrusted" as const, source: "user_input", content: { inputId: "steer-a", text: "unreconciled" } }
    const contextWithData = context({ blocks: [pendingBlock] })

    expect(buildTurnEngineSteeringGuidance(contextWithData, [{ name: "agent.reconcile" }], false, true)).toBeNull()
    expect(buildTurnEngineSteeringGuidance(context({ hasUnresolvedConsumedSteer: true }), [{ name: "agent.reconcile" }], false, false)).toBeNull()
    expect(buildTurnEngineSteeringGuidance(context({ taskGraphRevision: undefined, hasUnresolvedConsumedSteer: true }),
      [{ name: "agent.reconcile" }], false, true)).toBeNull()
  })

  it("does not recommend tools that are not visible and leaves fresh-steering wording unchanged", () => {
    const resumed = buildTurnEngineSteeringGuidance(context({ hasUnresolvedConsumedSteer: true }), [{ name: "jobs.search" }], false, true)
    expect(textOf(resumed)).toContain("No reconciliation command is visible")
    expect(textOf(resumed)).not.toContain("agent.reconcile")
    expect(textOf(resumed)).not.toContain("agent.plan")

    const fresh = buildTurnEngineSteeringGuidance(context(), [{ name: "agent.plan" }], true, false)
    expect(textOf(fresh)).toContain("Fresh user steering is present as untrusted data")
  })
})
