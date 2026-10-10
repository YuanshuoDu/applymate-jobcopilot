import { Type } from "@sinclair/typebox"
import { schemaVersion } from "@jobcopilot/agent-protocol"
import { steeringReconciliationId, type SteeringReconciliationOperation } from "../subagents/steering-reconciliation-contract.js"
import type { TaskGraphCommandPort, TaskGraphExecutionScope } from "../subagents/task-graph-command-port.js"
import { ToolExecutionError, type RuntimeToolDefinition, type ToolExecutionContext } from "./types.js"

export type ReconciliationFenceOptions = Readonly<{
  turnLeaseOwner: string
  turnLeaseVersion: number
  parentLeaseOwner: string
  parentAttemptCount: () => number | null | undefined
  rootInputId?: string | null
}>

export function taskGraphExecutionScope(context: ToolExecutionContext, options: ReconciliationFenceOptions): TaskGraphExecutionScope {
  const { rootTaskId, taskId } = context, parentAttemptCount = options.parentAttemptCount()
  if ([context.scope.userId, context.sessionId, context.turnId, context.stepId, options.parentLeaseOwner].some(value => !value.trim())
    || typeof rootTaskId !== "string" || !rootTaskId.trim() || taskId !== rootTaskId
    || !options.turnLeaseOwner.trim() || !Number.isSafeInteger(options.turnLeaseVersion) || options.turnLeaseVersion < 1
    || typeof parentAttemptCount !== "number" || !Number.isSafeInteger(parentAttemptCount) || parentAttemptCount < 1) {
    throw new ToolExecutionError("task_graph_scope_unavailable", "The server could not establish the active root task fence")
  }
  return { userId: context.scope.userId, sessionId: context.sessionId, turnId: context.turnId, stepId: context.stepId,
    rootTaskId, parentTaskId: taskId, turnLeaseOwner: options.turnLeaseOwner, turnLeaseVersion: options.turnLeaseVersion,
    parentLeaseOwner: options.parentLeaseOwner, parentAttemptCount }
}

export function steeringReconciliationOperation(
  context: ToolExecutionContext, options: ReconciliationFenceOptions, decision: SteeringReconciliationOperation["decision"], expectedRevision: number,
): SteeringReconciliationOperation {
  if (!steeringReconciliationId(context.toolCallId)) throw new ToolExecutionError("steering_reconciliation_call_unavailable", "A persisted tool call is required")
  return { scope: taskGraphExecutionScope(context, options), decision, expectedRevision, callId: context.toolCallId,
    ...(options.rootInputId === undefined ? {} : { rootInputId: options.rootInputId }) }
}

const Input = Type.Object({ decision: Type.Literal("keep"), expectedRevision: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }) }, { additionalProperties: false })
const Output = Type.Object({ decision: Type.Literal("keep"), revision: Type.Integer({ minimum: 0 }), reconciledInputCount: Type.Integer({ minimum: 0, maximum: 128 }) }, { additionalProperties: false })

export function createSteeringReconciliationTool(commandPort: TaskGraphCommandPort, options: ReconciliationFenceOptions): RuntimeToolDefinition {
  return {
    schemaVersion, name: "agent.reconcile", version: "1",
    description: "Record that the current root Step honored all consumed user steering without changing the plan. For plan changes, use agent.plan with the current agenda revision. The server verifies the current Step and records only a private reconciliation receipt.",
    capabilities: ["coordination"], inputSchema: Input, outputSchema: Output, risk: "internal_write", domain: "coordination",
    idempotency: "idempotent", timeoutMs: 15_000, requiredCapabilities: ["coordination", "canManageChildren"],
    execute: async (context, value) => {
      if (typeof commandPort.reconcileSteering !== "function") throw new ToolExecutionError("steering_reconciliation_unavailable", "Reconciliation is unavailable")
      const input = value as { decision: "keep"; expectedRevision: number }
      try { return await commandPort.reconcileSteering(steeringReconciliationOperation(context, options, input.decision, input.expectedRevision)) }
      catch (error: unknown) {
        const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" && /^[a-z][a-z0-9_]{0,79}$/.test(error.code)
          ? error.code : "steering_reconciliation_failed"
        const currentRevision = error && typeof error === "object" && "currentRevision" in error ? error.currentRevision : undefined
        const safe = Number.isSafeInteger(currentRevision) && typeof currentRevision === "number" && currentRevision >= 0
          ? { code, currentRevision } : { code }
        throw new ToolExecutionError(code, "Steering could not be reconciled for the current Step", safe)
      }
    },
  }
}
