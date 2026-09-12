import { SUBAGENT_MAX_FAN_OUT } from "../subagents/types.js"

export const GOAL_CONTRACT_SCHEMA_VERSION = "agent-harness.goal-contract.v1"
export const PLAN_PROPOSAL_SCHEMA_VERSION = "agent-harness.plan.v1"
export const PLAN_MAX_NODES = SUBAGENT_MAX_FAN_OUT
export const PLAN_MAX_REVISIONS = 8
export const MAX_GOAL_REVISIONS = 8

export type GoalContract = {
  readonly revision: number
  readonly objective: string
  readonly constraints: readonly string[]
  readonly successCriteria: readonly string[]
  readonly knownFacts: readonly string[]
  readonly unresolvedQuestions: readonly string[]
  readonly approvalBoundaries: readonly string[]
  readonly budgetRef: string
}

export type GoalContractRef = {
  readonly get: () => GoalContract
  readonly update: (next: GoalContract) => void
}

export const PLAN_ACTION_KINDS = ["use_tool", "delegate", "join", "request_input", "propose_completion"] as const
export type PlanActionKind = typeof PLAN_ACTION_KINDS[number]

export function copyAllowedPlanActions(value: readonly PlanActionKind[] | undefined): readonly PlanActionKind[] {
  const candidate: unknown = value === undefined ? PLAN_ACTION_KINDS : value
  if (!Array.isArray(candidate)) throw new TypeError("Invalid plan action allowlist")
  const result: PlanActionKind[] = []
  for (const action of candidate) {
    if (typeof action !== "string" || !PLAN_ACTION_KINDS.includes(action as PlanActionKind) || result.includes(action as PlanActionKind)) throw new TypeError("Invalid plan action allowlist")
    result.push(action as PlanActionKind)
  }
  return Object.freeze(result)
}

export type PlanBudgetRequest = string | {
  readonly ref: string
  readonly units?: number
}

export type PlanNode = {
  readonly localId: string
  readonly kind: PlanActionKind
  readonly objective: string
  readonly inputRefs: readonly string[]
  readonly dependsOn: readonly string[]
  readonly successCriteria: readonly string[]
  readonly outputSchemaRef: string | null
  readonly budgetRequest?: PlanBudgetRequest
  readonly toolName?: string
  readonly tool?: string
  readonly template?: string
  readonly role?: string
  readonly taskType?: string
  readonly constraints?: readonly string[]
  readonly question?: string
  readonly approvalBoundary?: string
  readonly joinMode?: "any" | "all"
  readonly timeoutMs?: number
}

export type PlanProposal = {
  readonly schemaVersion: typeof PLAN_PROPOSAL_SCHEMA_VERSION
  readonly basedOnGoalRevision: number
  readonly basedOnPlanRevision: number | null
  readonly nodes: readonly PlanNode[]
  readonly completionCriteria: readonly string[]
  readonly briefRationale: string
}

export type GoalContractInput = GoalContract
export type PlanProposalInput = PlanProposal

export type GoalContractIssue = { readonly path: string; readonly code: string; readonly message: string }

export class GoalContractValidationError extends Error {
  constructor(readonly issues: readonly GoalContractIssue[]) {
    super(`Goal contract rejected: ${issues.map(issue => `${issue.path} ${issue.code}`).join(", ")}`)
    this.name = "GoalContractValidationError"
  }
}

const GOAL_KEYS = ["revision", "objective", "constraints", "successCriteria", "knownFacts", "unresolvedQuestions", "approvalBoundaries", "budgetRef"]
const GOAL_IDENTITY_KEYS = new Set(["userId", "sessionId", "turnId", "taskId", "parentTaskId", "rootTaskId", "ownerId", "lease", "capabilities", "permissions", "budgetLimit", "maxBudget"])

export function isPlainJsonObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function goalRow(value: unknown): Record<string, unknown> | null {
  return isPlainJsonObject(value) ? value : null
}

function goalString(value: unknown, path: string, issues: GoalContractIssue[], max: number): string {
  if (typeof value !== "string") { issues.push({ path, code: "invalid_string", message: "Expected a string" }); return "" }
  const result = value.trim()
  if (!result) issues.push({ path, code: "empty_string", message: "String must not be empty" })
  if (result.length > max) issues.push({ path, code: "too_long", message: `String exceeds ${max} characters` })
  return result
}

function goalList(value: unknown, path: string, issues: GoalContractIssue[]): string[] {
  if (!Array.isArray(value)) { issues.push({ path, code: "invalid_array", message: "Expected an array" }); return [] }
  if (value.length > 32) issues.push({ path, code: "too_many_items", message: "Array exceeds 32 items" })
  const seen = new Set<string>()
  return value.flatMap((item, index) => {
    const result = goalString(item, `${path}.${index}`, issues, 1_000)
    if (!result) return []
    if (seen.has(result)) issues.push({ path: `${path}.${index}`, code: "duplicate_value", message: "Array values must be unique" })
    seen.add(result)
    return [result]
  })
}

export function normalizeGoalContract(value: unknown): GoalContract {
  const issues: GoalContractIssue[] = []
  const parsed = goalRow(value)
  if (!parsed) throw new GoalContractValidationError([{ path: "goal", code: "invalid_object", message: "Goal contract must be a plain object" }])
  const allowed = new Set(GOAL_KEYS)
  for (const key of Object.keys(parsed)) {
    if (GOAL_IDENTITY_KEYS.has(key)) issues.push({ path: key, code: "forbidden_field", message: "Runtime identity and permission fields are server-owned" })
    else if (!allowed.has(key)) issues.push({ path: key, code: "unknown_field", message: "Unknown goal contract field" })
  }
  for (const key of GOAL_KEYS) if (!Object.prototype.hasOwnProperty.call(parsed, key)) issues.push({ path: key, code: "missing_field", message: "Goal contract field is required" })
  const revision = parsed.revision
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1) issues.push({ path: "revision", code: "invalid_revision", message: "Revision must be a positive integer" })
  const objective = goalString(parsed.objective, "objective", issues, 4_000)
  const constraints = goalList(parsed.constraints, "constraints", issues)
  const successCriteria = goalList(parsed.successCriteria, "successCriteria", issues)
  const knownFacts = goalList(parsed.knownFacts, "knownFacts", issues)
  const unresolvedQuestions = goalList(parsed.unresolvedQuestions, "unresolvedQuestions", issues)
  const approvalBoundaries = goalList(parsed.approvalBoundaries, "approvalBoundaries", issues)
  const budgetRef = goalString(parsed.budgetRef, "budgetRef", issues, 256)
  if (issues.length > 0) throw new GoalContractValidationError(issues)
  return { revision: revision as number, objective, constraints, successCriteria, knownFacts, unresolvedQuestions, approvalBoundaries, budgetRef }
}

export const validateGoalContract = normalizeGoalContract

export function isPlanProposal(value: unknown): value is PlanProposal {
  return Boolean(isPlainJsonObject(value) && value.schemaVersion === PLAN_PROPOSAL_SCHEMA_VERSION)
}
