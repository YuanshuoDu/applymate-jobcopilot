import { Buffer } from "node:buffer"

import type { PolicyEngine } from "@jobcopilot/agent-policy"
import type { PolicyDomain, PolicyRole, TenantScope } from "@jobcopilot/agent-protocol"

import { copyAllowedPlanActions, PLAN_MAX_NODES, PLAN_MAX_REVISIONS, isPlainJsonObject, type GoalContract, type GoalContractRef, type PlanActionKind } from "./goal-plan-contract.js"
import { PlanDispatchError, dispatchPlanProposal, type PlanDispatchCommand } from "./plan-intent-dispatcher.js"
import { copyPlanFingerprints, fingerprintPlanProposal, isPlanFingerprint } from "./plan-fingerprint.js"
import { PlanValidationError, validatePlanProposal } from "./goal-plan-validator.js"
import { PlanCommandExecutionError, executePlanCommands, type PlanCommandExecutionRecord, type PlanCommandExecutionRuntime, type PlanControlRecord, type PlanInputReferenceResolutionRequest, type PlanJoinCommand } from "./plan-command-executor.js"
import { createPlanCommandReceipt, type PlanCommandReceipt } from "./plan-command-receipt.js"
import { PlanRevisionRecoveryError, recoverPlanRevision, type PlanRevisionRecoveryDispatcher } from "./plan-revision-receipt.js"
import type { DelegateOutputSchemaMarker, ToolCallRequest, ToolExecutionResult, ToolRouterContext } from "../tools/types.js"
import { READ_ONLY_TOOL_NAMES, TOOL_RESULTS_READ_NAME } from "../tools/index.js"
import { canonicalQuestionId, type TurnEnginePlanExecutionHook, type TurnEnginePlanExecutionHookResult } from "../turns/turn-engine-types.js"
import type { StepContextSnapshot } from "../context/step-context-builder.js"
import { getSubagentRolePolicy, visibleToolPolicy } from "../subagents/role-policy.js"
import { ROLE_RESULT_SCHEMA, validateRoleResult } from "../subagents/role-results.js"
import { validateBoundStructuredEvidence } from "./structured-replay-evidence.js"
import { inspectJoinFailureEvidence, replanRequiredControl } from "./plan-replan-signal.js"
import { derivePlannerCapabilityCatalog } from "./planner-capabilities.js"
import { createPlanTaskGraphAdapter, hydratePlanTaskGraph, PlanTaskGraphAdapterError, type PersistedTaskGraphEvent, type PlanTaskGraphAdapter, type PlanTaskGraphAdapterOptions } from "./plan-task-graph-adapter.js"
import type { TaskGraphEvent, TaskGraphState } from "./task-graph-reducer.js"

const MAX_OBSERVATIONS = 8
const MAX_RESULT_BYTES = 8 * 1024
const CANONICAL_PARALLEL_DELEGATE_LIMIT = 4
const OUTPUT_KEYS = ["status", "goalRevision", "planRevision", "basedOnPlanRevision", "proposal", "intents", "proposalHash"]
const CANONICAL_WAIT_TOOL_NAME = "agent.wait" as const
const LEGACY_WAIT_TOOL_NAME = "wait_subagents" as const
const WAIT_TOOL_NAMES = [CANONICAL_WAIT_TOOL_NAME, LEGACY_WAIT_TOOL_NAME] as const
const CANONICAL_RECOVERY_READ_TOOLS = new Set<string>([...READ_ONLY_TOOL_NAMES, TOOL_RESULTS_READ_NAME])
type WaitToolName = typeof WAIT_TOOL_NAMES[number]

type Registry = { list(capabilities?: readonly string[]): readonly unknown[] }
type Router = { execute(context: ToolRouterContext, request: ToolCallRequest): Promise<ToolExecutionResult> }
type PersistAtomicTerminal = (input: {
  readonly runKey: string
  readonly event: TaskGraphEvent
  readonly state: TaskGraphState
  readonly receipt: PlanCommandReceipt
}) => Promise<void> | void

function isWaitToolName(value: unknown): value is WaitToolName {
  return typeof value === "string" && WAIT_TOOL_NAMES.includes(value as WaitToolName)
}

export type CanonicalPlanExecutionOptions = {
  readonly goal: GoalContract
  readonly goalRef?: GoalContractRef
  readonly allowedTools: readonly string[]
  readonly allowedTemplates: readonly string[]
  readonly allowedRoles: readonly string[]
  /** Server-owned action capability gate; omitted means all plan actions remain compatible. */
  readonly allowedPlanActions?: readonly PlanActionKind[]
  readonly maxNodes: number
  readonly initialPlanRevision?: number | null
  readonly capabilities: readonly string[]
  readonly actorRole: PolicyRole
  readonly scope: TenantScope
  readonly lease: { readonly sessionId: string; readonly turnId: string }
  readonly rootTaskId: string
  readonly taskId: string
  readonly router: Router
  readonly registry: Registry
  readonly policy: PolicyEngine
  readonly persistOutcome?: (receipt: PlanCommandReceipt) => Promise<void> | void
  readonly persistTaskGraph?: (input: { readonly runKey: string; readonly event: TaskGraphEvent; readonly state: TaskGraphState }) => Promise<void> | void
  readonly persistAtomicTerminal?: PersistAtomicTerminal
  readonly initialTaskGraphEvents?: readonly PersistedTaskGraphEvent[]
  /** Server-owned upper bound for accepted revisions. */
  readonly maxPlanRevisions?: number
  /** Server-owned hashes recovered from prior accepted proposals. */
  readonly initialPlanHashes?: readonly string[]
  /** Runtime-owned dispatcher used only to repair a persisted replay receipt. */
  readonly recoveryDispatcher?: PlanRevisionRecoveryDispatcher
}

class CanonicalPlanError extends Error {
  constructor(readonly code: string) {
    super("Plan execution was rejected")
    this.name = "CanonicalPlanError"
  }
}

function plainJson(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true
  if (typeof value === "number") return Number.isFinite(value)
  if (typeof value !== "object" || seen.has(value)) return false
  if (!Array.isArray(value) && !isPlainJsonObject(value)) return false
  seen.add(value)
  const valid = Object.values(value).every(child => plainJson(child, seen))
  seen.delete(value)
  return valid
}

function accepted(value: unknown, goalRevision: number, expectedPlanRevision: number | null, maxPlanRevisions: number, replayed: boolean): { planRevision: number; basedOnPlanRevision: number | null; proposal: unknown; proposalHash: string } {
  if (!isPlainJsonObject(value) || !plainJson(value) || Object.keys(value).some(key => !OUTPUT_KEYS.includes(key))) throw new CanonicalPlanError("invalid_plan_output")
  if (value.status !== "accepted" || value.goalRevision !== goalRevision) throw new CanonicalPlanError("revision_conflict")
  const planRevision = value.planRevision
  const basedOnPlanRevision = value.basedOnPlanRevision
  if (typeof planRevision !== "number" || !Number.isSafeInteger(planRevision) || planRevision < 1 ||
    (basedOnPlanRevision !== null && (typeof basedOnPlanRevision !== "number" || !Number.isSafeInteger(basedOnPlanRevision) || basedOnPlanRevision < 0))) throw new CanonicalPlanError("invalid_plan_output")
  if (planRevision > maxPlanRevisions || (!replayed && expectedPlanRevision !== null && expectedPlanRevision >= maxPlanRevisions)) throw new CanonicalPlanError("plan_revision_limit")
  if (planRevision !== (basedOnPlanRevision === null ? 1 : basedOnPlanRevision + 1)) throw new CanonicalPlanError("revision_conflict")
  if (!replayed && (basedOnPlanRevision !== expectedPlanRevision || planRevision !== (expectedPlanRevision === null ? 1 : expectedPlanRevision + 1))) throw new CanonicalPlanError("revision_conflict")
  if (replayed && (expectedPlanRevision === null ? basedOnPlanRevision !== null : planRevision !== expectedPlanRevision)) throw new CanonicalPlanError("revision_conflict")
  if (!isPlainJsonObject(value.proposal) || !Array.isArray(value.intents) || value.intents.length > MAX_OBSERVATIONS || !isPlanFingerprint(value.proposalHash)) throw new CanonicalPlanError("invalid_plan_output")
  const encoded = JSON.stringify(value)
  if (encoded === undefined || Buffer.byteLength(encoded, "utf8") > 64 * 1024) throw new CanonicalPlanError("invalid_plan_output")
  return { planRevision, basedOnPlanRevision, proposal: value.proposal, proposalHash: value.proposalHash }
}

function id(prefix: string, callId: string, localId: string): string {
  const value = `${prefix}:${callId}:${localId}`
  if (value.length > 256) throw new CanonicalPlanError("invalid_plan_output")
  return value
}

function taskGraphRunKey(rootTaskId: string, planCallId: string, planRevision: number): string {
  const value = `${rootTaskId}:${planCallId}:${planRevision}`
  if (!rootTaskId.trim() || !planCallId.trim() || value.length > 256) throw new CanonicalPlanError("invalid_plan_output")
  return value
}

function version(registry: Registry, capabilities: readonly string[], name: string): string | undefined {
  const definition = registry.list(capabilities).find(item => isPlainJsonObject(item) && item.name === name && typeof item.version === "string")
  return definition && isPlainJsonObject(definition) && typeof definition.version === "string" ? definition.version.trim() : undefined
}

function waitVersion(registry: Registry, capabilities: readonly string[]): string | undefined {
  for (const name of WAIT_TOOL_NAMES) {
    const resolved = version(registry, capabilities, name)
    if (resolved !== undefined) return resolved
  }
  return undefined
}

const POLICY_DOMAINS: readonly PolicyDomain[] = ["jobs", "persona", "resume", "application", "gmail", "automation", "coordination", "unknown"]

function isPolicyDomain(value: unknown): value is PolicyDomain {
  return typeof value === "string" && POLICY_DOMAINS.includes(value as PolicyDomain)
}

function actions(registry: Registry, capabilities: readonly string[], allowedTools: readonly string[], role: string): readonly string[] {
  if (!getSubagentRolePolicy(role)) return []
  let definitions: readonly unknown[]
  try {
    definitions = registry.list(capabilities)
  } catch {
    return []
  }
  if (!Array.isArray(definitions)) return []
  return [...new Set(definitions.flatMap(item => {
    if (!isPlainJsonObject(item) || typeof item.name !== "string" || !allowedTools.includes(item.name)) return []
    if (item.risk !== "read" || !Array.isArray(item.capabilities) || !item.capabilities.every(capability => capability === "read")) return []
    if (!isPolicyDomain(item.domain) || (item.domain === "coordination" && item.name !== TOOL_RESULTS_READ_NAME) || !Array.isArray(item.requiredCapabilities) || !item.requiredCapabilities.every(capability => typeof capability === "string")) return []
    const visible = visibleToolPolicy(role, {
      name: item.name,
      risk: "read",
      domain: item.domain,
      capabilities: item.capabilities,
      requiredCapabilities: item.requiredCapabilities,
    })
    return visible.visible ? [item.name] : []
  }))]
}

function row(value: unknown): Record<string, unknown> | null { return isPlainJsonObject(value) ? value : null }

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
  if (isPlainJsonObject(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`
  return JSON.stringify(value) ?? "undefined"
}

const FORBIDDEN_INPUT_KEYS = new Set(["userId", "sessionId", "turnId", "stepId", "taskId", "parentTaskId", "rootTaskId", "ownerId", "lease", "leaseOwnerId", "leaseVersion", "idempotencyKey", "capabilities", "permissions", "allowedCapabilities", "budgetLimit", "maxBudget"])

function hasForbiddenInputKey(value: unknown, seen = new Set<object>()): boolean {
  if (!value || typeof value !== "object" || seen.has(value)) return false
  if (Array.isArray(value)) {
    seen.add(value)
    const found = value.some(item => hasForbiddenInputKey(item, seen))
    seen.delete(value)
    return found
  }
  if (!isPlainJsonObject(value)) return false
  if (Object.keys(value).some(key => FORBIDDEN_INPUT_KEYS.has(key))) return true
  seen.add(value)
  const found = Object.values(value).some(item => hasForbiddenInputKey(item, seen))
  seen.delete(value)
  return found
}

function resolveInputRefs(snapshot: StepContextSnapshot, request: PlanInputReferenceResolutionRequest): Record<string, unknown> {
  const merged: Record<string, unknown> = {}
  for (const ref of request.inputRefs) {
    const hasLocalOutput = request.outputs.has(ref)
    const observation = hasLocalOutput ? undefined : snapshot.toolObservations.find(item => item.id === ref)
    if (!hasLocalOutput && !observation) throw new CanonicalPlanError("input_reference_unavailable")
    const content = observation ? row(observation.content) : null
    const source = hasLocalOutput ? request.outputs.get(ref) : content && Object.prototype.hasOwnProperty.call(content, "output") ? content.output : observation?.content
    if (!isPlainJsonObject(source) || !plainJson(source)) throw new CanonicalPlanError("input_reference_unavailable")
    const encoded = JSON.stringify(source)
    if (encoded === undefined || Buffer.byteLength(encoded, "utf8") > MAX_RESULT_BYTES || hasForbiddenInputKey(source)) throw new CanonicalPlanError("input_reference_unavailable")
    for (const key of Object.keys(source).sort()) {
      if (Object.prototype.hasOwnProperty.call(merged, key) && stableJson(merged[key]) !== stableJson(source[key])) throw new CanonicalPlanError("input_reference_conflict")
      merged[key] = source[key]
    }
  }
  const encoded = JSON.stringify(merged)
  if (encoded === undefined || Buffer.byteLength(encoded, "utf8") > MAX_RESULT_BYTES) throw new CanonicalPlanError("input_reference_unavailable")
  return merged
}

function safeObservation(idValue: string, content: Record<string, unknown>): { id: string; content: Record<string, unknown> } {
  const encoded = JSON.stringify(content)
  if (encoded !== undefined && Buffer.byteLength(encoded, "utf8") <= MAX_RESULT_BYTES) return { id: idValue, content }
  return { id: idValue, content: { kind: "plan_observation", status: "truncated", truncated: true } }
}

function recordObservation(callId: string, recordValue: PlanCommandExecutionRecord): { id: string; content: Record<string, unknown> } {
  return safeObservation(id("plan-result", callId, recordValue.localId), {
    kind: "plan_command", localId: recordValue.localId, commandKind: recordValue.kind,
    dependsOn: [...recordValue.dependsOn], status: recordValue.result.status, errorCode: recordValue.result.errorCode,
    ...(recordValue.result.output === undefined ? {} : { output: recordValue.result.output }),
  })
}

function controlObservation(callId: string, control: PlanControlRecord): { id: string; content: Record<string, unknown> } {
  const content = control.kind === "request_input"
    ? { kind: "plan_control", localId: control.localId, status: "waiting_for_user", question: control.question, ...(control.approvalBoundary ? { approvalBoundary: control.approvalBoundary } : {}) }
    : control.kind === "propose_completion"
      ? { kind: "plan_control", localId: control.localId, status: "completion_proposed", dependsOn: [...control.dependsOn], completionCriteria: [...control.completionCriteria] }
      : { kind: "plan_control", localId: control.localId, status: "replan_required", dependsOn: [...control.dependsOn], reason: control.reason, failedTaskIds: [...control.failedTaskIds] }
  return safeObservation(id("plan-control", callId, control.localId), content)
}

function outcomeReceipt(callId: string, planRevision: number, recordValue: PlanCommandExecutionRecord | PlanControlRecord): PlanCommandReceipt {
  const observation = "result" in recordValue ? recordObservation(callId, recordValue) : controlObservation(callId, recordValue)
  return createPlanCommandReceipt({ planCallId: callId, planRevision, observationId: observation.id, content: observation.content })
}

function failureObservation(callId: string, code: string): { id: string; content: Record<string, unknown> } {
  return safeObservation(`plan-error:${callId}`, { kind: "plan_error", status: "failed", errorCode: code.slice(0, 64) })
}

function planAdmission(input: Parameters<TurnEnginePlanExecutionHook>[0]): (count: number) => void {
  return count => {
    if (!input.admitPlanCommands) return
    try {
      input.admitPlanCommands(count)
    } catch {
      throw new PlanCommandExecutionError("plan_budget_exhausted", "Plan command budget exhausted")
    }
  }
}

function waitFrom(recordValue: PlanCommandExecutionRecord): TurnEnginePlanExecutionHookResult["wait"] | undefined {
  if (recordValue.result.status !== "completed") return undefined
  const output = row(recordValue.result.output)
  if (!output) return undefined
  const status = output.status
  if (status === "waiting" || status === "waiting_for_dependency") {
    if (typeof output.waitId !== "string" || !output.waitId.trim()) return undefined
    return { status: "waiting_for_dependency", waitId: output.waitId.trim(), errorCode: "plan_dependency_wait" }
  }
  if (status === "waiting_for_approval" || status === "waiting_for_user") return { status, errorCode: `plan_${status}` }
  return undefined
}

function boundedRecords(result: { readonly completed: readonly PlanCommandExecutionRecord[]; readonly failure?: PlanCommandExecutionRecord; readonly waiting?: PlanCommandExecutionRecord }): readonly PlanCommandExecutionRecord[] {
  const waiting: PlanCommandExecutionRecord[] = result.waiting ? [result.waiting] : []
  const records = result.failure ? [...result.completed, result.failure] : [...result.completed, ...waiting]
  return records.length <= MAX_OBSERVATIONS ? records : [...records.slice(0, MAX_OBSERVATIONS - 1), records[records.length - 1]!]
}

type ReplayCommandReceipt = {
  readonly observationId: string
  readonly status: "completed" | "failed" | "cancelled"
  readonly output?: unknown
  readonly errorCode: string | null
}

function keysOnly(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every(key => keys.includes(key))
}

function replayReceipt(snapshot: StepContextSnapshot, callId: string, command: PlanDispatchCommand): ReplayCommandReceipt | null {
  const control = command.kind === "request_input" || command.kind === "propose_completion"
  const observationId = id(control ? "plan-control" : "plan-result", callId, command.localId)
  const matches = snapshot.toolObservations.filter(observation => observation.id === observationId)
  if (matches.length > 1) throw new CanonicalPlanError("invalid_plan_output")
  const observation = matches[0]
  if (!observation) return null
  const content = row(observation.content)
  if (!content) throw new CanonicalPlanError("invalid_plan_output")
  if (control) {
    if (!keysOnly(content, command.kind === "request_input" ? ["kind", "localId", "status", "question", "approvalBoundary"] : ["kind", "localId", "status", "dependsOn", "completionCriteria"]) || content.kind !== "plan_control" || content.localId !== command.localId) throw new CanonicalPlanError("invalid_plan_output")
    if (command.kind === "request_input") {
      if (content.status !== "waiting_for_user" || content.question !== command.question ||
        (command.approvalBoundary === undefined ? content.approvalBoundary !== undefined : content.approvalBoundary !== command.approvalBoundary)) throw new CanonicalPlanError("invalid_plan_output")
    } else if (content.status !== "completion_proposed" || stableJson(content.dependsOn) !== stableJson(command.dependsOn) || stableJson(content.completionCriteria) !== stableJson(command.completionCriteria)) throw new CanonicalPlanError("invalid_plan_output")
    return { observationId, status: "completed", errorCode: null }
  }
  if (!keysOnly(content, ["kind", "localId", "commandKind", "dependsOn", "status", "errorCode", "output"]) || content.kind !== "plan_command" || content.localId !== command.localId || content.commandKind !== command.kind || stableJson(content.dependsOn) !== stableJson(command.dependsOn)) throw new CanonicalPlanError("invalid_plan_output")
  if (content.status !== "completed" && content.status !== "failed" && content.status !== "cancelled") throw new CanonicalPlanError("invalid_plan_output")
  if (content.errorCode !== null && typeof content.errorCode !== "string") throw new CanonicalPlanError("invalid_plan_output")
  if (content.status === "completed" && content.errorCode !== null) throw new CanonicalPlanError("invalid_plan_output")
  if (Object.prototype.hasOwnProperty.call(content, "output") && !plainJson(content.output)) throw new CanonicalPlanError("invalid_plan_output")
  return { observationId, status: content.status, ...(Object.prototype.hasOwnProperty.call(content, "output") ? { output: content.output } : {}), errorCode: content.errorCode }
}

function delegateOutputSchema(role: string, outputSchemaRef: string | null): DelegateOutputSchemaMarker | undefined {
  if (outputSchemaRef !== ROLE_RESULT_SCHEMA || (role !== "scout" && role !== "analyst")) return undefined
  return { schemaVersion: ROLE_RESULT_SCHEMA, role }
}

function expectedReplayGraphStatus(command: PlanDispatchCommand, receipt: ReplayCommandReceipt): TaskGraphState["statuses"][string] {
  if (command.kind === "request_input" || command.kind === "propose_completion") return "waiting"
  if (receipt.status === "failed") return "failed"
  if (receipt.status === "cancelled") return "cancelled"
  const outputStatus = row(receipt.output)?.status
  return ["waiting", "waiting_for_dependency", "waiting_for_approval", "waiting_for_user"].includes(String(outputStatus)) ? "waiting" : "completed"
}

function taskGraphAttempt(graph: TaskGraphState, localId: string): number {
  for (let index = graph.appliedEvents.length - 1; index >= 0; index -= 1) {
    const event = graph.appliedEvents[index]
    if (event?.nodeId === localId) return event.attempt ?? 1
  }
  return 1
}

function validateReplayTaskGraph(commands: readonly PlanDispatchCommand[], graph: TaskGraphState, receipts: ReadonlyMap<string, ReplayCommandReceipt>): void {
  for (const command of commands) {
    const status = graph.statuses[command.localId]
    const receipt = receipts.get(command.localId)
    if (!receipt) {
      if (status === "running" && taskGraphAttempt(graph, command.localId) === 1) continue
      if (status !== "pending" && status !== "ready") throw new CanonicalPlanError("invalid_plan_output")
      continue
    }
    if (status !== expectedReplayGraphStatus(command, receipt)) throw new CanonicalPlanError("invalid_plan_output")
  }
}

function isSafeReplayRecoveryCommand(options: CanonicalPlanExecutionOptions, command: PlanDispatchCommand): boolean {
  if (command.inputRefs.length > 0 || command.inputRefsDeferred) return false
  if (command.kind === "delegate") {
    return (command.call.toolName === "agent.spawn" || command.call.toolName === "spawn_subagent") && command.call.toolVersion === "1"
  }
  if (command.kind !== "tool_call" || !CANONICAL_RECOVERY_READ_TOOLS.has(command.call.toolName)) return false
  try {
    return options.registry.list(options.capabilities).some(item => {
      if (!isPlainJsonObject(item) || item.name !== command.call.toolName || item.version !== command.call.toolVersion) return false
      return item.risk === "read" && Array.isArray(item.capabilities) && item.capabilities.every(capability => capability === "read")
    })
  } catch {
    return false
  }
}

async function recoverReplayOrphans(
  options: CanonicalPlanExecutionOptions,
  commands: readonly PlanDispatchCommand[],
  graph: TaskGraphState,
  receipts: ReadonlyMap<string, ReplayCommandReceipt>,
  taskGraph: PlanTaskGraphAdapter,
): Promise<void> {
  const orphaned = commands.filter(command => !receipts.has(command.localId) && graph.statuses[command.localId] === "running")
  if (orphaned.length === 0) return
  if (!taskGraph.retry) throw new PlanTaskGraphAdapterError("persistence_failed", "Task graph retry is unavailable")
  for (const command of orphaned) {
    if (taskGraphAttempt(graph, command.localId) !== 1 || !isSafeReplayRecoveryCommand(options, command)) throw new CanonicalPlanError("invalid_plan_output")
  }
  for (const command of orphaned) await taskGraph.retry(command.localId)
}

const JOIN_ALLOWED_IDENTITY_KEYS = new Set(["taskId", "rootTaskId", "parentTaskId"])
const WAIT_ALLOWED_IDENTITY_KEYS = new Set(["taskId"])

function hasForeignIdentity(value: unknown, allowed = new Set<string>(), seen = new Set<object>()): boolean {
  if (!value || typeof value !== "object" || seen.has(value)) return false
  if (Array.isArray(value)) { seen.add(value); const found = value.some(item => hasForeignIdentity(item, allowed, seen)); seen.delete(value); return found }
  if (!isPlainJsonObject(value)) return false
  if (Object.keys(value).some(key => FORBIDDEN_INPUT_KEYS.has(key) && !allowed.has(key))) return true
  seen.add(value); const found = Object.values(value).some(item => hasForeignIdentity(item, allowed, seen)); seen.delete(value); return found
}

function boundedJson(value: unknown): boolean {
  try {
    const encoded = JSON.stringify(value)
    return encoded !== undefined && Buffer.byteLength(encoded, "utf8") <= MAX_RESULT_BYTES
  } catch {
    return false
  }
}

function boundedRole(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0 && value.length <= 256 }

function validStructuredReplayResult(task: Record<string, unknown>, expectedRole: string | undefined): boolean {
  const result = row(task.result)
  if (!result || !Object.prototype.hasOwnProperty.call(result, "structuredResult")) return true
  if (!expectedRole || !boundedRole(task.role)) return false
  if (task.status !== "completed") return false
  try {
    const structuredResult = validateRoleResult(result.structuredResult)
    const encoded = JSON.stringify(structuredResult)
    return task.role === expectedRole && structuredResult.role === expectedRole && validateBoundStructuredEvidence(structuredResult) && encoded !== undefined && Buffer.byteLength(encoded, "utf8") <= MAX_RESULT_BYTES
  } catch {
    return false
  }
}

function uniqueIds(value: unknown, allowEmpty = false): value is readonly string[] {
  return Array.isArray(value) && (allowEmpty || value.length > 0) && value.length <= 8 && value.every(item => typeof item === "string" && Boolean(item.trim()) && item.length <= 256) && new Set(value).size === value.length
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && [...left].sort().every((id, index) => id === [...right].sort()[index])
}

function validReplayWaitTasks(value: unknown, taskIds: readonly string[], expectedRoles: ReadonlyMap<string, string>): boolean {
  if (!Array.isArray(value) || value.length !== taskIds.length) return false
  const seen = new Set<string>()
  for (const candidate of value) {
    const task = row(candidate)
    if (!task || (Object.keys(task).length !== 4 && Object.keys(task).length !== 5) || !keysOnly(task, ["taskId", "status", "role", "result", "failureReason"]) || hasForeignIdentity(task, WAIT_ALLOWED_IDENTITY_KEYS)) return false
    if (typeof task.taskId !== "string" || !task.taskId.trim() || task.taskId.length > 256 || !taskIds.includes(task.taskId) || seen.has(task.taskId)) return false
    const hasRole = Object.prototype.hasOwnProperty.call(task, "role")
    if ((hasRole && !boundedRole(task.role)) || typeof task.status !== "string" || !task.status.trim() || task.status.length > 256 || !Object.prototype.hasOwnProperty.call(task, "result") || !plainJson(task.result) || !boundedJson(task.result) || hasForeignIdentity(task.result) || !validStructuredReplayResult(task, expectedRoles.get(task.taskId))) return false
    if (task.failureReason !== null && (typeof task.failureReason !== "string" || Buffer.byteLength(task.failureReason, "utf8") > MAX_RESULT_BYTES)) return false
    seen.add(task.taskId)
  }
  return seen.size === taskIds.length
}

function replayJoinTaskIds(options: CanonicalPlanExecutionOptions, command: PlanJoinCommand, receipts: ReadonlyMap<string, ReplayCommandReceipt>, commands: readonly PlanDispatchCommand[], expectedRoles = new Map<string, string>()): readonly string[] {
  const taskIds: string[] = []
  for (const ref of command.inputRefs) {
    const delegateMatches = commands.filter(candidate => candidate.kind === "delegate" && candidate.localId === ref)
    if (delegateMatches.length !== 1) throw new CanonicalPlanError("invalid_plan_output")
    const delegate = delegateMatches[0]!
    const expectedRole = delegate.kind === "delegate" && boundedRole(delegate.call.input.role) ? delegate.call.input.role : undefined
    if (!expectedRole) throw new CanonicalPlanError("invalid_plan_output")
    const receipt = receipts.get(ref)
    const output = receipt?.status === "completed" ? row(receipt.output) : null
    if (!output || !plainJson(output) || !boundedJson(output) || hasForeignIdentity(output, JOIN_ALLOWED_IDENTITY_KEYS) || typeof output.taskId !== "string" || !output.taskId.trim() || output.taskId.length > 256) throw new CanonicalPlanError("invalid_plan_output")
    if (options.rootTaskId && (typeof output.rootTaskId !== "string" || !output.rootTaskId.trim() || output.rootTaskId.length > 256 || output.rootTaskId !== options.rootTaskId || typeof output.parentTaskId !== "string" || !output.parentTaskId.trim() || output.parentTaskId.length > 256 || output.parentTaskId !== options.rootTaskId)) throw new CanonicalPlanError("invalid_plan_output")
    if (taskIds.includes(output.taskId)) throw new CanonicalPlanError("invalid_plan_output")
    if (expectedRoles.has(output.taskId)) throw new CanonicalPlanError("invalid_plan_output")
    expectedRoles.set(output.taskId, expectedRole)
    taskIds.push(output.taskId)
  }
  if (taskIds.length === 0 || taskIds.length > 8) throw new CanonicalPlanError("invalid_plan_output")
  return taskIds
}

function replayWaitOutcome(input: Parameters<TurnEnginePlanExecutionHook>[0], options: CanonicalPlanExecutionOptions, command: PlanJoinCommand, receipts: ReadonlyMap<string, ReplayCommandReceipt>, commands: readonly PlanDispatchCommand[], waitId: string): Record<string, unknown> | undefined {
  const matches = input.snapshot.toolObservations.filter(observation => observation.id === `wait-result:${waitId}`)
  if (matches.length > 1) throw new CanonicalPlanError("invalid_plan_output")
  const observation = matches[0]
  if (!observation) return undefined
  const content = row(observation.content)
  if (!waitId.trim() || waitId.length > 256 || !content || !keysOnly(content, ["toolCallId", "toolName", "input", "status", "output", "errorCode"]) || content.toolCallId !== `wait:${waitId}` || !isWaitToolName(content.toolName) || content.status !== "completed" || content.errorCode !== null) throw new CanonicalPlanError("invalid_plan_output")
  const waitInput = row(content.input)
  const output = row(content.output)
  if (!waitInput || !keysOnly(waitInput, ["taskIds", "mode"]) || hasForeignIdentity(waitInput) || !output || !plainJson(output) || !boundedJson(output) || hasForeignIdentity(output, WAIT_ALLOWED_IDENTITY_KEYS)) throw new CanonicalPlanError("invalid_plan_output")
  const expectedRoles = new Map<string, string>()
  const taskIds = replayJoinTaskIds(options, command, receipts, commands, expectedRoles)
  if (!uniqueIds(waitInput.taskIds) || !sameIds(waitInput.taskIds, taskIds) || waitInput.mode !== command.call.input.mode || !uniqueIds(output.targetTaskIds) || !sameIds(output.targetTaskIds, taskIds) || !uniqueIds(output.matchedTaskIds, output.status === "timed_out") || output.matchedTaskIds.some(id => !taskIds.includes(id)) || !validReplayWaitTasks(output.tasks, taskIds, expectedRoles) || (Object.prototype.hasOwnProperty.call(output, "aggregate") && !validReplayAggregate(output.aggregate, output.tasks, expectedRoles, taskIds))) throw new CanonicalPlanError("invalid_plan_output")
  if (output.waitId !== waitId || (output.status !== "ready" && output.status !== "timed_out")) throw new CanonicalPlanError("invalid_plan_output")
  return output
}

function validReplayAggregate(value: unknown, tasks: unknown, expectedRoles: ReadonlyMap<string, string>, taskIds: readonly string[]): boolean {
  const aggregate = row(value)
  if (!aggregate || !boundedJson(aggregate) || !keysOnly(aggregate, ["status", "successfulRoles", "failedRoles", "pendingRoles", "jobIds", "failures"].filter(key => key !== "pendingRoles" || Object.prototype.hasOwnProperty.call(aggregate, key)))) return false
  if (!["completed", "partial", "failed", "pending"].includes(String(aggregate.status))) return false
  const roles = (input: unknown): input is readonly string[] => Array.isArray(input) && input.length <= 2 && input.every(role => role === "scout" || role === "analyst") && new Set(input).size === input.length
  if (!roles(aggregate.successfulRoles) || !roles(aggregate.failedRoles) || (aggregate.pendingRoles !== undefined && !roles(aggregate.pendingRoles)) || !Array.isArray(aggregate.jobIds) || aggregate.jobIds.length > 64 || !aggregate.jobIds.every(id => typeof id === "string" && id.length > 0 && id.length <= 256) || !Array.isArray(aggregate.failures) || aggregate.failures.length > 2) return false
  const successfulRoles = aggregate.successfulRoles as readonly string[]
  const failedRoles = aggregate.failedRoles as readonly string[]
  const pendingAggregateRoles = (aggregate.pendingRoles ?? []) as readonly string[]
  if (!aggregate.failures.every(item => { const failure = row(item); return !!failure && keysOnly(failure, ["role", "taskId", "reason"]) && roles([failure.role]) && typeof failure.taskId === "string" && taskIds.includes(failure.taskId) && expectedRoles.get(failure.taskId) === failure.role && typeof failure.reason === "string" && Buffer.byteLength(failure.reason, "utf8") <= 500 })) return false
  const taskRows = Array.isArray(tasks) ? tasks.map(row).filter((task): task is Record<string, unknown> => !!task) : []
  const latestByRole = new Map<string, Record<string, unknown>>()
  for (const task of taskRows) if (task.role === "scout" || task.role === "analyst") latestByRole.set(task.role, task)
  const latestTasks = [...latestByRole.values()]
  const terminalRoles = new Set(latestTasks.filter(task => ["completed", "failed", "interrupted", "cancelled", "closed"].includes(String(task.status))).map(task => String(task.role)))
  const pendingRoles = new Set(latestTasks.filter(task => !["completed", "failed", "interrupted", "cancelled", "closed"].includes(String(task.status))).map(task => String(task.role)))
  const allRoles = new Set([...aggregate.successfulRoles, ...aggregate.failedRoles, ...(aggregate.pendingRoles ?? [])])
  if (![...allRoles].every(role => expectedRoles.size === 0 || [...expectedRoles.values()].includes(role)) || [...aggregate.successfulRoles, ...aggregate.failedRoles].every(role => terminalRoles.has(role)) === false || !(aggregate.pendingRoles ?? []).every(role => pendingRoles.has(role))) return false
  if (successfulRoles.some(role => failedRoles.includes(role)) || successfulRoles.some(role => pendingAggregateRoles.includes(role))) return false
  if (pendingAggregateRoles.length > 0 && aggregate.status !== "pending") return false
  if (aggregate.status === "pending" && pendingAggregateRoles.length === 0) return false
  if (aggregate.status === "partial" && (successfulRoles.length === 0 || failedRoles.length === 0 || pendingAggregateRoles.length > 0)) return false
  if (aggregate.status === "completed" && (successfulRoles.length === 0 || failedRoles.length > 0 || pendingAggregateRoles.length > 0)) return false
  if (aggregate.status === "failed" && (successfulRoles.length > 0 || failedRoles.length === 0 || pendingAggregateRoles.length > 0)) return false
  const expectedJobIds = new Set<string>()
  const structuredRoles = new Set<string>()
  for (const task of latestByRole.values()) {
    if (task.status !== "completed" || (task.role !== "scout" && task.role !== "analyst")) continue
    const result = row(task.result)
    if (!result || !Object.prototype.hasOwnProperty.call(result, "structuredResult")) continue
    try {
      const structured = validateRoleResult(result.structuredResult, task.role)
      structuredRoles.add(task.role)
      const values = structured.role === "scout" ? structured.candidates.map(item => item.jobId) : structured.findings.map(item => item.jobId)
      for (const id of values) expectedJobIds.add(id)
    } catch { return false }
  }
  return successfulRoles.every(role => structuredRoles.has(role)) && [...aggregate.jobIds as string[]].sort().join("\u0000") === [...expectedJobIds].sort().join("\u0000")
}

function canonicalTaskGraphAdapter(options: CanonicalPlanExecutionOptions, taskGraph: PlanTaskGraphAdapter, planCallId: string, planRevision: number, receipts?: ReadonlyMap<string, ReplayCommandReceipt>): PlanTaskGraphAdapter {
  return {
    get state() { return taskGraph.state },
    start: async (localId: string) => {
      if (receipts?.has(localId)) return taskGraph.state
      if (!taskGraph.start) throw new PlanTaskGraphAdapterError("persistence_failed", "Task graph start is unavailable")
      return taskGraph.start(localId)
    },
    retry: async (localId: string) => {
      if (receipts?.has(localId)) return taskGraph.state
      if (!taskGraph.retry) throw new PlanTaskGraphAdapterError("persistence_failed", "Task graph retry is unavailable")
      return taskGraph.retry(localId)
    },
    observe: async (record: PlanCommandExecutionRecord | PlanControlRecord) => {
      if (receipts?.has(record.localId)) return taskGraph.state
      if (options.persistAtomicTerminal && record.kind !== "replan_required") {
        return taskGraph.observe(record, graph => options.persistAtomicTerminal!({ ...graph, receipt: outcomeReceipt(planCallId, planRevision, record) }))
      }
      return taskGraph.observe(record)
    },
  }
}

async function replayRuntime(
  options: CanonicalPlanExecutionOptions,
  input: Parameters<TurnEnginePlanExecutionHook>[0],
  dispatched: ReturnType<typeof dispatchPlanProposal>,
  planRevision: number,
  taskGraph?: PlanTaskGraphAdapter,
): Promise<{ runtime: PlanCommandExecutionRuntime; observations: Array<{ readonly id: string; readonly content: Record<string, unknown> }> }> {
  const receipts = new Map<string, ReplayCommandReceipt>()
  for (const command of dispatched.commands) {
    const receipt = replayReceipt(input.snapshot, input.call.id, command)
    if (receipt) receipts.set(command.localId, receipt)
  }
  if (taskGraph) validateReplayTaskGraph(dispatched.commands, taskGraph.state, receipts)
  if (taskGraph && !options.persistTaskGraph && !options.persistAtomicTerminal && dispatched.commands.some(command => !receipts.has(command.localId))) throw new CanonicalPlanError("invalid_plan_output")
  const replayTaskGraph = taskGraph ? canonicalTaskGraphAdapter(options, taskGraph, input.call.id, planRevision, receipts) : undefined
  if (taskGraph && replayTaskGraph) await recoverReplayOrphans(options, dispatched.commands, taskGraph.state, receipts, replayTaskGraph)
  for (const command of dispatched.commands) {
    const receipt = receipts.get(command.localId)
    if (command.kind === "join" && receipt?.status === "completed" && row(receipt.output)?.status === "waiting") replayJoinTaskIds(options, command, receipts, dispatched.commands)
  }
  const currentReplanPrefix = `plan-control:${input.call.id}:`
  const currentReplanObservations = input.snapshot.toolObservations.filter(observation => {
    const content = row(observation.content)
    return observation.id.startsWith(currentReplanPrefix) && content?.kind === "plan_control" && content.status === "replan_required"
  })
  const expectedReplanIds = new Set<string>()
  for (const command of dispatched.commands) {
    const receipt = receipts.get(command.localId)
    if (command.kind !== "join" || receipt?.status !== "completed") continue
    const output = row(receipt.output)
    const waiting = output?.status === "waiting"
    if (!waiting && output?.status !== "ready" && output?.status !== "timed_out") continue
    const waitId = output?.waitId
    const replanId = id("plan-control", input.call.id, `${command.localId}:replan`)
    const existing = currentReplanObservations.filter(observation => observation.id === replanId)
    if (existing.length > 1) throw new CanonicalPlanError("invalid_plan_output")
    if (waiting && (typeof waitId !== "string" || !waitId.trim())) {
      if (existing.length > 0) throw new CanonicalPlanError("invalid_plan_output")
      continue
    }
    const resumed = waiting
      ? replayWaitOutcome(input, options, command, receipts, dispatched.commands, waitId as string)
      : output
    if (!resumed) {
      if (existing.length > 0) throw new CanonicalPlanError("invalid_plan_output")
      continue
    }
    const expectedRoles = new Map<string, string>()
    const taskIds = replayJoinTaskIds(options, command, receipts, dispatched.commands, expectedRoles)
    const inspection = inspectJoinFailureEvidence(resumed, taskIds)
    if (!inspection.valid) throw new CanonicalPlanError("invalid_plan_output")
    const control = replanRequiredControl(command.localId, command.dependsOn, inspection.failedTaskIds)
    if (!control) {
      if (existing.length > 0) throw new CanonicalPlanError("invalid_plan_output")
      continue
    }
    const expected = controlObservation(input.call.id, control)
    expectedReplanIds.add(expected.id)
    if (existing.length > 0 && stableJson(existing[0]!.content) !== stableJson(expected.content)) throw new CanonicalPlanError("invalid_plan_output")
  }
  if (currentReplanObservations.some(observation => !expectedReplanIds.has(observation.id))) throw new CanonicalPlanError("invalid_plan_output")
  const observations: Array<{ readonly id: string; readonly content: Record<string, unknown> }> = []
  const observe = async (recordValue: PlanCommandExecutionRecord | PlanControlRecord): Promise<void> => {
    const observation = "result" in recordValue ? recordObservation(input.call.id, recordValue) : controlObservation(input.call.id, recordValue)
    if (receipts.has(recordValue.localId)) return
    const existing = input.snapshot.toolObservations.find(candidate => candidate.id === observation.id)
    if (existing) {
      if (stableJson(existing.content) !== stableJson(observation.content)) throw new CanonicalPlanError("invalid_plan_output")
      return
    }
    observations.push(observation)
    if (options.persistOutcome && (!taskGraph || !options.persistAtomicTerminal || recordValue.kind === "replan_required")) await options.persistOutcome(outcomeReceipt(input.call.id, planRevision, recordValue))
  }
  return {
    runtime: {
      router: {
        execute: async (context, request) => {
          const command = dispatched.commands.find(item => "call" in item && item.call.id === request.id)
          const receipt = command ? receipts.get(command.localId) : undefined
          if (!receipt) return options.router.execute(context, request)
          if (command?.kind === "join" && receipt.status === "completed" && row(receipt.output)?.status === "waiting" && typeof row(receipt.output)?.waitId === "string") {
            const resumed = replayWaitOutcome(input, options, command, receipts, dispatched.commands, String(row(receipt.output)?.waitId))
            if (resumed) return { ...request, status: "completed" as const, output: resumed, errorCode: null }
          }
          return { ...request, status: receipt.status, ...(Object.prototype.hasOwnProperty.call(receipt, "output") ? { output: receipt.output } : {}), errorCode: receipt.errorCode }
        },
      },
      admit: planAdmission(input),
      shouldAdmit: command => !receipts.has(command.localId),
      createContext: request => ({ scope: options.scope, sessionId: options.lease.sessionId, turnId: options.lease.turnId, stepId: `${input.stepId}:plan:${request.localId}`, taskId: options.taskId, rootTaskId: options.rootTaskId, actorRole: options.actorRole, capabilities: [...options.capabilities], signal: input.signal, ...(request.delegateOutputSchemaMarker === undefined ? {} : { delegateOutputSchemaMarker: request.delegateOutputSchemaMarker }) }),
      parallelDelegateLimit: CANONICAL_PARALLEL_DELEGATE_LIMIT,
      rootTaskId: options.rootTaskId,
      resolveInputRefs: request => receipts.has(request.localId) ? {} : resolveInputRefs(input.snapshot, request),
      ...(replayTaskGraph ? { taskGraphAdapter: replayTaskGraph } : {}),
      observe,
    },
    observations,
  }
}

export function createCanonicalPlanExecutionFactory(options: CanonicalPlanExecutionOptions): (input: Parameters<TurnEnginePlanExecutionHook>[0]) => Promise<TurnEnginePlanExecutionHookResult> {
  if (!Number.isSafeInteger(options.goal.revision) || options.goal.revision < 1 || !Number.isSafeInteger(options.maxNodes) || options.maxNodes < 1 || options.maxNodes > PLAN_MAX_NODES) throw new TypeError("Invalid server plan execution bounds")
  const maxPlanRevisions = options.maxPlanRevisions ?? PLAN_MAX_REVISIONS
  if (!Number.isSafeInteger(maxPlanRevisions) || maxPlanRevisions < 1 || maxPlanRevisions > PLAN_MAX_REVISIONS) throw new TypeError("Invalid max plan revisions")
  if (options.initialPlanRevision !== undefined && options.initialPlanRevision !== null && (!Number.isSafeInteger(options.initialPlanRevision) || options.initialPlanRevision < 1 || options.initialPlanRevision > maxPlanRevisions)) throw new TypeError("Invalid initial plan revision")
  const capabilityCatalog = derivePlannerCapabilityCatalog(options.registry, options.capabilities, options.allowedTools, options.allowedTemplates)
  const allowedTools = capabilityCatalog.tools
  const allowedTemplates = capabilityCatalog.templates
  const allowedRoles = Object.freeze([...options.allowedRoles])
  const allowedPlanActions = copyAllowedPlanActions(options.allowedPlanActions)
  const seenPlanHashes = new Set(copyPlanFingerprints(options.initialPlanHashes))
  let currentPlanRevision: number | null = options.initialPlanRevision ?? null
  let goalRevision = options.goal.revision
  options.recoveryDispatcher?.register(receipt => {
    const goal = options.goalRef?.get() ?? options.goal
    recoverPlanRevision(receipt.basedOnPlanRevision, receipt, maxPlanRevisions)
    const previousPlanRevision = currentPlanRevision
    const previousGoalRevision = goalRevision
    const previousPlanHashes = [...seenPlanHashes]
    const goalChanged = goal.revision !== goalRevision
    const recoveryPlanRevision = goalChanged ? null : currentPlanRevision
    const recoveryPlanHashes = goalChanged ? new Set<string>() : seenPlanHashes
    if (receipt.goalRevision !== goal.revision) {
      if (!goalChanged) return
      return {
        commit: () => {
          goalRevision = goal.revision
          currentPlanRevision = null
          seenPlanHashes.clear()
        },
        rollback: () => {
          goalRevision = previousGoalRevision
          currentPlanRevision = previousPlanRevision
          seenPlanHashes.clear()
          for (const hash of previousPlanHashes) seenPlanHashes.add(hash)
        },
      }
    }
    const nextRevision = recoverPlanRevision(recoveryPlanRevision, receipt, maxPlanRevisions)
    if (receipt.planRevision === recoveryPlanRevision) {
      if (receipt.proposalHash && !recoveryPlanHashes.has(receipt.proposalHash)) throw new PlanRevisionRecoveryError()
    } else if (receipt.proposalHash && recoveryPlanHashes.has(receipt.proposalHash)) throw new PlanRevisionRecoveryError()
    const nextPlanHashes = new Set(recoveryPlanHashes)
    if (receipt.proposalHash) nextPlanHashes.add(receipt.proposalHash)
    return {
      commit: () => {
        goalRevision = goal.revision
        currentPlanRevision = nextRevision
        seenPlanHashes.clear()
        for (const hash of nextPlanHashes) seenPlanHashes.add(hash)
      },
      rollback: () => {
        goalRevision = previousGoalRevision
        currentPlanRevision = previousPlanRevision
        seenPlanHashes.clear()
        for (const hash of previousPlanHashes) seenPlanHashes.add(hash)
      },
    }
  })
  return async input => {
    const baseError = (code: string): TurnEnginePlanExecutionHookResult => ({ observations: [failureObservation(input.call.id, code)] })
    try {
      if (input.sessionId !== options.lease.sessionId || input.turnId !== options.lease.turnId || input.identity.sessionId !== options.lease.sessionId || input.identity.turnId !== options.lease.turnId) throw new CanonicalPlanError("invalid_plan_output")
      const goal = options.goalRef?.get() ?? options.goal
      if (goal.revision !== goalRevision) {
        currentPlanRevision = null
        seenPlanHashes.clear()
        goalRevision = goal.revision
      }
      if (input.result.status !== "completed" || input.result.toolName !== "agent.plan.propose") throw new CanonicalPlanError("invalid_plan_output")
      const replayed = input.replayed === true
      const output = accepted(input.result.output, goal.revision, currentPlanRevision, maxPlanRevisions, replayed)
      const validation = {
        goalRevision: goal.revision, planRevision: output.basedOnPlanRevision, maxNodes: options.maxNodes,
        allowedActions: allowedPlanActions, allowedTools, allowedTemplates, allowedRoles,
      } as const
      let normalized: ReturnType<typeof validatePlanProposal>
      try { normalized = validatePlanProposal(output.proposal, { goalRevision: goal.revision }) } catch (error: unknown) { if (error instanceof PlanValidationError) throw new CanonicalPlanError("invalid_plan_output"); throw error }
      const computedHash = fingerprintPlanProposal(normalized)
      if (computedHash !== output.proposalHash) throw new CanonicalPlanError("invalid_plan_output")
      if (!replayed && seenPlanHashes.has(computedHash)) throw new CanonicalPlanError("plan_no_progress")
      const dispatched = dispatchPlanProposal(normalized, validation, {
        resolveToolVersion: name => version(options.registry, options.capabilities, name),
        createToolCallId: localId => id("plan-call", input.call.id, localId),
        createIdempotencyKey: localId => id("plan-idempotency", input.call.id, localId),
        deferInputRefs: true,
        resolveWaitVersion: () => waitVersion(options.registry, options.capabilities),
        resolveDelegateActions: role => actions(options.registry, options.capabilities, allowedTools, role),
        resolveDelegateOutputSchema: delegateOutputSchema,
      })
      if (!replayed) {
        seenPlanHashes.add(computedHash)
        currentPlanRevision = output.planRevision
      }
      const candidateTaskGraphRunKey = `${options.rootTaskId}:${input.call.id}:${output.planRevision}`
      const matchingTaskGraphEvents = replayed
        ? (options.initialTaskGraphEvents?.filter(event => event.runKey === candidateTaskGraphRunKey) ?? [])
        : []
      const taskGraph = replayed && matchingTaskGraphEvents.length > 0
        ? (() => {
            const runKey = taskGraphRunKey(options.rootTaskId, input.call.id, output.planRevision)
            const state = hydratePlanTaskGraph(dispatched, { runKey, events: matchingTaskGraphEvents })
            return createPlanTaskGraphAdapter(dispatched, { runKey, initialState: state, persist: options.persistTaskGraph ?? (() => { throw new PlanTaskGraphAdapterError("persistence_failed", "Task graph persistence is unavailable") }) })
          })()
        : !replayed && options.persistTaskGraph
          ? createPlanTaskGraphAdapter(dispatched, { runKey: taskGraphRunKey(options.rootTaskId, input.call.id, output.planRevision), persist: options.persistTaskGraph } satisfies PlanTaskGraphAdapterOptions)
          : undefined
      const replay = replayed ? await replayRuntime(options, input, dispatched, output.planRevision, taskGraph) : undefined
      const commandTaskGraph = !replay && taskGraph && options.persistAtomicTerminal
        ? canonicalTaskGraphAdapter(options, taskGraph, input.call.id, output.planRevision)
        : taskGraph
      const commandRuntime: PlanCommandExecutionRuntime = replay?.runtime ?? {
        router: options.router,
        createContext: request => ({ scope: options.scope, sessionId: options.lease.sessionId, turnId: options.lease.turnId, stepId: `${input.stepId}:plan:${request.localId}`, taskId: options.taskId, rootTaskId: options.rootTaskId, actorRole: options.actorRole, capabilities: [...options.capabilities], signal: input.signal, ...(request.delegateOutputSchemaMarker === undefined ? {} : { delegateOutputSchemaMarker: request.delegateOutputSchemaMarker }) }),
        parallelDelegateLimit: CANONICAL_PARALLEL_DELEGATE_LIMIT,
        rootTaskId: options.rootTaskId,
        resolveInputRefs: request => resolveInputRefs(input.snapshot, request),
        admit: planAdmission(input),
        ...(commandTaskGraph ? { taskGraphAdapter: commandTaskGraph } : {}),
        ...(options.persistOutcome ? {
          observe: async (recordValue: PlanCommandExecutionRecord | PlanControlRecord) => {
            if (commandTaskGraph && options.persistAtomicTerminal && recordValue.kind !== "replan_required") return
            await options.persistOutcome!(outcomeReceipt(input.call.id, output.planRevision, recordValue))
          },
        } : {}),
      }
      const executed = await executePlanCommands(dispatched, commandRuntime)
      const records = boundedRecords(executed)
      const observations = replay?.observations ?? records.map(recordValue => recordObservation(input.call.id, recordValue))
      if (executed.blocked) {
        if (!replay) observations.push(controlObservation(input.call.id, executed.blocked))
        // request_input is a user question; approval waits come from ToolRouter policy decisions.
        return executed.blocked.kind === "request_input"
          ? (() => {
              const questionId = canonicalQuestionId(options.lease.turnId, input.call.id, output.planRevision, executed.blocked.localId)
              if (questionId.length > 256) throw new CanonicalPlanError("invalid_plan_output")
              return {
                observations: observations.slice(0, MAX_OBSERVATIONS),
                wait: {
                  status: "waiting_for_user" as const,
                  waitId: questionId,
                  errorCode: "plan_request_input",
                  question: {
                    turnId: options.lease.turnId,
                    questionId,
                    toolCallId: input.call.id,
                    question: executed.blocked.question,
                    options: [],
                    planCallId: input.call.id,
                    localId: executed.blocked.localId,
                    goalRevision: goal.revision,
                    planRevision: output.planRevision,
                  },
                },
              }
            })()
          : { observations: observations.slice(0, MAX_OBSERVATIONS) }
      }
      const wait = records.map(waitFrom).find(value => value !== undefined)
      return { observations: observations.slice(0, MAX_OBSERVATIONS), ...(wait ? { wait } : {}) }
    } catch (error: unknown) {
      const code = error instanceof PlanDispatchError || error instanceof PlanCommandExecutionError || error instanceof CanonicalPlanError ? error.code : error instanceof PlanTaskGraphAdapterError ? "invalid_plan_output" : "plan_execution_failed"
      return baseError(code)
    }
  }
}
