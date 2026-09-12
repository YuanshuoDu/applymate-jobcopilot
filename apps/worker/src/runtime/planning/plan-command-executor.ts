import { Buffer } from "node:buffer"

import { PLAN_MAX_NODES, isPlainJsonObject } from "./goal-plan-contract.js"
import type { PlanDispatchCommand, PlanDispatchResult } from "./plan-intent-dispatcher.js"
import type { ToolCallRequest, ToolExecutionResult, ToolRouterContext } from "../tools/types.js"

const MAX_RESULT_BYTES = 8 * 1024
const MAX_OUTPUTS = PLAN_MAX_NODES

export type PlanCommandExecutionErrorCode = "runtime_unavailable" | "invalid_plan" | "router_result_mismatch" | "observer_failed" | "input_reference_unavailable" | "input_reference_conflict"

export class PlanCommandExecutionError extends Error {
  constructor(readonly code: PlanCommandExecutionErrorCode, message: string) {
    super(message)
    this.name = "PlanCommandExecutionError"
  }
}

type ExecutableCommand = Extract<PlanDispatchCommand, { kind: "tool_call" | "delegate" | "join" }>
export type PlanJoinCommand = Extract<PlanDispatchCommand, { kind: "join" }>
type JoinCommand = PlanJoinCommand
export type CommandContextRequest = { readonly localId: string; readonly kind: ExecutableCommand["kind"] }
export type PlanCommandExecutionRecord = {
  readonly localId: string
  readonly kind: ExecutableCommand["kind"]
  readonly dependsOn: readonly string[]
  readonly result: ToolExecutionResult
}
export type PlanInputReferenceResolutionRequest = {
  readonly localId: string
  readonly inputRefs: readonly string[]
  readonly dependsOn: readonly string[]
  readonly outputs: ReadonlyMap<string, unknown>
}
export type PlanControlRecord =
  | { readonly localId: string; readonly kind: "request_input"; readonly dependsOn: readonly string[]; readonly question: string; readonly approvalBoundary?: string }
  | { readonly localId: string; readonly kind: "propose_completion"; readonly dependsOn: readonly string[]; readonly completionCriteria: readonly string[] }

export type PlanCommandExecutionRuntime = {
  readonly router?: { execute(context: ToolRouterContext, request: ToolCallRequest): Promise<ToolExecutionResult> }
  readonly createContext?: (request: CommandContextRequest) => ToolRouterContext | Promise<ToolRouterContext>
  readonly resolveInputRefs?: (request: PlanInputReferenceResolutionRequest) => unknown
  readonly rootTaskId?: string
  readonly resolveReplayedJoin?: (request: { readonly command: JoinCommand; readonly taskIds: readonly string[] }) => ToolExecutionResult | undefined | Promise<ToolExecutionResult | undefined>
  readonly observe?: (record: PlanCommandExecutionRecord | PlanControlRecord) => void | Promise<void>
}

export type PlanCommandExecutionResult = {
  readonly status: "completed" | "failed" | "blocked" | "waiting"
  readonly completed: readonly PlanCommandExecutionRecord[]
  readonly failure?: PlanCommandExecutionRecord
  readonly blocked?: PlanControlRecord
  readonly waiting?: PlanCommandExecutionRecord
}

function row(value: unknown): Record<string, unknown> | null {
  return isPlainJsonObject(value) ? value : null
}

function strings(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.length <= 32 && value.every(item => typeof item === "string" && item.trim().length > 0 && item.length <= 4_000)
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

function executable(value: unknown): value is ExecutableCommand {
  const command = row(value)
  if (!command || (command.kind !== "tool_call" && command.kind !== "delegate" && command.kind !== "join")) return false
  if (typeof command.localId !== "string" || !command.localId.trim() || !strings(command.dependsOn) || !strings(command.inputRefs)) return false
  const call = row(command.call)
  if (!call || typeof call.id !== "string" || !call.id.trim() || typeof call.toolName !== "string" || !call.toolName.trim() || typeof call.toolVersion !== "string" || !call.toolVersion.trim()) return false
  if (command.kind === "join") {
    const joinInput = row(call.input)
    return call.toolName === "wait_subagents" && call.toolVersion === "1" && Boolean(joinInput)
      && typeof joinInput?.idempotencyKey === "string" && Boolean(joinInput.idempotencyKey.trim())
      && Object.keys(joinInput).every(key => ["idempotencyKey", "taskIds", "mode", "timeoutMs"].includes(key))
      && Array.isArray(joinInput.taskIds) && joinInput.taskIds.length === 0
      && (joinInput.mode === "any" || joinInput.mode === "all")
      && typeof joinInput.timeoutMs === "number" && Number.isSafeInteger(joinInput.timeoutMs) && joinInput.timeoutMs >= 1 && joinInput.timeoutMs <= 30_000
  }
  if (command.kind === "tool_call") return isPlainJsonObject(call.input) && plainJson(call.input)
  const delegateInput = row(call.input)
  return call.toolName === "spawn_subagent" && call.toolVersion === "1" && Boolean(delegateInput)
    && typeof delegateInput?.idempotencyKey === "string" && Boolean(delegateInput.idempotencyKey.trim())
    && typeof delegateInput.role === "string" && Boolean(delegateInput.role.trim())
    && typeof delegateInput.taskType === "string" && Boolean(delegateInput.taskType.trim())
    && typeof delegateInput.goal === "string" && Boolean(delegateInput.goal.trim())
    && strings(delegateInput.constraints) && strings(delegateInput.successCriteria) && strings(delegateInput.allowedActions)
}

function control(value: unknown): value is PlanControlRecord {
  const command = row(value)
  if (!command || (command.kind !== "request_input" && command.kind !== "propose_completion")) return false
  if (typeof command.localId !== "string" || !command.localId.trim() || !strings(command.dependsOn)) return false
  if (command.kind === "request_input") return typeof command.question === "string" && Boolean(command.question.trim()) && (command.approvalBoundary === undefined || typeof command.approvalBoundary === "string")
  return strings(command.completionCriteria)
}

function request(command: ExecutableCommand): ToolCallRequest {
  return command.call
}

function resolvedRequest(runtime: PlanCommandExecutionRuntime, command: ExecutableCommand, outputs: ReadonlyMap<string, unknown>): ToolCallRequest {
  const original = request(command)
  if (command.inputRefs.length === 0) return original
  if (!runtime.resolveInputRefs) {
    if (command.inputRefsDeferred) throw new PlanCommandExecutionError("input_reference_unavailable", "Plan input references are unavailable")
    return original
  }
  let resolved: unknown
  try {
    resolved = runtime.resolveInputRefs({ localId: command.localId, inputRefs: [...command.inputRefs], dependsOn: [...command.dependsOn], outputs })
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "input_reference_conflict") throw new PlanCommandExecutionError("input_reference_conflict", "Plan input references conflict")
    throw new PlanCommandExecutionError("input_reference_unavailable", "Plan input references are unavailable")
  }
  if (!isPlainJsonObject(resolved) || !plainJson(resolved)) throw new PlanCommandExecutionError("input_reference_unavailable", "Plan input references are unavailable")
  let encoded: string | undefined
  try { encoded = JSON.stringify(resolved) } catch { encoded = undefined }
  if (encoded === undefined || Buffer.byteLength(encoded, "utf8") > MAX_RESULT_BYTES) throw new PlanCommandExecutionError("input_reference_unavailable", "Plan input references are unavailable")
  if (command.kind === "tool_call") return { ...original, input: resolved }
  return { ...original, input: { ...command.call.input, context: resolved } }
}

const IDENTITY_KEYS = new Set(["userId", "sessionId", "turnId", "stepId", "taskId", "parentTaskId", "rootTaskId", "ownerId", "lease", "leaseOwnerId", "leaseVersion", "idempotencyKey", "capabilities", "permissions", "allowedCapabilities", "budgetLimit", "maxBudget"])

function containsIdentityKey(value: unknown, allowed = new Set<string>(), seen = new Set<object>()): boolean {
  if (!value || typeof value !== "object" || seen.has(value)) return false
  if (Array.isArray(value)) { seen.add(value); const found = value.some(item => containsIdentityKey(item, allowed, seen)); seen.delete(value); return found }
  if (!isPlainJsonObject(value)) return false
  if (Object.keys(value).some(key => IDENTITY_KEYS.has(key) && !allowed.has(key))) return true
  seen.add(value); const found = Object.values(value).some(item => containsIdentityKey(item, allowed, seen)); seen.delete(value); return found
}

function joinTaskIds(runtime: PlanCommandExecutionRuntime, command: JoinCommand, outputs: ReadonlyMap<string, unknown>): readonly string[] {
  const taskIds: string[] = []
  for (const ref of command.inputRefs) {
    const parsed = row(outputs.get(ref))
    if (!parsed || !plainJson(parsed) || containsIdentityKey(parsed, new Set(["taskId", "rootTaskId", "parentTaskId"]))) throw new PlanCommandExecutionError("input_reference_unavailable", "Join delegate output is unavailable")
    const taskId = parsed.taskId
    const validId = (value: unknown): value is string => typeof value === "string" && Boolean(value.trim()) && value.length <= 256
    if (!validId(taskId) || (parsed.rootTaskId !== undefined && !validId(parsed.rootTaskId)) || (parsed.parentTaskId !== undefined && parsed.parentTaskId !== null && !validId(parsed.parentTaskId))) throw new PlanCommandExecutionError("input_reference_unavailable", "Join delegate output is unavailable")
    if (runtime.rootTaskId !== undefined && (!validId(parsed.rootTaskId) || !validId(parsed.parentTaskId) || parsed.rootTaskId !== runtime.rootTaskId || parsed.parentTaskId !== runtime.rootTaskId)) throw new PlanCommandExecutionError("input_reference_unavailable", "Join delegate output is unavailable")
    if (taskIds.includes(taskId)) throw new PlanCommandExecutionError("input_reference_unavailable", "Join delegate outputs contain duplicate task IDs")
    taskIds.push(taskId)
  }
  if (taskIds.length === 0 || taskIds.length > 8) throw new PlanCommandExecutionError("input_reference_unavailable", "Join delegate outputs are unavailable")
  return taskIds
}

function waitingJoin(value: unknown): boolean {
  const output = row(value)
  return Boolean(output && output.status === "waiting" && typeof output.waitId === "string" && output.waitId.trim())
}

function validateJoinResult(value: unknown): void {
  const output = row(value)
  if (!output || !plainJson(output) || containsIdentityKey(output, new Set(["taskId"])) || !["waiting", "ready", "timed_out"].includes(String(output.status)) || typeof output.waitId !== "string" || !output.waitId.trim() || output.waitId.length > 256) throw new PlanCommandExecutionError("router_result_mismatch", "Wait router returned an invalid result")
  if (output.taskIds !== undefined && (!Array.isArray(output.taskIds) || output.taskIds.length > 8 || !output.taskIds.every(item => typeof item === "string" && item.trim()))) throw new PlanCommandExecutionError("router_result_mismatch", "Wait router returned an invalid result")
  if (output.matchedTaskIds !== undefined && (!Array.isArray(output.matchedTaskIds) || output.matchedTaskIds.length > 8 || !output.matchedTaskIds.every(item => typeof item === "string" && item.trim()))) throw new PlanCommandExecutionError("router_result_mismatch", "Wait router returned an invalid result")
}

function context(runtime: PlanCommandExecutionRuntime, command: ExecutableCommand): Promise<ToolRouterContext> {
  if (!runtime.createContext) throw new PlanCommandExecutionError("runtime_unavailable", "Plan command context is unavailable")
  let provided: ToolRouterContext | Promise<ToolRouterContext>
  try { provided = runtime.createContext({ localId: command.localId, kind: command.kind }) } catch { throw new PlanCommandExecutionError("runtime_unavailable", "Plan command context is unavailable") }
  return Promise.resolve(provided).then(value => {
    const scope = row(value?.scope)
    if (!value || typeof value !== "object" || !scope || typeof scope.userId !== "string" || !scope.userId.trim() || typeof value.sessionId !== "string" || !value.sessionId.trim() || typeof value.turnId !== "string" || !value.turnId.trim() || typeof value.stepId !== "string" || !value.stepId.trim()) throw new PlanCommandExecutionError("runtime_unavailable", "Plan command context is invalid")
    return value
  }).catch(error => {
    if (error instanceof PlanCommandExecutionError) throw error
    throw new PlanCommandExecutionError("runtime_unavailable", "Plan command context is unavailable")
  })
}

async function observe(runtime: PlanCommandExecutionRuntime, record: PlanCommandExecutionRecord | PlanControlRecord): Promise<void> {
  if (!runtime.observe) return
  try { await runtime.observe(record) } catch { throw new PlanCommandExecutionError("observer_failed", "Plan command observation failed") }
}

function validatePlanCommands(value: PlanDispatchResult): readonly PlanDispatchCommand[] {
  if (!value || !Array.isArray(value.commands) || value.commands.length > PLAN_MAX_NODES) throw new PlanCommandExecutionError("invalid_plan", "Plan command count exceeds the runtime bound")
  for (const command of value.commands) if (!executable(command) && !control(command)) throw new PlanCommandExecutionError("invalid_plan", "Plan command is invalid")
  return value.commands
}

function result(value: unknown, requestValue: ToolCallRequest): ToolExecutionResult {
  const parsed = row(value)
  if (!parsed) throw new PlanCommandExecutionError("router_result_mismatch", "Tool router returned an invalid result")
  const validStatus = typeof parsed.status === "string" && ["completed", "failed", "cancelled"].includes(parsed.status)
  const validError = parsed.errorCode === null || typeof parsed.errorCode === "string"
  const validPlainOutput = parsed.output === undefined || plainJson(parsed.output)
  let serializedOutput: string | undefined
  if (validPlainOutput && parsed.output !== undefined) {
    try { serializedOutput = JSON.stringify(parsed.output) } catch { serializedOutput = undefined }
  }
  const validOutput = parsed.output === undefined || (serializedOutput !== undefined && Buffer.byteLength(serializedOutput, "utf8") <= MAX_RESULT_BYTES)
  if (parsed.id !== requestValue.id || parsed.toolName !== requestValue.toolName || parsed.toolVersion !== requestValue.toolVersion || !validStatus || !validError || !validOutput) throw new PlanCommandExecutionError("router_result_mismatch", "Tool router returned an invalid result")
  return parsed as unknown as ToolExecutionResult
}

export async function executePlanCommands(plan: PlanDispatchResult, runtime: PlanCommandExecutionRuntime): Promise<PlanCommandExecutionResult> {
  const commands = validatePlanCommands(plan)
  if (!runtime.router || typeof runtime.router.execute !== "function") throw new PlanCommandExecutionError("runtime_unavailable", "Plan command router is unavailable")
  const completed: PlanCommandExecutionRecord[] = []
  const outputs = new Map<string, unknown>()
  for (const command of commands) {
    if (control(command)) {
      await observe(runtime, command)
      return { status: "blocked", completed, blocked: command }
    }
    if (!executable(command)) throw new PlanCommandExecutionError("invalid_plan", "Plan executable command is invalid")
    const taskIds = command.kind === "join" ? joinTaskIds(runtime, command, outputs) : undefined
    const requestValue = command.kind === "join" ? { ...command.call, input: { ...command.call.input, taskIds: [...taskIds!] } } : resolvedRequest(runtime, command, outputs)
    let response: ToolExecutionResult
    try {
      const replayed = command.kind === "join" ? await runtime.resolveReplayedJoin?.({ command, taskIds: taskIds! }) : undefined
      response = result(replayed ?? await runtime.router.execute(await context(runtime, command), requestValue), requestValue)
      if (command.kind === "join" && response.status === "completed") validateJoinResult(response.output)
    } catch (error: unknown) {
      if (error instanceof PlanCommandExecutionError) throw error
      if (error instanceof Error && error.name === "CanonicalPlanError") throw error
      response = { ...requestValue, status: "failed", errorCode: "router_execution_failed" }
    }
    const record: PlanCommandExecutionRecord = { localId: command.localId, kind: command.kind, dependsOn: [...command.dependsOn], result: response }
    await observe(runtime, record)
    if (response.status !== "completed") return { status: "failed", completed, failure: record }
    if (isPlainJsonObject(response.output) && plainJson(response.output)) {
      let encoded: string | undefined
      try { encoded = JSON.stringify(response.output) } catch { encoded = undefined }
      if (encoded !== undefined && Buffer.byteLength(encoded, "utf8") <= MAX_RESULT_BYTES && outputs.size < MAX_OUTPUTS) outputs.set(command.localId, response.output)
    }
    if (command.kind === "join" && waitingJoin(response.output)) return { status: "waiting", completed, waiting: record }
    completed.push(record)
  }
  return { status: "completed", completed }
}
