import { Type } from "@sinclair/typebox"
import { schemaVersion } from "@jobcopilot/agent-protocol"
import type { AgentTreeManager } from "../subagents/manager.js"
import {
  TaskGraphCommandError,
  type TaskGraphCommandPort,
} from "../subagents/task-graph-command-port.js"
import {
  parseTaskGraphSupersededScoutRetirementReceipt,
  type TaskGraphScoutRetirementInput,
} from "../subagents/task-graph-scout-retirement-contract.js"
import { steeringReconciliationId } from "../subagents/steering-reconciliation-contract.js"
import { taskGraphExecutionScope, type ReconciliationFenceOptions } from "./steering-reconciliation.js"
import { markTaskGraphRetirementOutput } from "./task-graph-retirement-output-redaction.js"
import { ToolExecutionError, type RuntimeToolDefinition, type ToolExecutionContext } from "./types.js"

type Registry = Readonly<{ register?(definition: RuntimeToolDefinition): void }>
type Options = ReconciliationFenceOptions & Readonly<{
  commandPort?: TaskGraphCommandPort
  manager: AgentTreeManager
}>
type RetirementInput = Readonly<{ expectedRevision: number; taskId: string }>

const Input = Type.Object({
  expectedRevision: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  taskId: Type.String({ minLength: 1, maxLength: 128 }),
}, { additionalProperties: false })
const Output = Type.Object({
  status: Type.Union([Type.Literal("interrupt_requested"), Type.Literal("already_requested")]),
  taskId: Type.String({ minLength: 1, maxLength: 256 }),
  attempt: Type.Integer({ minimum: 1 }),
}, { additionalProperties: false })

function safeCode(error: unknown): string {
  if (error instanceof TaskGraphCommandError && ["revision_mismatch", "task_graph_scout_retirement_unavailable"].includes(error.code)) return error.code
  return "task_graph_scout_retirement_failed"
}

function safeOutput(error: unknown, code: string): Readonly<{ code: string; currentRevision?: number }> {
  const currentRevision = error instanceof TaskGraphCommandError ? error.currentRevision : undefined
  return code === "revision_mismatch" && Number.isSafeInteger(currentRevision) && currentRevision! >= 0
    ? { code, currentRevision }
    : { code }
}

async function executeRetirement(
  context: ToolExecutionContext,
  input: RetirementInput,
  options: Options,
) {
  const port = options.commandPort?.requestSupersededScoutRetirement
  if (typeof port !== "function") throw new ToolExecutionError(
    "task_graph_scout_retirement_unavailable", "The exact Scout retirement action is unavailable")
  const scope = taskGraphExecutionScope(context, options)
  if (!steeringReconciliationId(context.toolCallId)) throw new ToolExecutionError(
    "task_graph_scout_retirement_call_unavailable", "A persisted Root tool call is required")
  const request: TaskGraphScoutRetirementInput = {
    scope, expectedRevision: input.expectedRevision, taskId: input.taskId, callId: context.toolCallId,
  }
  let result: Awaited<ReturnType<NonNullable<TaskGraphCommandPort["requestSupersededScoutRetirement"]>>>
  try { result = await port.call(options.commandPort, request) }
  catch (error: unknown) {
    if (error instanceof ToolExecutionError) throw error
    const code = safeCode(error)
    throw new ToolExecutionError(code, "The exact Scout retirement request was not accepted", safeOutput(error, code))
  }
  if (!result || typeof result !== "object"
    || (result.status !== "requested" && result.status !== "duplicate")
    || typeof result.receiptEventId !== "string" || !result.receiptEventId.trim()) {
    throw new ToolExecutionError("task_graph_scout_retirement_receipt_invalid", "The retirement request did not return a valid acknowledgement")
  }
  const receipt = parseTaskGraphSupersededScoutRetirementReceipt(result.receipt, {
    sessionId: scope.sessionId, turnId: scope.turnId, rootTaskId: scope.rootTaskId,
    taskId: input.taskId,
  })
  if (!receipt || result.taskId !== input.taskId || receipt.graphRevision !== input.expectedRevision) {
    throw new ToolExecutionError("task_graph_scout_retirement_receipt_invalid", "The retirement request receipt did not match this Root action")
  }
  try { options.manager.signalTaskSubtree(scope.sessionId, scope.rootTaskId, [input.taskId]) }
  catch { /* The committed database marker remains authoritative and heartbeat-visible. */ }
  const status = result.status === "duplicate" ? "already_requested" as const : "interrupt_requested" as const
  const output = { status, taskId: receipt.taskId, attempt: receipt.attempt }
  markTaskGraphRetirementOutput(output, { sessionId: scope.sessionId, turnId: scope.turnId,
    rootTaskId: scope.rootTaskId, parentTaskId: scope.parentTaskId, stepId: scope.stepId, toolCallId: context.toolCallId },
  receipt.taskId, status, receipt.attempt)
  return output
}

export function createTaskGraphSupersededScoutRetirementTool(options: Options): RuntimeToolDefinition {
  return {
    schemaVersion, name: "agent.retire_superseded_scout", version: "1",
    description: "After a replacement Scout is accepted on the current TaskGraph, request interruption of one exact superseded Scout by taskId and current graph revision. The server derives its unique node and verifies the accepted scope. This records only an interruption request, not retirement or evidence; call agent.wait for this exact task and refresh agent.list before replanning or completing.",
    capabilities: ["coordination"], inputSchema: Input, outputSchema: Output,
    risk: "internal_write", domain: "coordination", idempotency: "idempotent", timeoutMs: 15_000,
    requiredCapabilities: ["coordination", "canManageChildren"],
    execute: (context, value) => executeRetirement(context, value as RetirementInput, options),
  }
}

export function registerTaskGraphSupersededScoutRetirementTool(
  registry: Registry,
  objectiveTaskGraphMode: boolean,
  options: Options,
): boolean {
  if (!objectiveTaskGraphMode || !registry.register
    || typeof options.commandPort?.requestSupersededScoutRetirement !== "function") return false
  registry.register(createTaskGraphSupersededScoutRetirementTool(options))
  return true
}
