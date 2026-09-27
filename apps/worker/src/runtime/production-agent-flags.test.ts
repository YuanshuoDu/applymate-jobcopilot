import { describe, expect, it } from "vitest"

import { resolveProductionAgentFlags } from "./production-agent-flags.js"

describe("production agent flags", () => {
  it("defaults all production gates to disabled", () => {
    expect(resolveProductionAgentFlags({})).toEqual({
      cognitiveLoopEnabled: false,
      planningEnabled: false,
      planningExecutionEnabled: false,
      taskGraphPlanningEnabled: false,
      childExecutionEnabled: false,
      coordinationEnabled: false,
      consumeWaitOutcomes: false,
      canonicalAutomationEnabled: false,
    })
  })

  it("enables legacy planning only through its explicit server gates", () => {
    expect(resolveProductionAgentFlags({ ENABLE_AGENT_PLANNING: "1" })).toMatchObject({
      planningEnabled: true,
      planningExecutionEnabled: false,
    })
    expect(resolveProductionAgentFlags({ ENABLE_AGENT_PLANNING: "1", ENABLE_AGENT_PLAN_EXECUTION: "1" })).toMatchObject({
      planningEnabled: true,
      planningExecutionEnabled: true,
    })
    for (const env of [
      { ENABLE_AGENT_PLAN_EXECUTION: "1" },
      { ENABLE_AGENT_PLANNING: "true", ENABLE_AGENT_PLAN_EXECUTION: "1" },
    ]) {
      expect(resolveProductionAgentFlags(env)).toMatchObject({ planningEnabled: false, planningExecutionEnabled: false })
    }
  })

  it("does not let the cognitive-loop flag bypass child and wait prerequisites", () => {
    expect(resolveProductionAgentFlags({ ENABLE_AGENT_COGNITIVE_LOOP: "1" })).toEqual({
      cognitiveLoopEnabled: true,
      planningEnabled: true,
      planningExecutionEnabled: true,
      taskGraphPlanningEnabled: false,
      childExecutionEnabled: false,
      coordinationEnabled: false,
      consumeWaitOutcomes: false,
      canonicalAutomationEnabled: false,
    })

    expect(resolveProductionAgentFlags({
      ENABLE_AGENT_COGNITIVE_LOOP: "1",
      ENABLE_AGENT_CHILD_EXECUTION: "1",
    })).toMatchObject({ childExecutionEnabled: true, coordinationEnabled: false, consumeWaitOutcomes: false })
    expect(resolveProductionAgentFlags({
      ENABLE_AGENT_COGNITIVE_LOOP: "1",
      ENABLE_AGENT_CHILD_EXECUTION: "1",
      ENABLE_AGENT_WAIT_RESOLVER: "1",
    })).toMatchObject({ childExecutionEnabled: true, coordinationEnabled: true, consumeWaitOutcomes: true })

    for (const value of [undefined, "", "0", "true", "01", " 1", "1 "]) {
      expect(resolveProductionAgentFlags({ ENABLE_AGENT_COGNITIVE_LOOP: value, model: "enable", policy: "enable" })).toMatchObject({
        cognitiveLoopEnabled: false,
        planningEnabled: false,
        planningExecutionEnabled: false,
        taskGraphPlanningEnabled: false,
        childExecutionEnabled: false,
        coordinationEnabled: false,
        consumeWaitOutcomes: false,
        canonicalAutomationEnabled: false,
      })
    }
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

  it("does not let legacy planning or the cognitive-loop umbrella enable TaskGraph", () => {
    const legacyFlags = {
      ENABLE_AGENT_PLANNING: "1",
      ENABLE_AGENT_PLAN_EXECUTION: "1",
      ENABLE_AGENT_COGNITIVE_LOOP: "1",
    } as const
    expect(resolveProductionAgentFlags(legacyFlags).taskGraphPlanningEnabled).toBe(false)
    expect(resolveProductionAgentFlags({
      ...legacyFlags,
      ENABLE_AGENT_TASK_GRAPH_PLANNING: "1",
      ENABLE_AGENT_CHILD_EXECUTION: "1",
    }).taskGraphPlanningEnabled).toBe(false)
    expect(resolveProductionAgentFlags({
      ...legacyFlags,
      ENABLE_AGENT_TASK_GRAPH_PLANNING: "1",
      ENABLE_AGENT_WAIT_RESOLVER: "1",
    }).taskGraphPlanningEnabled).toBe(false)
  })

  it("enables canonical automation only with its exact server flag", () => {
    expect(resolveProductionAgentFlags({ ENABLE_AGENT_CANONICAL_AUTOMATION: "1" }).canonicalAutomationEnabled).toBe(true)
    expect(resolveProductionAgentFlags({ ENABLE_AGENT_COGNITIVE_LOOP: "1" }).canonicalAutomationEnabled).toBe(false)
    for (const value of [undefined, "", "0", "true", "01", " 1", "1 "]) {
      expect(resolveProductionAgentFlags({ ENABLE_AGENT_CANONICAL_AUTOMATION: value }).canonicalAutomationEnabled).toBe(false)
    }
  })
})
