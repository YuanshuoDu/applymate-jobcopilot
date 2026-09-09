import { Buffer } from "node:buffer"

import { PLAN_MAX_NODES, isPlainJsonObject } from "./goal-plan-contract.js"
import type { PlanDispatchCommand, PlanDispatchResult } from "./plan-intent-dispatcher.js"
import type { ToolCallRequest, ToolExecutionResult, ToolRouterContext } from "../tools/types.js"

const MAX_RESULT_BYTES = 8 * 1024

export type PlanCommandExecutionErrorCode = "runtime_unavailable" | "invalid_plan" | "router_result_mismatch" | "observer_failed"

export class PlanCommandExecutionError extends Error {
  constructor(readonly code: PlanCommandExecutionErrorCode, message: string) {
    super(message)
    this.name = "PlanCommandExecutionError"
  }
}

type ExecutableCommand = Extract<PlanDispatchCommand, { kind: "tool_call" | "delegate" }>
type CommandContextRequest = { readonly localId: string; readonly kind: ExecutableCommand["kind"] }
export type PlanCommandExecutionRecord = {
  readonly localId: string
  readonly kind: ExecutableCommand["kind"]
  readonly dependsOn: readonly string[]
  readonly result: ToolExecutionResult
}
export type PlanControlRecord =
  | { readonly localId: string; readonly kind: "request_input"; readonly dependsOn: readonly string[]; readonly question: string; readonly approvalBoundary?: string }
  | { readonly localId: string; readonly kind: "propose_completion"; readonly dependsOn: readonly string[]; readonly completionCriteria: readonly string[] }

export type PlanCommandExecutionRuntime = {
  readonly router?: { execute(context: ToolRouterContext, request: ToolCallRequest): Promise<ToolExecutionResult> }
  readonly createContext?: (request: CommandContextRequest) => ToolRouterContext | Promise<ToolRouterContext>
  readonly observe?: (record: PlanCommandExecutionRecord | PlanControlRecord) => void | Promise<void>
}

export type PlanCommandExecutionResult = {
  readonly status: "completed" | "failed" | "blocked"
  readonly completed: readonly PlanCommandExecutionRecord[]
  readonly failure?: PlanCommandExecutionRecord
  readonly blocked?: PlanControlRecord
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
  if (!command || (command.kind !== "tool_call" && command.kind !== "delegate")) return false
  if (typeof command.localId !== "string" || !command.localId.trim() || !strings(command.dependsOn) || !strings(command.inputRefs)) return false
  const call = row(command.call)
  if (!call || typeof call.id !== "string" || !call.id.trim() || typeof call.toolName !== "string" || !call.toolName.trim() || typeof call.toolVersion !== "string" || !call.toolVersion.trim()) return false
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
  for (const command of commands) {
    if (control(command)) {
      await observe(runtime, command)
      return { status: "blocked", completed, blocked: command }
    }
    if (!executable(command)) throw new PlanCommandExecutionError("invalid_plan", "Plan executable command is invalid")
    const requestValue = request(command)
    let response: ToolExecutionResult
    try { response = result(await runtime.router.execute(await context(runtime, command), requestValue), requestValue) } catch (error: unknown) {
      if (error instanceof PlanCommandExecutionError) throw error
      response = { ...requestValue, status: "failed", errorCode: "router_execution_failed" }
    }
    const record: PlanCommandExecutionRecord = { localId: command.localId, kind: command.kind, dependsOn: [...command.dependsOn], result: response }
    await observe(runtime, record)
    if (response.status !== "completed") return { status: "failed", completed, failure: record }
    completed.push(record)
  }
  return { status: "completed", completed }
}
