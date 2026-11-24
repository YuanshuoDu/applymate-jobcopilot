import { Type } from "@sinclair/typebox"
import { schemaVersion } from "@jobcopilot/agent-protocol"
import type { TaskGraphCommandPort } from "../subagents/task-graph-command-port.js"
import { taskGraphExecutionScope, type ReconciliationFenceOptions } from "./steering-reconciliation.js"
import { ToolExecutionError, type RuntimeToolDefinition } from "./types.js"

type TailorToolRegistry = Readonly<{ register?: (definition: RuntimeToolDefinition) => void }>

const Input = Type.Object({
  expectedRevision: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  candidateRef: Type.String({ minLength: 69, maxLength: 69, pattern: "^otc1_[a-f0-9]{64}$" }),
}, { additionalProperties: false })
const Id = Type.String({ minLength: 1, maxLength: 256 })
const Output = Type.Object({
  status: Type.Union([Type.Literal("accepted"), Type.Literal("duplicate")]),
  revision: Type.Integer({ minimum: 0 }),
  nodes: Type.Array(Type.Object({ key: Id, taskId: Id,
    status: Type.Union([Type.Literal("queued"), Type.Literal("waiting")]) }, { additionalProperties: false })),
  readyTaskIds: Type.Array(Id),
}, { additionalProperties: false })

export function createAgentTailorTool(commandPort: TaskGraphCommandPort, options: ReconciliationFenceOptions): RuntimeToolDefinition {
  return {
    schemaVersion, name: "agent.tailor", version: "1",
    description: "First run a read-only Scout and Analyst plan, wait for its current graph to become terminal, and confirm each shortlisted job has a passed Analyst with verified Scout-membership evidence and an exact jobs.get receipt. Then append one Writer and same-job Reviewer pair using only the current catalog's candidateRef and graphRevision. Do not provide job IDs, source evidence, draft content, or review proof.",
    capabilities: ["coordination"], inputSchema: Input, outputSchema: Output,
    risk: "internal_write", domain: "coordination", idempotency: "idempotent", timeoutMs: 30_000,
    requiredCapabilities: ["coordination", "canManageChildren"],
    async execute(context, value) {
      if (context.actorRole !== "orchestrator" || !context.taskId || context.taskId !== context.rootTaskId
        || !context.capabilities.includes("coordination") || !context.capabilities.includes("canManageChildren")) {
        throw new ToolExecutionError("objective_tailor_root_only", "Only the active Objective root can append a tailoring pair")
      }
      if (!context.remainingTurnSteps || !Number.isSafeInteger(context.remainingTurnSteps) || context.remainingTurnSteps < 2) {
        throw new ToolExecutionError("task_graph_continuation_budget_required", "The Turn needs two remaining steps to supervise the tailoring pair")
      }
      if (typeof commandPort.appendObjectiveTailor !== "function") {
        throw new ToolExecutionError("objective_tailor_unavailable", "Objective tailoring is unavailable for this Turn")
      }
      const input = value as { expectedRevision: number; candidateRef: string }
      if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1 || typeof input.candidateRef !== "string"
        || !/^otc1_[a-f0-9]{64}$/.test(input.candidateRef)) {
        throw new ToolExecutionError("objective_tailor_input_invalid", "Provide the current catalog revision and one exact candidate reference")
      }
      const scope = { ...taskGraphExecutionScope(context, options), ...(options.rootInputId === undefined ? {} : { rootInputId: options.rootInputId }) }
      try {
        return await commandPort.appendObjectiveTailor({ scope, expectedRevision: input.expectedRevision, candidateRef: input.candidateRef })
      } catch (error: unknown) {
        const code = error && typeof error === "object" && "code" in error && typeof error.code === "string"
          && /^[a-z][a-z0-9_]{0,79}$/.test(error.code) ? error.code : "objective_tailor_failed"
        throw new ToolExecutionError(code, "The candidate could not be added to the current objective graph",
          error && typeof error === "object" && "currentRevision" in error && Number.isSafeInteger(error.currentRevision)
            ? { code, currentRevision: error.currentRevision } : { code })
      }
    },
  }
}

export function registerAgentTailorTool(
  registry: TailorToolRegistry, commandPort: TaskGraphCommandPort | undefined,
  enabled: () => boolean, options: ReconciliationFenceOptions,
): boolean {
  if (!enabled() || typeof registry.register !== "function"
    || typeof commandPort?.readObjectiveTailorCatalog !== "function"
    || typeof commandPort.appendObjectiveTailor !== "function") return false
  registry.register(createAgentTailorTool(commandPort, options))
  return true
}
