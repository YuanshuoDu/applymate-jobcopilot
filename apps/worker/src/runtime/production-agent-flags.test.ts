import { describe, expect, it } from "vitest"

import { resolveProductionAgentFlags } from "./production-agent-flags.js"

describe("production agent flags", () => {
  it("defaults both planning gates to disabled", () => {
    expect(resolveProductionAgentFlags({})).toEqual({ planningEnabled: false, planningExecutionEnabled: false, contextCompactionEnabled: false })
    expect(resolveProductionAgentFlags({ ENABLE_AGENT_PLANNING: "0", ENABLE_AGENT_PLAN_EXECUTION: "0" })).toEqual({ planningEnabled: false, planningExecutionEnabled: false, contextCompactionEnabled: false })
  })

  it("enables planning only with the explicit server flag", () => {
    expect(resolveProductionAgentFlags({ ENABLE_AGENT_PLANNING: "1" })).toEqual({ planningEnabled: true, planningExecutionEnabled: false, contextCompactionEnabled: false })
    expect(resolveProductionAgentFlags({ ENABLE_AGENT_PLANNING: "1", ENABLE_AGENT_PLAN_EXECUTION: "1" })).toEqual({ planningEnabled: true, planningExecutionEnabled: true, contextCompactionEnabled: false })
  })

  it("does not allow execution to bypass the planning gate", () => {
    expect(resolveProductionAgentFlags({ ENABLE_AGENT_PLAN_EXECUTION: "1" })).toEqual({ planningEnabled: false, planningExecutionEnabled: false, contextCompactionEnabled: false })
    expect(resolveProductionAgentFlags({ ENABLE_AGENT_PLANNING: "true", ENABLE_AGENT_PLAN_EXECUTION: "1" })).toEqual({ planningEnabled: false, planningExecutionEnabled: false, contextCompactionEnabled: false })
  })

  it("enables context compaction only with the exact server flag", () => {
    expect(resolveProductionAgentFlags({ ENABLE_AGENT_CONTEXT_COMPACTION: "1" }).contextCompactionEnabled).toBe(true)
    for (const value of [undefined, "", "0", "true", "01", " 1", "1 "]) {
      expect(resolveProductionAgentFlags({ ENABLE_AGENT_CONTEXT_COMPACTION: value }).contextCompactionEnabled).toBe(false)
    }
  })
})
