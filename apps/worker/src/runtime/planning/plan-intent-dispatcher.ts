import { isPlainJsonObject, type PlanNode, type PlanProposal } from "./goal-plan-contract.js"
import { PlanValidationError, type PlanValidationContext, validatePlanProposal } from "./goal-plan-validator.js"

export type PlanDispatchErrorCode = "unknown_tool" | "input_reference_unavailable" | "role_actions_unavailable" | "control_barrier" | "invalid_plan"
export type PlanDispatchIssue = { readonly path: string; readonly code: string; readonly message: string }

export class PlanDispatchError extends Error {
  constructor(readonly code: PlanDispatchErrorCode, message: string, readonly issues: readonly PlanDispatchIssue[] = []) {
    super(message)
    this.name = "PlanDispatchError"
  }
}

export type PlanInputReferenceRequest = {
  readonly localId: string
  readonly inputRefs: readonly string[]
  readonly dependsOn: readonly string[]
}

export type PlanDispatchRuntime = {
  readonly resolveToolVersion?: (toolName: string) => string | undefined
  readonly createToolCallId?: (localId: string) => string
  readonly createIdempotencyKey?: (localId: string) => string
  readonly resolveInputRefs?: (request: PlanInputReferenceRequest) => unknown
  /** Keep references as runtime-owned inputs until each command is executed. */
  readonly deferInputRefs?: boolean
  readonly resolveWaitVersion?: () => string | undefined
  readonly resolveDelegateActions?: (role: string) => readonly string[] | undefined
}

type CommandBase = {
  readonly localId: string
  readonly objective: string
  readonly inputRefs: readonly string[]
  readonly dependsOn: readonly string[]
  readonly successCriteria: readonly string[]
  readonly outputSchemaRef: string | null
  /** Internal marker: references must be resolved by the command executor. */
  readonly inputRefsDeferred?: boolean
}

export type PlanDispatchCommand =
  | (CommandBase & { readonly kind: "tool_call"; readonly call: { readonly id: string; readonly toolName: string; readonly toolVersion: string; readonly input: Record<string, unknown> } })
  | (CommandBase & { readonly kind: "delegate"; readonly call: { readonly id: string; readonly toolName: "spawn_subagent"; readonly toolVersion: "1"; readonly input: { readonly idempotencyKey: string; readonly role: string; readonly taskType: string; readonly goal: string; readonly constraints: readonly string[]; readonly successCriteria: readonly string[]; readonly allowedActions: readonly string[]; readonly context?: Record<string, unknown> } } })
  | (CommandBase & { readonly kind: "join"; readonly call: { readonly id: string; readonly toolName: "wait_subagents"; readonly toolVersion: "1"; readonly input: { readonly idempotencyKey: string; readonly taskIds: readonly string[]; readonly mode: "any" | "all"; readonly timeoutMs: number } } })
  | (CommandBase & { readonly kind: "request_input"; readonly question: string; readonly approvalBoundary?: string })
  | (CommandBase & { readonly kind: "propose_completion"; readonly completionCriteria: readonly string[] })

export type PlanDispatchResult = {
  readonly proposal: PlanProposal
  readonly commands: readonly PlanDispatchCommand[]
  readonly blockedAfterLocalId?: string
}

function boundedIssues(issues: readonly { readonly path: string; readonly code: string; readonly message: string }[]): readonly PlanDispatchIssue[] {
  return issues.slice(0, 16).map(issue => ({ path: issue.path.slice(0, 256), code: issue.code.slice(0, 64), message: issue.message.slice(0, 256) }))
}

function dispatchInvalid(error: unknown): never {
  if (error instanceof PlanValidationError) throw new PlanDispatchError("invalid_plan", "Plan proposal failed deterministic validation", boundedIssues(error.issues))
  throw new PlanDispatchError("invalid_plan", "Plan proposal failed deterministic validation")
}

function plainJsonValue(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true
  if (typeof value === "number") return Number.isFinite(value)
  if (typeof value !== "object" || seen.has(value)) return false
  if (!Array.isArray(value) && !isPlainJsonObject(value)) return false
  seen.add(value)
  const valid = Object.values(value).every(item => plainJsonValue(item, seen))
  seen.delete(value)
  return valid
}

function runtimeString(callback: (() => unknown) | undefined, code: PlanDispatchErrorCode, message: string): string {
  let value: unknown
  try { value = callback?.() } catch { value = undefined }
  if (typeof value !== "string" || !value.trim()) throw new PlanDispatchError(code, message)
  return value.trim()
}

function toolVersion(runtime: PlanDispatchRuntime, toolName: string): string {
  return runtimeString(runtime.resolveToolVersion ? () => runtime.resolveToolVersion!(toolName) : undefined, "unknown_tool", "Tool version is unavailable")
}

function callId(runtime: PlanDispatchRuntime, localId: string): string {
  return runtimeString(runtime.createToolCallId ? () => runtime.createToolCallId!(localId) : undefined, "invalid_plan", "Runtime tool call identity is unavailable")
}

function input(runtime: PlanDispatchRuntime, node: PlanNode): Record<string, unknown> {
  if (node.inputRefs.length === 0) return {}
  if (runtime.deferInputRefs) return {}
  let value: unknown
  try { value = runtime.resolveInputRefs?.({ localId: node.localId, inputRefs: [...node.inputRefs], dependsOn: [...node.dependsOn] }) } catch { value = undefined }
  if (!isPlainJsonObject(value) || !plainJsonValue(value)) throw new PlanDispatchError("input_reference_unavailable", "Plan input references are unavailable")
  return value
}

function actions(runtime: PlanDispatchRuntime, role: string): readonly string[] {
  let value: readonly string[] | undefined
  try { value = runtime.resolveDelegateActions?.(role) } catch { value = undefined }
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) throw new PlanDispatchError("role_actions_unavailable", "Delegate role actions are unavailable")
  const result = value.map(action => typeof action === "string" ? action.trim() : "")
  if (result.some(action => !action || action.length > 1_000)) throw new PlanDispatchError("role_actions_unavailable", "Delegate role actions are unavailable")
  return result
}

function topo(nodes: readonly PlanNode[]): readonly PlanNode[] {
  const position = new Map(nodes.map((node, index) => [node.localId, index]))
  const byId = new Map(nodes.map(node => [node.localId, node]))
  const indegree = new Map(nodes.map(node => [node.localId, node.dependsOn.length]))
  const dependents = new Map<string, string[]>()
  for (const node of nodes) for (const dependency of node.dependsOn) dependents.set(dependency, [...(dependents.get(dependency) ?? []), node.localId])
  const ready = nodes.filter(node => indegree.get(node.localId) === 0).map(node => node.localId)
  const result: PlanNode[] = []
  while (ready.length > 0) {
    ready.sort((left, right) => (position.get(left) ?? 0) - (position.get(right) ?? 0) || left.localeCompare(right))
    const id = ready.shift()!
    const node = byId.get(id)
    if (!node) throw new PlanDispatchError("invalid_plan", "Plan dependency graph is invalid")
    result.push(node)
    for (const dependent of dependents.get(id) ?? []) {
      const next = (indegree.get(dependent) ?? 0) - 1
      indegree.set(dependent, next)
      if (next === 0) ready.push(dependent)
    }
  }
  if (result.length !== nodes.length) throw new PlanDispatchError("invalid_plan", "Plan dependency graph is cyclic")
  return result
}

function base(node: PlanNode, runtime: PlanDispatchRuntime): CommandBase {
  return { localId: node.localId, objective: node.objective, inputRefs: [...node.inputRefs], dependsOn: [...node.dependsOn], successCriteria: [...node.successCriteria], outputSchemaRef: node.outputSchemaRef, ...(runtime.deferInputRefs && node.inputRefs.length > 0 ? { inputRefsDeferred: true } : {}) }
}

function command(node: PlanNode, runtime: PlanDispatchRuntime, planCompletionCriteria: readonly string[]): PlanDispatchCommand {
  const shared = base(node, runtime)
  if (node.kind === "use_tool") {
    const toolName = node.toolName ?? node.tool
    if (!toolName) throw new PlanDispatchError("unknown_tool", "Plan tool name is unavailable")
    return { ...shared, kind: "tool_call", call: { id: callId(runtime, node.localId), toolName, toolVersion: toolVersion(runtime, toolName), input: input(runtime, node) } }
  }
  if (node.kind === "delegate") {
    const role = node.role ?? ""
    const idempotencyKey = runtimeString(runtime.createIdempotencyKey ? () => runtime.createIdempotencyKey!(node.localId) : undefined, "invalid_plan", "Runtime delegate identity is unavailable")
    return { ...shared, kind: "delegate", call: { id: callId(runtime, node.localId), toolName: "spawn_subagent", toolVersion: "1", input: { idempotencyKey, role, taskType: node.taskType ?? "", goal: node.objective, constraints: [...(node.constraints ?? [])], successCriteria: [...node.successCriteria], allowedActions: actions(runtime, role) } } }
  }
  if (node.kind === "join") {
    const waitVersion = runtime.resolveWaitVersion ? runtimeString(runtime.resolveWaitVersion, "unknown_tool", "Wait tool version is unavailable") : "1"
    if (waitVersion !== "1") throw new PlanDispatchError("unknown_tool", "Wait tool version is unavailable")
    const idempotencyKey = runtimeString(runtime.createIdempotencyKey ? () => runtime.createIdempotencyKey!(node.localId) : undefined, "invalid_plan", "Runtime join identity is unavailable")
    return { ...shared, kind: "join", call: { id: callId(runtime, node.localId), toolName: "wait_subagents", toolVersion: "1", input: { idempotencyKey, taskIds: [], mode: node.joinMode ?? "all", timeoutMs: node.timeoutMs as number } } }
  }
  if (node.kind === "request_input") return { ...shared, kind: "request_input", question: node.question ?? "", ...(node.approvalBoundary ? { approvalBoundary: node.approvalBoundary } : {}) }
  return { ...shared, kind: "propose_completion", completionCriteria: [...new Set([...planCompletionCriteria, ...node.successCriteria])] }
}

export function dispatchPlanProposal(value: unknown, validation: PlanValidationContext, runtime: PlanDispatchRuntime): PlanDispatchResult {
  let proposal: PlanProposal
  try { proposal = validatePlanProposal(value, validation) } catch (error: unknown) { return dispatchInvalid(error) }
  const commands: PlanDispatchCommand[] = []
  for (const node of topo(proposal.nodes)) {
    commands.push(command(node, runtime, proposal.completionCriteria))
    if (node.kind === "request_input" || node.kind === "propose_completion") return { proposal, commands, blockedAfterLocalId: node.localId }
  }
  return { proposal, commands }
}
