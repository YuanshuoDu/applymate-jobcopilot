import { Buffer } from "node:buffer"

import type { PolicyEngine } from "@jobcopilot/agent-policy"
import type { PolicyRole, TenantScope } from "@jobcopilot/agent-protocol"

import { copyAllowedPlanActions, PLAN_MAX_NODES, PLAN_MAX_REVISIONS, isPlainJsonObject, type GoalContract, type GoalContractRef, type PlanActionKind } from "./goal-plan-contract.js"
import { PlanDispatchError, dispatchPlanProposal, type PlanDispatchCommand } from "./plan-intent-dispatcher.js"
import { copyPlanFingerprints, fingerprintPlanProposal, isPlanFingerprint } from "./plan-fingerprint.js"
import { PlanValidationError, validatePlanProposal } from "./goal-plan-validator.js"
import { PlanCommandExecutionError, executePlanCommands, type PlanCommandExecutionRecord, type PlanCommandExecutionRuntime, type PlanControlRecord, type PlanInputReferenceResolutionRequest, type PlanJoinCommand } from "./plan-command-executor.js"
import { createPlanCommandReceipt, type PlanCommandReceipt } from "./plan-command-receipt.js"
import { PlanRevisionRecoveryError, recoverPlanRevision, type PlanRevisionRecoveryDispatcher } from "./plan-revision-receipt.js"
import type { ToolCallRequest, ToolExecutionResult, ToolRouterContext } from "../tools/types.js"
import type { TurnEnginePlanExecutionHook, TurnEnginePlanExecutionHookResult } from "../turns/turn-engine-types.js"
import type { StepContextSnapshot } from "../context/step-context-builder.js"

const MAX_OBSERVATIONS = 8
const MAX_RESULT_BYTES = 8 * 1024
const OUTPUT_KEYS = ["status", "goalRevision", "planRevision", "basedOnPlanRevision", "proposal", "intents", "proposalHash"]

type Registry = { list(capabilities?: readonly string[]): readonly unknown[] }
type Router = { execute(context: ToolRouterContext, request: ToolCallRequest): Promise<ToolExecutionResult> }

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

function version(registry: Registry, capabilities: readonly string[], name: string): string | undefined {
  const definition = registry.list(capabilities).find(item => isPlainJsonObject(item) && item.name === name && typeof item.version === "string")
  return definition && isPlainJsonObject(definition) && typeof definition.version === "string" ? definition.version.trim() : undefined
}

function actions(registry: Registry, capabilities: readonly string[], allowedTools: readonly string[]): readonly string[] {
  return [...new Set(registry.list(capabilities).flatMap(item => {
    if (!isPlainJsonObject(item) || typeof item.name !== "string" || !allowedTools.includes(item.name)) return []
    if (item.risk !== "read" || !Array.isArray(item.capabilities) || !item.capabilities.includes("read")) return []
    return [item.name]
  }))]
}

function row(value: unknown): Record<string, unknown> | null { return isPlainJsonObject(value) ? value : null }

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
  if (isPlainJsonObject(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`
  return JSON.stringify(value) ?? "undefined"
}

const FORBIDDEN_INPUT_KEYS = new Set(["userId", "sessionId", "turnId", "stepId", "taskId", "parentTaskId", "rootTaskId", "ownerId", "lease", "leaseOwnerId", "leaseVersion", "idempotencyKey", "capabilities", "permissions", "allowedCapabilities", "budgetLimit", "maxBudget"])

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
    if (encoded === undefined || Buffer.byteLength(encoded, "utf8") > MAX_RESULT_BYTES || Object.keys(source).some(key => FORBIDDEN_INPUT_KEYS.has(key))) throw new CanonicalPlanError("input_reference_unavailable")
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
    : { kind: "plan_control", localId: control.localId, status: "completion_proposed", completionCriteria: [...control.completionCriteria] }
  return safeObservation(id("plan-control", callId, control.localId), content)
}

function outcomeReceipt(callId: string, planRevision: number, recordValue: PlanCommandExecutionRecord | PlanControlRecord): PlanCommandReceipt {
  const observation = "result" in recordValue ? recordObservation(callId, recordValue) : controlObservation(callId, recordValue)
  return createPlanCommandReceipt({ planCallId: callId, planRevision, observationId: observation.id, content: observation.content })
}

function failureObservation(callId: string, code: string): { id: string; content: Record<string, unknown> } {
  return safeObservation(`plan-error:${callId}`, { kind: "plan_error", status: "failed", errorCode: code.slice(0, 64) })
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
    if (!keysOnly(content, command.kind === "request_input" ? ["kind", "localId", "status", "question", "approvalBoundary"] : ["kind", "localId", "status", "completionCriteria"]) || content.kind !== "plan_control" || content.localId !== command.localId) throw new CanonicalPlanError("invalid_plan_output")
    if (command.kind === "request_input") {
      if (content.status !== "waiting_for_user" || content.question !== command.question ||
        (command.approvalBoundary === undefined ? content.approvalBoundary !== undefined : content.approvalBoundary !== command.approvalBoundary)) throw new CanonicalPlanError("invalid_plan_output")
    } else if (content.status !== "completion_proposed" || stableJson(content.completionCriteria) !== stableJson(command.completionCriteria)) throw new CanonicalPlanError("invalid_plan_output")
    return { observationId, status: "completed", errorCode: null }
  }
  if (!keysOnly(content, ["kind", "localId", "commandKind", "dependsOn", "status", "errorCode", "output"]) || content.kind !== "plan_command" || content.localId !== command.localId || content.commandKind !== command.kind || stableJson(content.dependsOn) !== stableJson(command.dependsOn)) throw new CanonicalPlanError("invalid_plan_output")
  if (content.status !== "completed" && content.status !== "failed" && content.status !== "cancelled") throw new CanonicalPlanError("invalid_plan_output")
  if (content.errorCode !== null && typeof content.errorCode !== "string") throw new CanonicalPlanError("invalid_plan_output")
  if (content.status === "completed" && content.errorCode !== null) throw new CanonicalPlanError("invalid_plan_output")
  if (Object.prototype.hasOwnProperty.call(content, "output") && !plainJson(content.output)) throw new CanonicalPlanError("invalid_plan_output")
  return { observationId, status: content.status, ...(Object.prototype.hasOwnProperty.call(content, "output") ? { output: content.output } : {}), errorCode: content.errorCode }
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

function uniqueIds(value: unknown, allowEmpty = false): value is readonly string[] {
  return Array.isArray(value) && (allowEmpty || value.length > 0) && value.length <= 8 && value.every(item => typeof item === "string" && Boolean(item.trim()) && item.length <= 256) && new Set(value).size === value.length
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && [...left].sort().every((id, index) => id === [...right].sort()[index])
}

function replayJoinTaskIds(options: CanonicalPlanExecutionOptions, command: PlanJoinCommand, receipts: ReadonlyMap<string, ReplayCommandReceipt>): readonly string[] {
  const taskIds: string[] = []
  for (const ref of command.inputRefs) {
    const receipt = receipts.get(ref)
    const output = receipt?.status === "completed" ? row(receipt.output) : null
    if (!output || !plainJson(output) || !boundedJson(output) || hasForeignIdentity(output, JOIN_ALLOWED_IDENTITY_KEYS) || typeof output.taskId !== "string" || !output.taskId.trim()) throw new CanonicalPlanError("invalid_plan_output")
    if (options.rootTaskId && (typeof output.rootTaskId !== "string" || !output.rootTaskId.trim() || output.rootTaskId.length > 256 || output.rootTaskId !== options.rootTaskId || typeof output.parentTaskId !== "string" || !output.parentTaskId.trim() || output.parentTaskId.length > 256 || output.parentTaskId !== options.rootTaskId)) throw new CanonicalPlanError("invalid_plan_output")
    if (taskIds.includes(output.taskId)) throw new CanonicalPlanError("invalid_plan_output")
    taskIds.push(output.taskId)
  }
  if (taskIds.length === 0 || taskIds.length > 8) throw new CanonicalPlanError("invalid_plan_output")
  return taskIds
}

function replayWaitOutcome(input: Parameters<TurnEnginePlanExecutionHook>[0], options: CanonicalPlanExecutionOptions, command: PlanJoinCommand, receipts: ReadonlyMap<string, ReplayCommandReceipt>, waitId: string): Record<string, unknown> | undefined {
  const matches = input.snapshot.toolObservations.filter(observation => observation.id === `wait-result:${waitId}`)
  if (matches.length > 1) throw new CanonicalPlanError("invalid_plan_output")
  const observation = matches[0]
  if (!observation) return undefined
  const content = row(observation.content)
  if (!waitId.trim() || waitId.length > 256 || !content || !keysOnly(content, ["toolCallId", "toolName", "input", "status", "output", "errorCode"]) || content.toolCallId !== `wait:${waitId}` || content.toolName !== "wait_subagents" || content.status !== "completed" || content.errorCode !== null) throw new CanonicalPlanError("invalid_plan_output")
  const waitInput = row(content.input)
  const output = row(content.output)
  if (!waitInput || !keysOnly(waitInput, ["taskIds", "mode"]) || hasForeignIdentity(waitInput) || !output || !plainJson(output) || !boundedJson(output) || hasForeignIdentity(output, WAIT_ALLOWED_IDENTITY_KEYS)) throw new CanonicalPlanError("invalid_plan_output")
  const taskIds = replayJoinTaskIds(options, command, receipts)
  if (!uniqueIds(waitInput.taskIds) || !sameIds(waitInput.taskIds, taskIds) || waitInput.mode !== command.call.input.mode || !uniqueIds(output.targetTaskIds) || !sameIds(output.targetTaskIds, taskIds) || !uniqueIds(output.matchedTaskIds, output.status === "timed_out") || output.matchedTaskIds.some(id => !taskIds.includes(id))) throw new CanonicalPlanError("invalid_plan_output")
  if (output.waitId !== waitId || (output.status !== "ready" && output.status !== "timed_out")) throw new CanonicalPlanError("invalid_plan_output")
  return output
}

function replayRuntime(
  options: CanonicalPlanExecutionOptions,
  input: Parameters<TurnEnginePlanExecutionHook>[0],
  dispatched: ReturnType<typeof dispatchPlanProposal>,
  planRevision: number,
): { runtime: PlanCommandExecutionRuntime; observations: Array<{ readonly id: string; readonly content: Record<string, unknown> }> } {
  const receipts = new Map<string, ReplayCommandReceipt>()
  for (const command of dispatched.commands) {
    const receipt = replayReceipt(input.snapshot, input.call.id, command)
    if (receipt) receipts.set(command.localId, receipt)
  }
  for (const command of dispatched.commands) {
    const receipt = receipts.get(command.localId)
    if (command.kind === "join" && receipt?.status === "completed" && row(receipt.output)?.status === "waiting") replayJoinTaskIds(options, command, receipts)
  }
  const observations: Array<{ readonly id: string; readonly content: Record<string, unknown> }> = []
  const observe = async (recordValue: PlanCommandExecutionRecord | PlanControlRecord): Promise<void> => {
    const observation = "result" in recordValue ? recordObservation(input.call.id, recordValue) : controlObservation(input.call.id, recordValue)
    if (receipts.has(recordValue.localId)) return
    observations.push(observation)
    if (options.persistOutcome) await options.persistOutcome(outcomeReceipt(input.call.id, planRevision, recordValue))
  }
  return {
    runtime: {
      router: {
        execute: async (context, request) => {
          const command = dispatched.commands.find(item => "call" in item && item.call.id === request.id)
          const receipt = command ? receipts.get(command.localId) : undefined
          if (!receipt) return options.router.execute(context, request)
          if (command?.kind === "join" && receipt.status === "completed" && row(receipt.output)?.status === "waiting" && typeof row(receipt.output)?.waitId === "string") {
            const resumed = replayWaitOutcome(input, options, command, receipts, String(row(receipt.output)?.waitId))
            if (resumed) return { ...request, status: "completed" as const, output: resumed, errorCode: null }
          }
          return { ...request, status: receipt.status, ...(Object.prototype.hasOwnProperty.call(receipt, "output") ? { output: receipt.output } : {}), errorCode: receipt.errorCode }
        },
      },
      createContext: request => ({ scope: options.scope, sessionId: options.lease.sessionId, turnId: options.lease.turnId, stepId: `${input.stepId}:plan:${request.localId}`, taskId: options.taskId, rootTaskId: options.rootTaskId, actorRole: options.actorRole, capabilities: [...options.capabilities], signal: input.signal }),
      rootTaskId: options.rootTaskId,
      resolveInputRefs: request => receipts.has(request.localId) ? {} : resolveInputRefs(input.snapshot, request),
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
  const allowedTools = Object.freeze([...options.allowedTools])
  const allowedTemplates = Object.freeze([...options.allowedTemplates])
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
        resolveWaitVersion: () => version(options.registry, options.capabilities, "wait_subagents"),
        resolveDelegateActions: () => actions(options.registry, options.capabilities, allowedTools),
      })
      if (!replayed) {
        seenPlanHashes.add(computedHash)
        currentPlanRevision = output.planRevision
      }
      const replay = replayed ? replayRuntime(options, input, dispatched, output.planRevision) : undefined
      const commandRuntime: PlanCommandExecutionRuntime = replay?.runtime ?? {
        router: options.router,
        createContext: request => ({ scope: options.scope, sessionId: options.lease.sessionId, turnId: options.lease.turnId, stepId: `${input.stepId}:plan:${request.localId}`, taskId: options.taskId, rootTaskId: options.rootTaskId, actorRole: options.actorRole, capabilities: [...options.capabilities], signal: input.signal }),
        rootTaskId: options.rootTaskId,
        resolveInputRefs: request => resolveInputRefs(input.snapshot, request),
        ...(options.persistOutcome ? { observe: async recordValue => options.persistOutcome!(outcomeReceipt(input.call.id, output.planRevision, recordValue)) } : {}),
      }
      const executed = await executePlanCommands(dispatched, commandRuntime)
      const records = boundedRecords(executed)
      const observations = replay?.observations ?? records.map(recordValue => recordObservation(input.call.id, recordValue))
      if (executed.blocked) {
        if (!replay) observations.push(controlObservation(input.call.id, executed.blocked))
        // request_input is a user question; approval waits come from ToolRouter policy decisions.
        return executed.blocked.kind === "request_input"
          ? { observations: observations.slice(0, MAX_OBSERVATIONS), wait: { status: "waiting_for_user", errorCode: "plan_request_input" } }
          : { observations: observations.slice(0, MAX_OBSERVATIONS) }
      }
      const wait = records.map(waitFrom).find(value => value !== undefined)
      return { observations: observations.slice(0, MAX_OBSERVATIONS), ...(wait ? { wait } : {}) }
    } catch (error: unknown) {
      const code = error instanceof PlanDispatchError || error instanceof PlanCommandExecutionError || error instanceof CanonicalPlanError ? error.code : "plan_execution_failed"
      return baseError(code)
    }
  }
}
