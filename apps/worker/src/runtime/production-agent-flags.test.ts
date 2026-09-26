import { describe, expect, it } from "vitest"

import { resolveProductionAgentFlags } from "./production-agent-flags.js"

describe("production agent flags", () => {
  it("defaults all production gates to disabled", () => {
    expect(resolveProductionAgentFlags({})).toEqual({ childExecutionEnabled: false, coordinationEnabled: false, consumeWaitOutcomes: false, canonicalAutomationEnabled: false })
  })

  it("enables child execution only with the exact server flag", () => {
    expect(resolveProductionAgentFlags({ ENABLE_AGENT_CHILD_EXECUTION: "1" })).toMatchObject({
      childExecutionEnabled: true,
      coordinationEnabled: false,
      consumeWaitOutcomes: false,
    })
    for (const value of [undefined, "", "0", "true", "01", " 1", "1 "]) {
      expect(resolveProductionAgentFlags({ ENABLE_AGENT_CHILD_EXECUTION: value }).childExecutionEnabled).toBe(false)
    }
  })

  it("enables wait outcome coordination only when child execution and wait resolution are enabled", () => {
    expect(resolveProductionAgentFlags({ ENABLE_AGENT_WAIT_RESOLVER: "1" })).toMatchObject({
      childExecutionEnabled: false,
      coordinationEnabled: false,
      consumeWaitOutcomes: false,
    })
    expect(resolveProductionAgentFlags({ ENABLE_AGENT_CHILD_EXECUTION: "1", ENABLE_AGENT_WAIT_RESOLVER: "1" })).toMatchObject({
      childExecutionEnabled: true,
      coordinationEnabled: true,
      consumeWaitOutcomes: true,
    })
  })

  it("keeps partial runtime gates explicit while deriving route and capabilities together", () => {
    expect(resolveProductionAgentFlags({ ENABLE_AGENT_CANONICAL_AUTOMATION: "1" })).toMatchObject({
      canonicalAutomationEnabled: true,
      childExecutionEnabled: false,
      coordinationEnabled: false,
      consumeWaitOutcomes: false,
    })
  })

  it("enables canonical automation only with the exact server flag", () => {
    expect(resolveProductionAgentFlags({ ENABLE_AGENT_CANONICAL_AUTOMATION: "1" }).canonicalAutomationEnabled).toBe(true)
    for (const value of [undefined, "", "0", "true", "01", " 1", "1 "]) {
      expect(resolveProductionAgentFlags({ ENABLE_AGENT_CANONICAL_AUTOMATION: value }).canonicalAutomationEnabled).toBe(false)
    }
  })
})
