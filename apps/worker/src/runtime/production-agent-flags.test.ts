import { describe, expect, it } from "vitest"

import { resolveProductionAgentFlags } from "./production-agent-flags.js"

describe("production agent flags", () => {
  it("defaults all production gates to disabled", () => {
    expect(resolveProductionAgentFlags({})).toEqual({
      taskGraphPlanningEnabled: false,
      childExecutionEnabled: false,
      coordinationEnabled: false,
      consumeWaitOutcomes: false,
      canonicalAutomationEnabled: false,
      turnBoundaryCompactionEnabled: false,
      nativeSemanticProgressMemoryEnabled: false,
    })
  })

  it("enables child execution only with the exact server flag", () => {
    expect(resolveProductionAgentFlags({ ENABLE_AGENT_CHILD_EXECUTION: "1" })).toMatchObject({
      childExecutionEnabled: true,
      coordinationEnabled: false,
      consumeWaitOutcomes: false,
      taskGraphPlanningEnabled: false,
    })
    for (const value of [undefined, "", "0", "true", "01", " 1", "1 "]) {
      expect(resolveProductionAgentFlags({ ENABLE_AGENT_CHILD_EXECUTION: value }).childExecutionEnabled).toBe(false)
    }
  })

  it("enables wait coordination only when child execution and wait resolution are both enabled", () => {
    expect(resolveProductionAgentFlags({ ENABLE_AGENT_WAIT_RESOLVER: "1" })).toMatchObject({
      childExecutionEnabled: false,
      coordinationEnabled: false,
      consumeWaitOutcomes: false,
    })
    expect(resolveProductionAgentFlags({ ENABLE_AGENT_CHILD_EXECUTION: "1", ENABLE_AGENT_WAIT_RESOLVER: "1" })).toMatchObject({
      childExecutionEnabled: true,
      coordinationEnabled: true,
      consumeWaitOutcomes: true,
      taskGraphPlanningEnabled: false,
    })
  })

  it("enables TaskGraph only with its dedicated gate and both explicit runtime prerequisites", () => {
    const enabled = {
      ENABLE_AGENT_TASK_GRAPH_PLANNING: "1",
      ENABLE_AGENT_CHILD_EXECUTION: "1",
      ENABLE_AGENT_WAIT_RESOLVER: "1",
    } as const
    expect(resolveProductionAgentFlags(enabled).taskGraphPlanningEnabled).toBe(true)

    for (const key of Object.keys(enabled) as Array<keyof typeof enabled>) {
      expect(resolveProductionAgentFlags({ ...enabled, [key]: "0" }).taskGraphPlanningEnabled).toBe(false)
      for (const value of [undefined, "", "true", "01", " 1", "1 "]) {
        expect(resolveProductionAgentFlags({ ...enabled, [key]: value }).taskGraphPlanningEnabled).toBe(false)
      }
    }

    expect(resolveProductionAgentFlags({ ENABLE_AGENT_TASK_GRAPH_PLANNING: "1" })).toMatchObject({
      taskGraphPlanningEnabled: false,
      childExecutionEnabled: false,
      coordinationEnabled: false,
    })
  })

  it("enables canonical automation only with its exact server flag", () => {
    expect(resolveProductionAgentFlags({ ENABLE_AGENT_CANONICAL_AUTOMATION: "1" }).canonicalAutomationEnabled).toBe(true)
    for (const value of [undefined, "", "0", "true", "01", " 1", "1 "]) {
      expect(resolveProductionAgentFlags({ ENABLE_AGENT_CANONICAL_AUTOMATION: value }).canonicalAutomationEnabled).toBe(false)
    }
  })

  it("enables turn-boundary compaction only with its exact server flag", () => {
    expect(resolveProductionAgentFlags({ ENABLE_AGENT_TURN_BOUNDARY_COMPACTION: "1" })).toMatchObject({
      turnBoundaryCompactionEnabled: true,
      taskGraphPlanningEnabled: false,
      childExecutionEnabled: false,
      coordinationEnabled: false,
      consumeWaitOutcomes: false,
      canonicalAutomationEnabled: false,
    })
    for (const value of [undefined, "", "0", "false", "true", "01", " 1", "1 "]) {
      expect(resolveProductionAgentFlags({ ENABLE_AGENT_TURN_BOUNDARY_COMPACTION: value }).turnBoundaryCompactionEnabled).toBe(false)
    }

    expect(resolveProductionAgentFlags({
      ENABLE_AGENT_TURN_BOUNDARY_COMPACTION: "0",
      ENABLE_AGENT_CHILD_EXECUTION: "1",
      ENABLE_AGENT_WAIT_RESOLVER: "1",
      ENABLE_AGENT_TASK_GRAPH_PLANNING: "1",
      ENABLE_AGENT_CANONICAL_AUTOMATION: "1",
    })).toEqual({
      taskGraphPlanningEnabled: true,
      childExecutionEnabled: true,
      coordinationEnabled: true,
      consumeWaitOutcomes: true,
      canonicalAutomationEnabled: true,
      turnBoundaryCompactionEnabled: false,
      nativeSemanticProgressMemoryEnabled: false,
    })
  })

  it("enables native semantic progress memory only with its exact server flag", () => {
    expect(resolveProductionAgentFlags({ ENABLE_AGENT_NATIVE_SEMANTIC_PROGRESS_MEMORY: "1" }).nativeSemanticProgressMemoryEnabled).toBe(true)
    for (const value of [undefined, "", "0", "false", "true", "01", " 1", "1 "]) {
      expect(resolveProductionAgentFlags({ ENABLE_AGENT_NATIVE_SEMANTIC_PROGRESS_MEMORY: value }).nativeSemanticProgressMemoryEnabled).toBe(false)
    }
    expect(resolveProductionAgentFlags({ ENABLE_AGENT_NATIVE_SEMANTIC_PROGRESS: "1" }).nativeSemanticProgressMemoryEnabled).toBe(false)
  })
})
