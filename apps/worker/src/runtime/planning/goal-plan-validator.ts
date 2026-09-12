import { isPlainJsonObject, PLAN_MAX_NODES, PLAN_PROPOSAL_SCHEMA_VERSION, type PlanActionKind, type PlanNode, type PlanProposal, type PlanBudgetRequest } from "./goal-plan-contract.js"

export type PlanValidationIssue = { readonly path: string; readonly code: string; readonly message: string }

export type PlanValidationContext = {
  readonly goalRevision: number
  readonly planRevision?: number | null
  readonly currentPlanRevision?: number | null
  readonly maxNodes?: number
  readonly allowedActions?: readonly PlanActionKind[]
  readonly allowedTools?: readonly string[]
  readonly allowedTemplates?: readonly string[]
  readonly allowedRoles?: readonly string[]
}

export class PlanValidationError extends Error {
  constructor(readonly issues: readonly PlanValidationIssue[]) {
    super(`Plan proposal rejected: ${issues.map(issue => `${issue.path} ${issue.code}`).join(", ")}`)
    this.name = "PlanValidationError"
  }
}

const NODE_KEYS = ["localId", "kind", "objective", "inputRefs", "dependsOn", "successCriteria", "outputSchemaRef", "budgetRequest", "toolName", "tool", "template", "role", "taskType", "constraints", "question", "approvalBoundary", "joinMode", "timeoutMs"]
const TOP_KEYS = ["schemaVersion", "basedOnGoalRevision", "basedOnPlanRevision", "nodes", "completionCriteria", "briefRationale"]
const IDENTITY_KEYS = new Set(["userId", "sessionId", "turnId", "stepId", "taskId", "parentTaskId", "rootTaskId", "ownerId", "lease", "leaseOwnerId", "leaseVersion", "idempotencyKey", "capabilities", "permissions", "allowedCapabilities", "budgetLimit", "maxBudget"])
const KINDS: readonly PlanActionKind[] = ["use_tool", "delegate", "join", "request_input", "propose_completion"]

function row(value: unknown): Record<string, unknown> | null {
  return isPlainJsonObject(value) ? value : null
}

function add(issues: PlanValidationIssue[], path: string, code: string, message: string): void { issues.push({ path, code, message }) }

function keys(value: Record<string, unknown>, allowed: readonly string[], path: string, issues: PlanValidationIssue[]): void {
  const permitted = new Set(allowed)
  for (const key of Object.keys(value)) {
    if (IDENTITY_KEYS.has(key)) add(issues, `${path}.${key}`, "forbidden_field", "Runtime identity and permission fields are server-owned")
    else if (!permitted.has(key)) add(issues, `${path}.${key}`, "unknown_field", "Unknown plan field")
  }
}

function stringValue(value: unknown, path: string, issues: PlanValidationIssue[], max: number, required = true): string | null {
  if (value === undefined && !required) return null
  if (typeof value !== "string") { add(issues, path, "invalid_string", "Expected a string"); return null }
  const trimmed = value.trim()
  if (!trimmed) add(issues, path, "empty_string", "String must not be empty")
  if (trimmed.length > max) add(issues, path, "too_long", `String exceeds ${max} characters`)
  return trimmed
}

function revision(value: unknown, path: string, issues: PlanValidationIssue[], nullable = false): number | null {
  if (nullable && value === null) return null
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) { add(issues, path, "invalid_revision", "Revision must be a non-negative integer"); return null }
  return value
}

function list(value: unknown, path: string, issues: PlanValidationIssue[], maxItems: number, maxString: number): string[] {
  if (!Array.isArray(value)) { add(issues, path, "invalid_array", "Expected an array"); return [] }
  if (value.length > maxItems) add(issues, path, "too_many_items", `Array exceeds ${maxItems} items`)
  const seen = new Set<string>()
  return value.flatMap((item, index) => {
    const parsed = stringValue(item, `${path}.${index}`, issues, maxString)
    if (!parsed) return []
    if (seen.has(parsed)) add(issues, `${path}.${index}`, "duplicate_value", "Array values must be unique")
    seen.add(parsed)
    return [parsed]
  })
}

function budget(value: unknown, path: string, issues: PlanValidationIssue[]): PlanBudgetRequest | undefined {
  if (value === undefined) return undefined
  if (typeof value === "string") return stringValue(value, path, issues, 256) ?? undefined
  const parsed = row(value)
  if (!parsed) { add(issues, path, "invalid_budget_request", "Budget request must be a reference string or bounded object"); return undefined }
  keys(parsed, ["ref", "units"], path, issues)
  const ref = stringValue(parsed.ref, `${path}.ref`, issues, 256)
  if (parsed.units !== undefined && (typeof parsed.units !== "number" || !Number.isSafeInteger(parsed.units) || parsed.units < 1 || parsed.units > 8)) add(issues, `${path}.units`, "invalid_budget_request", "Requested units must be an integer from 1 to 8")
  return ref ? { ref, ...(parsed.units === undefined ? {} : { units: parsed.units as number }) } : undefined
}

function parseNode(value: unknown, index: number, issues: PlanValidationIssue[]): PlanNode | null {
  const path = `nodes.${index}`
  const parsed = row(value)
  if (!parsed) { add(issues, path, "invalid_node", "Node must be a plain object"); return null }
  keys(parsed, NODE_KEYS, path, issues)
  const localId = stringValue(parsed.localId, `${path}.localId`, issues, 128)
  const kind = stringValue(parsed.kind, `${path}.kind`, issues, 32)
  const objective = stringValue(parsed.objective, `${path}.objective`, issues, 4_000)
  const inputRefs = list(parsed.inputRefs, `${path}.inputRefs`, issues, 16, 128)
  const dependsOn = list(parsed.dependsOn, `${path}.dependsOn`, issues, PLAN_MAX_NODES, 128)
  const successCriteria = list(parsed.successCriteria, `${path}.successCriteria`, issues, 16, 1_000)
  const outputSchemaRef = parsed.outputSchemaRef === undefined || parsed.outputSchemaRef === null ? null : stringValue(parsed.outputSchemaRef, `${path}.outputSchemaRef`, issues, 256)
  const budgetRequest = budget(parsed.budgetRequest, `${path}.budgetRequest`, issues)
  const joinModeValue = parsed.joinMode === undefined && kind === "join" ? "all" : parsed.joinMode
  const joinMode = joinModeValue === undefined ? undefined : stringValue(joinModeValue, `${path}.joinMode`, issues, 8, false)
  const timeoutMs = parsed.timeoutMs
  const node: PlanNode = {
    localId: localId ?? "", kind: (KINDS.includes(kind as PlanActionKind) ? kind : "propose_completion") as PlanActionKind, objective: objective ?? "", inputRefs, dependsOn, successCriteria, outputSchemaRef,
    ...(budgetRequest === undefined ? {} : { budgetRequest }),
    ...(parsed.toolName === undefined ? {} : { toolName: stringValue(parsed.toolName, `${path}.toolName`, issues, 256) ?? "" }),
    ...(parsed.tool === undefined ? {} : { tool: stringValue(parsed.tool, `${path}.tool`, issues, 256) ?? "" }),
    ...(parsed.template === undefined ? {} : { template: stringValue(parsed.template, `${path}.template`, issues, 256) ?? "" }),
    ...(parsed.role === undefined ? {} : { role: stringValue(parsed.role, `${path}.role`, issues, 64) ?? "" }),
    ...(parsed.taskType === undefined ? {} : { taskType: stringValue(parsed.taskType, `${path}.taskType`, issues, 128) ?? "" }),
    ...(parsed.constraints === undefined ? {} : { constraints: list(parsed.constraints, `${path}.constraints`, issues, 16, 1_000) }),
    ...(parsed.question === undefined ? {} : { question: stringValue(parsed.question, `${path}.question`, issues, 4_000) ?? "" }),
    ...(parsed.approvalBoundary === undefined ? {} : { approvalBoundary: stringValue(parsed.approvalBoundary, `${path}.approvalBoundary`, issues, 1_000) ?? "" }),
    ...(joinMode === undefined ? {} : { joinMode: joinMode as "any" | "all" }),
    ...(timeoutMs === undefined ? {} : { timeoutMs: timeoutMs as number }),
  }
  if (!KINDS.includes(kind as PlanActionKind)) add(issues, `${path}.kind`, "unknown_action", "Unsupported plan action kind")
  if (node.kind === "use_tool" && !node.toolName && !node.tool) add(issues, path, "tool_required", "use_tool requires toolName or tool")
  if (node.toolName && node.tool && node.toolName !== node.tool) add(issues, path, "tool_conflict", "toolName and tool must match")
  if (node.kind === "delegate") {
    if (!node.role) add(issues, `${path}.role`, "role_required", "delegate requires role")
    if (!node.taskType) add(issues, `${path}.taskType`, "task_type_required", "delegate requires taskType")
  }
  if (node.kind === "request_input" && !node.question) add(issues, `${path}.question`, "question_required", "request_input requires question")
  if (node.kind === "join") {
    if (node.inputRefs.length === 0) add(issues, `${path}.inputRefs`, "join_targets_required", "join requires at least one delegate reference")
    if (node.joinMode !== "any" && node.joinMode !== "all") add(issues, `${path}.joinMode`, "invalid_join_mode", "joinMode must be any or all")
    if (typeof timeoutMs !== "number" || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) add(issues, `${path}.timeoutMs`, "invalid_join_timeout", "timeoutMs must be an integer from 1 to 30000")
  } else {
    if (parsed.joinMode !== undefined) add(issues, `${path}.joinMode`, "join_field_forbidden", "joinMode is only valid for join nodes")
    if (parsed.timeoutMs !== undefined) add(issues, `${path}.timeoutMs`, "join_field_forbidden", "timeoutMs is only valid for join nodes")
  }
  return node
}

function parseProposal(value: unknown, issues: PlanValidationIssue[], maxNodes: number): PlanProposal | null {
  const parsed = row(value)
  if (!parsed) { add(issues, "plan", "invalid_plan", "Plan proposal must be a plain object"); return null }
  keys(parsed, TOP_KEYS, "plan", issues)
  if (parsed.schemaVersion !== PLAN_PROPOSAL_SCHEMA_VERSION) add(issues, "schemaVersion", "schema_version_mismatch", `Expected ${PLAN_PROPOSAL_SCHEMA_VERSION}`)
  const goalRevision = revision(parsed.basedOnGoalRevision, "basedOnGoalRevision", issues)
  const planRevision = revision(parsed.basedOnPlanRevision, "basedOnPlanRevision", issues, true)
  if (goalRevision !== null && goalRevision < 1) add(issues, "basedOnGoalRevision", "invalid_revision", "Goal revision must be positive")
  if (!Array.isArray(parsed.nodes)) add(issues, "nodes", "invalid_array", "Expected an array")
  if (Array.isArray(parsed.nodes) && parsed.nodes.length > maxNodes) add(issues, "nodes", "too_many_nodes", `Plan exceeds ${maxNodes} nodes`)
  const nodes = Array.isArray(parsed.nodes) ? parsed.nodes.slice(0, maxNodes).map((node, index) => parseNode(node, index, issues)).filter((node): node is PlanNode => node !== null) : []
  const completionCriteria = list(parsed.completionCriteria, "completionCriteria", issues, 16, 1_000)
  const briefRationale = stringValue(parsed.briefRationale, "briefRationale", issues, 2_000)
  if (goalRevision === null || (planRevision === null && parsed.basedOnPlanRevision !== null)) return null
  return { schemaVersion: PLAN_PROPOSAL_SCHEMA_VERSION, basedOnGoalRevision: goalRevision, basedOnPlanRevision: planRevision, nodes, completionCriteria, briefRationale: briefRationale ?? "" }
}

function graphIssues(nodes: readonly PlanNode[], issues: PlanValidationIssue[]): void {
  const ids = new Set<string>()
  for (const [index, node] of nodes.entries()) {
    if (ids.has(node.localId)) add(issues, `nodes.${index}.localId`, "duplicate_local_id", "localId must be unique")
    ids.add(node.localId)
  }
  for (const [index, node] of nodes.entries()) for (const dependency of node.dependsOn) {
    if (!ids.has(dependency)) add(issues, `nodes.${index}.dependsOn`, "missing_dependency", `Unknown dependency ${dependency}`)
    if (dependency === node.localId) add(issues, `nodes.${index}.dependsOn`, "self_dependency", "A node cannot depend on itself")
  }
  const byId = new Map(nodes.map(node => [node.localId, node]))
  for (const [index, node] of nodes.entries()) if (node.kind === "join") for (const ref of node.inputRefs) {
    const target = byId.get(ref)
    if (!target) add(issues, `nodes.${index}.inputRefs`, "join_target_missing", `Unknown join target ${ref}`)
    else if (target.kind !== "delegate") add(issues, `nodes.${index}.inputRefs`, "join_target_not_delegate", `Join target ${ref} must be a delegate`)
    if (!node.dependsOn.includes(ref)) add(issues, `nodes.${index}.dependsOn`, "join_dependency_required", `Join must depend on ${ref}`)
  }
  const state = new Map<string, number>()
  const visit = (node: PlanNode): void => {
    if (state.get(node.localId) === 1) { add(issues, `nodes.${nodes.indexOf(node)}.dependsOn`, "dependency_cycle", "Dependency graph must be acyclic"); return }
    if (state.get(node.localId) === 2) return
    state.set(node.localId, 1)
    for (const dependency of node.dependsOn) { const target = nodes.find(candidate => candidate.localId === dependency); if (target) visit(target) }
    state.set(node.localId, 2)
  }
  for (const node of nodes) visit(node)
}

function actionIssues(nodes: readonly PlanNode[], context: PlanValidationContext, issues: PlanValidationIssue[]): void {
  const delegates = new Map<string, number>()
  for (const [index, node] of nodes.entries()) {
    const path = `nodes.${index}`
    if (context.allowedActions && !context.allowedActions.includes(node.kind)) add(issues, `${path}.kind`, "action_not_allowed", "Action is not in the server allowlist")
    const toolName = node.toolName ?? node.tool
    if (node.kind === "use_tool" && toolName) {
      if (context.allowedTools && !context.allowedTools.includes(toolName)) add(issues, `${path}.toolName`, "unknown_tool", "Tool is not in the server allowlist")
      if (externalWriteLike(toolName)) add(issues, `${path}.toolName`, "external_write_forbidden", "External writes are runtime-owned and cannot be planned")
    }
    if (node.template && context.allowedTemplates && !context.allowedTemplates.includes(node.template)) add(issues, `${path}.template`, "unknown_template", "Template is not in the server allowlist")
    if (node.template && externalWriteLike(node.template)) add(issues, `${path}.template`, "external_write_forbidden", "External writes are runtime-owned and cannot be planned")
    if (node.role && context.allowedRoles && !context.allowedRoles.includes(node.role)) add(issues, `${path}.role`, "unknown_role", "Role is not in the server allowlist")
    if (node.role && /^(system|orchestrator|admin|root)$/i.test(node.role)) add(issues, `${path}.role`, "permission_expansion", "Plan cannot grant an elevated runtime role")
    if (node.kind === "delegate" && node.role && node.taskType) {
      const signature = JSON.stringify([node.role, node.taskType, node.objective, [...node.inputRefs].sort(), [...node.dependsOn].sort()])
      const previous = delegates.get(signature)
      if (previous === undefined) delegates.set(signature, index)
      else add(issues, path, "duplicate_spawn", `Delegate duplicates nodes.${previous}`)
    }
  }
}

function externalWriteLike(value: string): boolean {
  return /(?:external|application\.submit|browser\.submit|gmail\.(?:send|delete)|(?:^|[._-])(?:submit|publish|delete|mutate)(?:$|[._-]))/i.test(value)
}

export function findPlanValidationIssues(value: unknown, context: PlanValidationContext): PlanValidationIssue[] {
  const issues: PlanValidationIssue[] = []
  if (!Number.isSafeInteger(context.goalRevision) || context.goalRevision < 1) add(issues, "context.goalRevision", "invalid_revision", "Expected a positive goal revision")
  const maxNodes = context.maxNodes ?? PLAN_MAX_NODES
  if (!Number.isSafeInteger(maxNodes) || maxNodes < 1 || maxNodes > PLAN_MAX_NODES) add(issues, "context.maxNodes", "invalid_bound", `maxNodes must be between 1 and ${PLAN_MAX_NODES}`)
  const proposal = parseProposal(value, issues, Number.isSafeInteger(maxNodes) && maxNodes > 0 ? Math.min(maxNodes, PLAN_MAX_NODES) : PLAN_MAX_NODES)
  if (proposal) {
    if (proposal.basedOnGoalRevision !== context.goalRevision) add(issues, "basedOnGoalRevision", "goal_revision_conflict", "Proposal does not match the current goal revision")
    const expectedPlan = context.planRevision !== undefined ? context.planRevision : context.currentPlanRevision
    if (expectedPlan !== undefined && proposal.basedOnPlanRevision !== expectedPlan) add(issues, "basedOnPlanRevision", "plan_revision_conflict", "Proposal does not match the current plan revision")
    graphIssues(proposal.nodes, issues)
    actionIssues(proposal.nodes, context, issues)
  }
  return issues.sort((left, right) => left.path.localeCompare(right.path) || left.code.localeCompare(right.code) || left.message.localeCompare(right.message))
}

export function validatePlanProposal(value: unknown, context: PlanValidationContext): PlanProposal {
  const issues = findPlanValidationIssues(value, context)
  if (issues.length > 0) throw new PlanValidationError(issues)
  return normalizePlanProposal(value)
}

export function normalizePlanProposal(value: unknown): PlanProposal {
  const issues: PlanValidationIssue[] = []
  const proposal = parseProposal(value, issues, PLAN_MAX_NODES)
  if (!proposal || issues.length > 0) throw new PlanValidationError(issues.length > 0 ? issues : [{ path: "plan", code: "invalid_plan", message: "Plan proposal is invalid" }])
  return proposal
}
