import { OBJECTIVE_TASK_GRAPH_EXECUTION_INTENT, type TurnSource } from "@jobcopilot/agent-protocol"

import type { ServerAgentTurnIntent } from "./types"

export const OBJECTIVE_TAILOR_EXECUTION_BUDGET_PROFILE = "agent-harness.v2.objective-tailor-execution-budget.v1"

const objectiveTailorSnapshot = Object.freeze({
  limits: Object.freeze({ maxSteps: 96 as const }),
  objectiveTailorProfile: OBJECTIVE_TAILOR_EXECUTION_BUDGET_PROFILE,
})

function isExactObjectiveIntent(intent: unknown): boolean {
  if (intent === null || typeof intent !== "object" || Array.isArray(intent)) return false
  if (Object.getPrototypeOf(intent) !== Object.prototype) return false
  const keys = Reflect.ownKeys(intent)
  if (keys.length !== 2 || !keys.includes("kind") || !keys.includes("version")) return false
  const kind = Object.getOwnPropertyDescriptor(intent, "kind")
  const version = Object.getOwnPropertyDescriptor(intent, "version")
  return kind?.enumerable === true && "value" in kind && kind.value === OBJECTIVE_TASK_GRAPH_EXECUTION_INTENT.kind
    && version?.enumerable === true && "value" in version && version.value === OBJECTIVE_TASK_GRAPH_EXECUTION_INTENT.version
}

export function selectObjectiveTailorExecutionBudgetSnapshot(input: {
  readonly featureFlag: string | undefined
  readonly source: TurnSource
  readonly intent: ServerAgentTurnIntent | undefined
  readonly hasSelectedJobBinding: boolean
}): Readonly<Record<string, unknown>> {
  if (input.featureFlag !== "1" || input.source !== "user" || input.hasSelectedJobBinding
    || !isExactObjectiveIntent(input.intent)) return Object.freeze({})
  return objectiveTailorSnapshot
}
