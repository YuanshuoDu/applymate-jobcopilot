import { describe, expect, it } from "vitest"
import { isPrivateV2EventType } from "./v2-private-event-filter"

describe("V2 private event filter", () => {
  it("filters exact planner-private receipt types and the existing verification namespace", () => {
    expect(isPrivateV2EventType("agent.plan.reconciliation")).toBe(true)
    expect(isPrivateV2EventType("agent.plan.clarification")).toBe(true)
    expect(isPrivateV2EventType("native_verification.requested")).toBe(true)
    expect(isPrivateV2EventType("native_verification.future.v1")).toBe(true)
  })

  it("keeps unrelated and similarly named event types public", () => {
    expect(isPrivateV2EventType("agent.plan.reconciliation.detail")).toBe(false)
    expect(isPrivateV2EventType("agent.plan.clarification.detail")).toBe(false)
    expect(isPrivateV2EventType("agent.plan.updated")).toBe(false)
    expect(isPrivateV2EventType("item.completed")).toBe(false)
  })
})
