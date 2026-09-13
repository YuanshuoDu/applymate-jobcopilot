import { describe, expect, it } from "vitest"

import { resolveProductionAgentFlags } from "./production-agent-flags.js"

describe("production agent flags", () => {
  it("defaults both planning gates to disabled", () => {
    expect(resolveProductionAgentFlags({})).toEqual({ cognitiveLoopEnabled: false, planningEnabled: false, planningExecutionEnabled: false, contextCompactionEnabled: false, canonicalAutomationEnabled: false })
    expect(resolveProductionAgentFlags({ ENABLE_AGENT_PLANNING: "0", ENABLE_AGENT_PLAN_EXECUTION: "0" })).toEqual({ cognitiveLoopEnabled: false, planningEnabled: false, planningExecutionEnabled: false, contextCompactionEnabled: false, canonicalAutomationEnabled: false })
  })

  it("enables planning only with the explicit server flag", () => {
    expect(resolveProductionAgentFlags({ ENABLE_AGENT_PLANNING: "1" })).toEqual({ cognitiveLoopEnabled: false, planningEnabled: true, planningExecutionEnabled: false, contextCompactionEnabled: false, canonicalAutomationEnabled: false })
    expect(resolveProductionAgentFlags({ ENABLE_AGENT_PLANNING: "1", ENABLE_AGENT_PLAN_EXECUTION: "1" })).toEqual({ cognitiveLoopEnabled: false, planningEnabled: true, planningExecutionEnabled: true, contextCompactionEnabled: false, canonicalAutomationEnabled: false })
  })

  it("does not allow execution to bypass the planning gate", () => {
    expect(resolveProductionAgentFlags({ ENABLE_AGENT_PLAN_EXECUTION: "1" })).toEqual({ cognitiveLoopEnabled: false, planningEnabled: false, planningExecutionEnabled: false, contextCompactionEnabled: false, canonicalAutomationEnabled: false })
    expect(resolveProductionAgentFlags({ ENABLE_AGENT_PLANNING: "true", ENABLE_AGENT_PLAN_EXECUTION: "1" })).toEqual({ cognitiveLoopEnabled: false, planningEnabled: false, planningExecutionEnabled: false, contextCompactionEnabled: false, canonicalAutomationEnabled: false })
  })

  it("enables the complete cognitive loop only with the exact server flag", () => {
    expect(resolveProductionAgentFlags({ ENABLE_AGENT_COGNITIVE_LOOP: "1" })).toEqual({ cognitiveLoopEnabled: true, planningEnabled: true, planningExecutionEnabled: true, contextCompactionEnabled: false, canonicalAutomationEnabled: true })
    for (const value of [undefined, "", "0", "true", "01", " 1", "1 "]) {
      expect(resolveProductionAgentFlags({ ENABLE_AGENT_COGNITIVE_LOOP: value, model: "enable", policy: "enable" })).toEqual({ cognitiveLoopEnabled: false, planningEnabled: false, planningExecutionEnabled: false, contextCompactionEnabled: false, canonicalAutomationEnabled: false })
    }
  })

  it("enables context compaction only with the exact server flag", () => {
    expect(resolveProductionAgentFlags({ ENABLE_AGENT_CONTEXT_COMPACTION: "1" }).contextCompactionEnabled).toBe(true)
    for (const value of [undefined, "", "0", "true", "01", " 1", "1 "]) {
      expect(resolveProductionAgentFlags({ ENABLE_AGENT_CONTEXT_COMPACTION: value }).contextCompactionEnabled).toBe(false)
    }
  })

  it("enables canonical automation only with the exact server flag", () => {
    expect(resolveProductionAgentFlags({ ENABLE_AGENT_CANONICAL_AUTOMATION: "1" }).canonicalAutomationEnabled).toBe(true)
    for (const value of [undefined, "", "0", "true", "01", " 1", "1 "]) {
      expect(resolveProductionAgentFlags({ ENABLE_AGENT_CANONICAL_AUTOMATION: value }).canonicalAutomationEnabled).toBe(false)
    }
  })
})
