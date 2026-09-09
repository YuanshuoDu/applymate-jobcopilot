import { Buffer } from "node:buffer"

import type { PolicyEngine } from "@jobcopilot/agent-policy"
import type { PolicyRole, TenantScope } from "@jobcopilot/agent-protocol"

import { PLAN_MAX_NODES, isPlainJsonObject, type GoalContract } from "./goal-plan-contract.js"
import { PlanDispatchError, dispatchPlanProposal } from "./plan-intent-dispatcher.js"
import { PlanCommandExecutionError, executePlanCommands, type PlanCommandExecutionRecord, type PlanCommandExecutionRuntime, type PlanControlRecord } from "./plan-command-executor.js"
import type { ToolCallRequest, ToolExecutionResult, ToolRouterContext } from "../tools/types.js"
import type { TurnEnginePlanExecutionHook, TurnEnginePlanExecutionHookResult } from "../turns/turn-engine-types.js"

const MAX_OBSERVATIONS = 8
const MAX_RESULT_BYTES = 8 * 1024
const PLAN_ACTIONS = ["use_tool", "delegate", "request_input", "propose_completion"] as const
const OUTPUT_KEYS = ["status", "goalRevision", "planRevision", "basedOnPlanRevision", "proposal", "intents"]

type Registry = { list(capabilities?: readonly string[]): readonly unknown[] }
type Router = { execute(context: ToolRouterContext, request: ToolCallRequest): Promise<ToolExecutionResult> }

export type CanonicalPlanExecutionOptions = {
  readonly goal: GoalContract
  readonly allowedTools: readonly string[]
  readonly allowedTemplates: readonly string[]
  readonly allowedRoles: readonly string[]
  readonly maxNodes: number
  readonly capabilities: readonly string[]
  readonly actorRole: PolicyRole
  readonly scope: TenantScope
  readonly lease: { readonly sessionId: string; readonly turnId: string }
  readonly rootTaskId: string
  readonly taskId: string
  readonly router: Router
  readonly registry: Registry
  readonly policy: PolicyEngine
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

function accepted(value: unknown, goalRevision: number, expectedPlanRevision: number | null): { planRevision: number; basedOnPlanRevision: number | null; proposal: unknown } {
  if (!isPlainJsonObject(value) || !plainJson(value) || Object.keys(value).some(key => !OUTPUT_KEYS.includes(key))) throw new CanonicalPlanError("invalid_plan_output")
  if (value.status !== "accepted" || value.goalRevision !== goalRevision) throw new CanonicalPlanError("revision_conflict")
  const planRevision = value.planRevision
  const basedOnPlanRevision = value.basedOnPlanRevision
  if (typeof planRevision !== "number" || !Number.isSafeInteger(planRevision) || planRevision < 1 ||
    (basedOnPlanRevision !== null && (typeof basedOnPlanRevision !== "number" || !Number.isSafeInteger(basedOnPlanRevision) || basedOnPlanRevision < 0))) throw new CanonicalPlanError("invalid_plan_output")
  if (basedOnPlanRevision !== expectedPlanRevision || planRevision !== (expectedPlanRevision === null ? 1 : expectedPlanRevision + 1)) throw new CanonicalPlanError("revision_conflict")
  if (!isPlainJsonObject(value.proposal) || !Array.isArray(value.intents) || value.intents.length > MAX_OBSERVATIONS) throw new CanonicalPlanError("invalid_plan_output")
  const encoded = JSON.stringify(value)
  if (encoded === undefined || Buffer.byteLength(encoded, "utf8") > 64 * 1024) throw new CanonicalPlanError("invalid_plan_output")
  return { planRevision, basedOnPlanRevision, proposal: value.proposal }
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

function boundedRecords(result: { readonly completed: readonly PlanCommandExecutionRecord[]; readonly failure?: PlanCommandExecutionRecord }): readonly PlanCommandExecutionRecord[] {
  const records = result.failure ? [...result.completed, result.failure] : [...result.completed]
  return records.length <= MAX_OBSERVATIONS ? records : [...records.slice(0, MAX_OBSERVATIONS - 1), records[records.length - 1]!]
}

export function createCanonicalPlanExecutionFactory(options: CanonicalPlanExecutionOptions): (input: Parameters<TurnEnginePlanExecutionHook>[0]) => Promise<TurnEnginePlanExecutionHookResult> {
  if (!Number.isSafeInteger(options.goal.revision) || options.goal.revision < 1 || !Number.isSafeInteger(options.maxNodes) || options.maxNodes < 1 || options.maxNodes > PLAN_MAX_NODES) throw new TypeError("Invalid server plan execution bounds")
  const allowedTools = Object.freeze([...options.allowedTools])
  const allowedTemplates = Object.freeze([...options.allowedTemplates])
  const allowedRoles = Object.freeze([...options.allowedRoles])
  let currentPlanRevision: number | null = null
  return async input => {
    const baseError = (code: string): TurnEnginePlanExecutionHookResult => ({ observations: [failureObservation(input.call.id, code)] })
    try {
      if (input.result.status !== "completed" || input.result.toolName !== "agent.plan.propose") throw new CanonicalPlanError("invalid_plan_output")
      const output = accepted(input.result.output, options.goal.revision, currentPlanRevision)
      const dispatched = dispatchPlanProposal(output.proposal, {
        goalRevision: options.goal.revision, planRevision: output.basedOnPlanRevision, maxNodes: options.maxNodes,
        allowedActions: [...PLAN_ACTIONS], allowedTools, allowedTemplates, allowedRoles,
      }, {
        resolveToolVersion: name => version(options.registry, options.capabilities, name),
        createToolCallId: localId => id("plan-call", input.call.id, localId),
        createIdempotencyKey: localId => id("plan-idempotency", input.call.id, localId),
        resolveDelegateActions: () => actions(options.registry, options.capabilities, allowedTools),
      })
      currentPlanRevision = output.planRevision
      const commandRuntime: PlanCommandExecutionRuntime = {
        router: options.router,
        createContext: request => ({ scope: options.scope, sessionId: options.lease.sessionId, turnId: options.lease.turnId, stepId: `${input.stepId}:plan:${request.localId}`, taskId: options.taskId, rootTaskId: options.rootTaskId, actorRole: options.actorRole, capabilities: [...options.capabilities], signal: input.signal }),
      }
      const executed = await executePlanCommands(dispatched, commandRuntime)
      const records = boundedRecords(executed)
      const observations = records.map(recordValue => recordObservation(input.call.id, recordValue))
      if (executed.blocked) {
        observations.push(controlObservation(input.call.id, executed.blocked))
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
