import { GoalContractValidationError, isPlainJsonObject, normalizeGoalContract, type GoalContract } from "./goal-plan-contract.js"

export type HydratedGoalContract = { readonly goal: string; readonly goalContract: GoalContract }

function row(value: unknown): Record<string, unknown> | null {
  return isPlainJsonObject(value) ? value : null
}

function invalid(path: string, code: string, message: string): never {
  throw new GoalContractValidationError([{ path, code, message }])
}

function source(input: unknown): { root: Record<string, unknown>; value: Record<string, unknown> } {
  const root = row(input)
  if (!root) invalid("input", "invalid_object", "Turn input must be a plain object")
  const nested = row(root.input)
  return { root, value: nested ?? root }
}

function goalText(value: Record<string, unknown>): string {
  const goal = value.goal ?? value.content
  if (typeof goal !== "string" || !goal.trim()) invalid("goal", "missing_goal", "Turn goal must be a non-empty string")
  return goal.trim()
}

export function hydrateGoalContract(input: unknown): HydratedGoalContract {
  const { root, value } = source(input)
  const goal = goalText(value)
  const hasNestedContract = Object.prototype.hasOwnProperty.call(value, "goalContract")
  const hasRootContract = Object.prototype.hasOwnProperty.call(root, "goalContract")
  if (!hasNestedContract && !hasRootContract) {
    return { goal, goalContract: { revision: 1, objective: goal, constraints: [], successCriteria: [], knownFacts: [], unresolvedQuestions: [], approvalBoundaries: [], budgetRef: "runtime:turn" } }
  }
  const contract = normalizeGoalContract(hasNestedContract ? value.goalContract : root.goalContract)
  if (contract.revision !== 1) invalid("goalContract.revision", "unsupported_revision", "Only goal contract revision 1 is accepted")
  if (contract.objective !== goal) invalid("goalContract.objective", "goal_mismatch", "Goal contract objective must match the canonical turn goal")
  if (contract.budgetRef !== "runtime:turn") invalid("goalContract.budgetRef", "forbidden_budget_ref", "Budget reference is server-owned")
  return { goal, goalContract: contract }
}
