import { describe, expect, it } from "vitest"
import { OBJECTIVE_TASK_GRAPH_EXECUTION_INTENT } from "@jobcopilot/agent-protocol"

import { OBJECTIVE_TAILOR_EXECUTION_BUDGET_PROFILE, selectObjectiveTailorExecutionBudgetSnapshot } from "./objective-tailor-execution-budget"
import type { ServerAgentTurnIntent } from "./types"

describe("Objective Tailor execution budget", () => {
  it("selects the frozen server profile only for enabled user Objective turns", () => {
    const snapshot = selectObjectiveTailorExecutionBudgetSnapshot({
      featureFlag: "1",
      source: "user",
      intent: OBJECTIVE_TASK_GRAPH_EXECUTION_INTENT,
      hasSelectedJobBinding: false,
    })

    expect(snapshot).toEqual({ limits: { maxSteps: 96 }, objectiveTailorProfile: OBJECTIVE_TAILOR_EXECUTION_BUDGET_PROFILE })
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.limits)).toBe(true)
  })

  it.each([
    { featureFlag: undefined, source: "user" as const, intent: OBJECTIVE_TASK_GRAPH_EXECUTION_INTENT, hasSelectedJobBinding: false },
    { featureFlag: "true", source: "user" as const, intent: OBJECTIVE_TASK_GRAPH_EXECUTION_INTENT, hasSelectedJobBinding: false },
    { featureFlag: "1", source: "automation" as const, intent: OBJECTIVE_TASK_GRAPH_EXECUTION_INTENT, hasSelectedJobBinding: false },
    { featureFlag: "1", source: "user" as const, intent: undefined, hasSelectedJobBinding: false },
    { featureFlag: "1", source: "user" as const, intent: { kind: "interactive_discovery_shortlist", version: 1 } as const, hasSelectedJobBinding: false },
    { featureFlag: "1", source: "user" as const, intent: OBJECTIVE_TASK_GRAPH_EXECUTION_INTENT, hasSelectedJobBinding: true },
  ])("keeps the default snapshot for an ineligible turn", (input) => {
    expect(selectObjectiveTailorExecutionBudgetSnapshot(input)).toEqual({})
  })

  it("rejects extended or accessor-backed intent objects", () => {
    const extended = { ...OBJECTIVE_TASK_GRAPH_EXECUTION_INTENT, extra: true } as unknown as ServerAgentTurnIntent
    const accessor = Object.defineProperties({}, {
      kind: { enumerable: true, get: () => OBJECTIVE_TASK_GRAPH_EXECUTION_INTENT.kind },
      version: { enumerable: true, value: OBJECTIVE_TASK_GRAPH_EXECUTION_INTENT.version },
    }) as ServerAgentTurnIntent
    const base = { featureFlag: "1", source: "user" as const, hasSelectedJobBinding: false }

    expect(selectObjectiveTailorExecutionBudgetSnapshot({ ...base, intent: extended })).toEqual({})
    expect(selectObjectiveTailorExecutionBudgetSnapshot({ ...base, intent: accessor })).toEqual({})
  })
})
