import { Type, type TSchema } from "@sinclair/typebox"
import { schemaVersion } from "@jobcopilot/agent-protocol"
import { redactSensitiveText } from "@jobcopilot/shared"
import { TASK_GRAPH_LIMITS, type TaskGraphProposal } from "../planning/task-graph.js"
import { TASK_GRAPH_VERIFICATION_LIMITS, TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, taskGraphVerificationRole, type TaskGraphVerificationRole } from "../planning/task-graph-verification.js"
import type {
  TaskGraphCommandPort,
  TaskGraphExecutionScope,
  TaskGraphScheduleReceipt,
  TaskGraphTaskTemplate,
} from "../subagents/task-graph-command-port.js"
import { normalizeRootPlanCriteria } from "../subagents/root-plan-criteria.js"

import { ToolExecutionError, type RuntimeToolDefinition, type ToolExecutionContext } from "./types.js"

function verificationCheckSchema(role: TaskGraphVerificationRole): TSchema {
  const evidence = Type.Object({ kind: Type.Literal("evidence_count_gte"), minimum: Type.Integer({ minimum: 1, maximum: TASK_GRAPH_VERIFICATION_LIMITS.maxItems }) }, { additionalProperties: false })
  const roleChecks: TSchema[] = role === "scout"
    ? [
      Type.Object({ kind: Type.Literal("candidate_count_gte"), minimum: Type.Integer({ minimum: 1, maximum: TASK_GRAPH_VERIFICATION_LIMITS.maxItems }) }, { additionalProperties: false }),
      Type.Object({ kind: Type.Literal("all_candidates_have_evidence"), minimumItems: Type.Integer({ minimum: 1, maximum: TASK_GRAPH_VERIFICATION_LIMITS.maxItems }) }, { additionalProperties: false }),
    ]
    : [
      Type.Object({ kind: Type.Literal("finding_count_gte"), minimum: Type.Integer({ minimum: 1, maximum: TASK_GRAPH_VERIFICATION_LIMITS.maxItems }) }, { additionalProperties: false }),
      Type.Object({ kind: Type.Literal("all_findings_have_evidence"), minimumItems: Type.Integer({ minimum: 1, maximum: TASK_GRAPH_VERIFICATION_LIMITS.maxItems }) }, { additionalProperties: false }),
      Type.Object({
        kind: Type.Literal("reported_score_gte"), minimumScore: Type.Number({ minimum: 0, maximum: TASK_GRAPH_VERIFICATION_LIMITS.maxScore }),
        minimumFindings: Type.Integer({ minimum: 1, maximum: TASK_GRAPH_VERIFICATION_LIMITS.maxItems }),
        aggregation: Type.Union([Type.Literal("any"), Type.Literal("all")]),
      }, { additionalProperties: false }),
    ]
  return Type.Union([evidence, ...roleChecks] as [TSchema, ...TSchema[]])
}

function verificationSchema(role: TaskGraphVerificationRole): TSchema {
  return Type.Object({
    schemaVersion: Type.Literal(TASK_GRAPH_VERIFICATION_SCHEMA_VERSION),
    role: Type.Literal(role),
    criteria: Type.Array(Type.Object({
      id: Type.String({ minLength: 1, maxLength: TASK_GRAPH_VERIFICATION_LIMITS.maxCriterionIdLength, pattern: "^[a-z][a-z0-9._-]{0,63}$" }),
      check: verificationCheckSchema(role),
    }, { additionalProperties: false }), { minItems: 1, maxItems: TASK_GRAPH_VERIFICATION_LIMITS.maxCriteria }),
  }, { additionalProperties: false })
}

function repairOfSchema(): TSchema {
  return Type.Object({
    graphRootTaskId: Type.String({ minLength: 1, maxLength: TASK_GRAPH_LIMITS.maxKeyLength }),
    nodeKey: Type.String({ minLength: 1, maxLength: TASK_GRAPH_LIMITS.maxKeyLength }),
    taskId: Type.String({ minLength: 1, maxLength: TASK_GRAPH_LIMITS.maxKeyLength }),
    criterionIds: Type.Array(Type.String({ minLength: 1, maxLength: TASK_GRAPH_VERIFICATION_LIMITS.maxCriterionIdLength, pattern: "^[a-z][a-z0-9._-]{0,63}$" }), { minItems: 1, maxItems: TASK_GRAPH_LIMITS.maxSuccessCriteria }),
  }, { additionalProperties: false })
}

function proposalNodeSchema<T extends TSchema>(templateIdSchema: T, role?: TaskGraphVerificationRole, genericVerification = false) {
  const properties = {
    key: Type.String({ minLength: 1, maxLength: TASK_GRAPH_LIMITS.maxKeyLength }),
    templateId: templateIdSchema,
    goal: Type.String({ minLength: 1, maxLength: TASK_GRAPH_LIMITS.maxGoalLength }),
    successCriteria: Type.Array(Type.String({ minLength: 1, maxLength: TASK_GRAPH_LIMITS.maxCriterionLength }), { minItems: 1, maxItems: TASK_GRAPH_LIMITS.maxSuccessCriteria }),
    dependsOn: Type.Array(Type.String({ minLength: 1, maxLength: TASK_GRAPH_LIMITS.maxKeyLength }), { maxItems: TASK_GRAPH_LIMITS.maxDependencies }),
  }
  if (role) Object.assign(properties, { verification: verificationSchema(role) })
  else if (genericVerification) Object.assign(properties, {
    verification: Type.Optional(Type.Union([verificationSchema("scout"), verificationSchema("analyst")])),
  })
  if (role || genericVerification) Object.assign(properties, { repairOf: Type.Optional(repairOfSchema()) })
  return Type.Object(properties, { additionalProperties: false })
}

function proposalInputSchema<T extends TSchema>(templateIdSchema: T, templates?: readonly (readonly [string, TaskGraphTaskTemplate])[]) {
  const nodeSchemas: TSchema[] = templates ? templates.map(([templateId, template]) => {
    const role = taskGraphVerificationRole(templateId)
    if (role && template.role !== role) throw new Error("task_graph_verification_template_role_mismatch")
    return proposalNodeSchema(Type.Literal(templateId), role)
  }) : [proposalNodeSchema(templateIdSchema, undefined, true)]
  const nodeSchema = nodeSchemas.length === 1 ? nodeSchemas[0]! : Type.Union(nodeSchemas as [TSchema, ...TSchema[]])
  return Type.Object({
    expectedRevision: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    nodes: Type.Array(nodeSchema, { minItems: 1, maxItems: TASK_GRAPH_LIMITS.maxNodes }),
    rootSuccessCriteria: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 4 })),
  }, { additionalProperties: false })
}

export const TaskGraphProposalInputSchema = proposalInputSchema(Type.String({ minLength: 1, maxLength: 128 }))

export type TaskGraphProposalInput = TaskGraphProposal & Readonly<{ rootSuccessCriteria?: readonly string[] }>

export type PlanningExecutorOptions = Readonly<{
  commandPort: TaskGraphCommandPort
  templates: Readonly<Record<string, TaskGraphTaskTemplate>>
  turnLeaseOwner: string
  turnLeaseVersion: number
  parentLeaseOwner: string
  parentAttemptCount: () => number | null | undefined
}>

export type PlanningRegistrationOptions = Readonly<{
  turnLeaseOwner: string
  turnLeaseVersion: number
  parentLeaseOwner: string
  parentAttemptCount: () => number | null | undefined
  commandPort?: TaskGraphCommandPort
  templates?: Readonly<Record<string, TaskGraphTaskTemplate>>
}>
export type TaskGraphToolRegistry = Readonly<{ register?(definition: RuntimeToolDefinition): void }>
const MAX_PROPOSAL_BYTES = TASK_GRAPH_LIMITS.maxProposalBytes
const MIN_CONTINUATION_STEPS = 2

const Id = Type.String({ minLength: 1, maxLength: 256 })
const TaskStatusSchema = Type.Union([
  Type.Literal("queued"), Type.Literal("waiting"),
])
const ReceiptSchema = Type.Object({
  status: Type.Union([Type.Literal("accepted"), Type.Literal("duplicate")]),
  revision: Type.Integer({ minimum: 0 }),
  nodes: Type.Array(Type.Object({ key: Id, taskId: Id, status: TaskStatusSchema }, { additionalProperties: false })),
  readyTaskIds: Type.Array(Id),
}, { additionalProperties: false })

function executionScope(context: ToolExecutionContext, options: PlanningExecutorOptions): TaskGraphExecutionScope {
  const { rootTaskId, taskId } = context
  const parentAttemptCount = options.parentAttemptCount()
  if ([context.scope.userId, context.sessionId, context.turnId, context.stepId, options.parentLeaseOwner]
    .some(value => !value.trim()) || typeof rootTaskId !== "string" || !rootTaskId.trim() ||
    typeof taskId !== "string" || !taskId.trim() ||
    taskId !== rootTaskId || !options.turnLeaseOwner.trim() || !Number.isSafeInteger(options.turnLeaseVersion) || options.turnLeaseVersion < 1 ||
    typeof parentAttemptCount !== "number" || !Number.isSafeInteger(parentAttemptCount) || parentAttemptCount < 1) {
    throw new ToolExecutionError("task_graph_scope_unavailable", "The server could not establish the active root task fence")
  }
  return {
    userId: context.scope.userId,
    sessionId: context.sessionId,
    turnId: context.turnId,
    stepId: context.stepId,
    rootTaskId,
    parentTaskId: taskId,
    turnLeaseOwner: options.turnLeaseOwner,
    turnLeaseVersion: options.turnLeaseVersion,
    parentLeaseOwner: options.parentLeaseOwner,
    parentAttemptCount: Number(parentAttemptCount),
  }
}

function scheduleErrorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string" && /^[a-z][a-z0-9_]{0,79}$/.test(error.code)) {
    return error.code
  }
  return "task_graph_schedule_failed"
}

function safeScheduleError(error: unknown, code: string): Readonly<{ code: string; currentRevision?: number }> {
  if (code !== "revision_mismatch" && code !== "task_graph_revision_mismatch") return { code }
  if (!error || typeof error !== "object" || !("currentRevision" in error)) return { code }
  const currentRevision = error.currentRevision
  return Number.isSafeInteger(currentRevision) && typeof currentRevision === "number" && currentRevision >= 0
    ? { code, currentRevision }
    : { code }
}

export function createTaskGraphPlanningTool(options: PlanningExecutorOptions): RuntimeToolDefinition {
  const templates = Object.entries(options.templates).sort(([left], [right]) => left.localeCompare(right))
  if (templates.length === 0) throw new Error("task_graph_templates_unavailable")
  const templateIdSchema = Type.Union(templates.map(([templateId]) => Type.Literal(templateId)))
  const templateCatalog = templates.map(([templateId, template]) => {
    const actions = template.allowedActions.map(action => JSON.stringify(action)).join(", ") || "none"
    return `- ${JSON.stringify(templateId)}: role ${JSON.stringify(template.role)}; allowed actions: ${actions}`
  }).join("\n")
  const execute: RuntimeToolDefinition["execute"] = async (context, value) => {
    const remainingSteps = context.remainingTurnSteps
    if (remainingSteps === undefined || !Number.isSafeInteger(remainingSteps) || remainingSteps < MIN_CONTINUATION_STEPS) {
      // Preserve one root step to establish the durable wait and one to evaluate results after wake.
      const code = "task_graph_continuation_budget_required"
      throw new ToolExecutionError(code, "The Turn needs two remaining steps to supervise a TaskGraph plan", { code, requiredSteps: MIN_CONTINUATION_STEPS })
    }
    const input = value as TaskGraphProposalInput
    const rootSuccessCriteria = normalizeRootPlanCriteria(input.rootSuccessCriteria)
    if (rootSuccessCriteria === null) {
      const code = "task_graph_root_criteria_invalid"
      throw new ToolExecutionError(code, "Additional root acceptance criteria must be one to four bounded, non-empty statements", { code })
    }
    const encoded = JSON.stringify(input)
    if (!encoded || Buffer.byteLength(encoded, "utf8") > MAX_PROPOSAL_BYTES) {
      throw new ToolExecutionError("task_graph_proposal_too_large", "TaskGraph proposal exceeds the bounded request size", { code: "task_graph_proposal_too_large", maxBytes: MAX_PROPOSAL_BYTES })
    }
    if (input.nodes.some(node => redactSensitiveText(node.key) !== node.key)) {
      throw new ToolExecutionError("task_graph_sensitive_key_rejected", "TaskGraph keys cannot contain contact or credential data")
    }
    const scope = executionScope(context, options)
    try {
      const receipt = await options.commandPort.appendAndSchedule({
        scope,
        proposal: {
          expectedRevision: input.expectedRevision,
          nodes: input.nodes.map(node => ({
            key: node.key, templateId: node.templateId, goal: node.goal,
            successCriteria: [...node.successCriteria], dependsOn: [...node.dependsOn],
            ...(node.verification ? { verification: node.verification } : {}),
            ...(node.repairOf ? { repairOf: { ...node.repairOf, criterionIds: [...node.repairOf.criterionIds] } } : {}),
          })),
        },
        ...(rootSuccessCriteria ? { rootSuccessCriteria } : {}),
        templates: options.templates,
      })
      return receipt
    } catch (error: unknown) {
      const code = scheduleErrorCode(error)
      throw new ToolExecutionError(code, "TaskGraph proposal could not be durably scheduled", safeScheduleError(error, code))
    }
  }
  return {
    schemaVersion,
    name: "agent.plan",
    version: "1",
    description: `For non-trivial goals, call agent.plan before executing child work. Optional rootSuccessCriteria adds up to four bounded, untrusted acceptance requirements; the server always keeps the complete original human objective as a separate mandatory root criterion. Omitting this field preserves current plan behavior. This context is explanatory only and never proof, permission, or completion authority. Scout and Analyst nodes must include verification {schemaVersion:"${TASK_GRAPH_VERIFICATION_SCHEMA_VERSION}",role,criteria:[{id,check}]}; IDs are stable lowercase identifiers. Allowed checks: candidate_count_gte, finding_count_gte, evidence_count_gte, all_candidates_have_evidence, all_findings_have_evidence, reported_score_gte. Use only checks allowed for that role. A repair uses repairOf={graphRootTaskId,nodeKey,taskId,criterionIds} for a prior typed same-template node, repeats exactly those criteria and checks, and must not add the target to dependsOn; this relation does not pass the target or alter its verdict. successCriteria prose is explanatory and never proof. reported_score_gte checks an Analyst-reported number, not its correctness. Writer and Reviewer nodes use their specialized gates and omit verification and repairOf. Wait for children, inspect their evidence, then replan or complete the goal.\nRegistered templates:\n${templateCatalog}`,
    capabilities: ["coordination"],
    inputSchema: proposalInputSchema(templateIdSchema, templates),
    outputSchema: ReceiptSchema,
    risk: "internal_write",
    domain: "coordination",
    idempotency: "idempotent",
    timeoutMs: 30_000,
    requiredCapabilities: ["coordination", "canManageChildren"],
    execute,
  }
}

export function registerTaskGraphPlanningTool(
  registry: TaskGraphToolRegistry,
  enabled: boolean,
  options: PlanningRegistrationOptions,
): void {
  if (!enabled) return
  if (!options.commandPort || !options.templates || Object.keys(options.templates).length === 0 || !registry.register) throw new Error("task_graph_runtime_dependencies_unavailable")
  registry.register(createTaskGraphPlanningTool({ ...options, commandPort: options.commandPort, templates: options.templates }))
}
