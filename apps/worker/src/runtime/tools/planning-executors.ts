import { Type, type TSchema } from "@sinclair/typebox"
import { schemaVersion } from "@jobcopilot/agent-protocol"
import { redactSensitiveText } from "@jobcopilot/shared"
import { TASK_GRAPH_LIMITS, type TaskGraphNodeProposal, type TaskGraphProposal, type TaskGraphRepairOf } from "../planning/task-graph.js"
import { TASK_GRAPH_VERIFICATION_LIMITS, TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, taskGraphVerificationRole, type TaskGraphVerificationRole } from "../planning/task-graph-verification.js"
import { evaluateTaskGraphObjectiveCoverage } from "../planning/task-graph-objective-coverage.js"
import type { RootTaskVerificationRequirementsResolution } from "../context/root-task-objective.js"
import type {
  TaskGraphCommandPort,
  TaskGraphScheduleReceipt,
  TaskGraphTaskTemplate,
} from "../subagents/task-graph-command-port.js"

import { ToolExecutionError, type RuntimeToolDefinition, type ToolExecutionContext } from "./types.js"
import { createSteeringReconciliationTool, steeringReconciliationOperation, type ReconciliationFenceOptions } from "./steering-reconciliation.js"

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
      Type.Object({
        kind: Type.Literal("findings_from_scout_dependency"),
        dependencyNodeKey: Type.String({ minLength: 1, maxLength: TASK_GRAPH_LIMITS.maxKeyLength }),
      }, { additionalProperties: false }),
      Type.Object({
        kind: Type.Literal("findings_cover_scout_candidates_gte"),
        dependencyNodeKey: Type.String({ minLength: 1, maxLength: TASK_GRAPH_LIMITS.maxKeyLength }),
        minimumPercent: Type.Integer({ minimum: 1, maximum: 100 }),
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
    graphRootTaskId: Type.Optional(Type.String({ minLength: 1, maxLength: TASK_GRAPH_LIMITS.maxKeyLength })),
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
  }, { additionalProperties: false })
}

export const TaskGraphProposalInputSchema = proposalInputSchema(Type.String({ minLength: 1, maxLength: 128 }))

type ModelTaskGraphRepairOf = Omit<TaskGraphRepairOf, "graphRootTaskId"> & Readonly<{ graphRootTaskId?: string }>
type ModelTaskGraphNodeProposal = Omit<TaskGraphNodeProposal, "repairOf"> & Readonly<{ repairOf?: ModelTaskGraphRepairOf }>
export type TaskGraphProposalInput = Omit<TaskGraphProposal, "nodes"> & Readonly<{ nodes: readonly ModelTaskGraphNodeProposal[] }>

export type PlanningExecutorOptions = ReconciliationFenceOptions & Readonly<{
  commandPort: TaskGraphCommandPort
  templates: Readonly<Record<string, TaskGraphTaskTemplate>>
  verificationRequirements?: RootTaskVerificationRequirementsResolution
}>

export type PlanningRegistrationOptions = ReconciliationFenceOptions & Readonly<{
  commandPort?: TaskGraphCommandPort
  templates?: Readonly<Record<string, TaskGraphTaskTemplate>>
  verificationRequirements?: RootTaskVerificationRequirementsResolution
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
  const selectedJobWriterGuidance = templates.some(([id, template]) => id === "cover_letter_writer" && template.role === "writer")
    && templates.some(([id, template]) => id === "cover_letter_reviewer" && template.role === "reviewer")
    ? " Writer and Reviewer nodes use their specialized gates and omit verification and repairOf. For a selected-job cover letter, plan one cover_letter_writer first. If its completed Reviewer dependency reports needs_revision, you may append exactly one cover_letter_writer directly after that Reviewer in a later plan; do not loop or reuse that review for a second successful revision. A fresh review is required after the revision. Root decides whether to plan this follow-up; the Worker does not schedule it automatically."
    : ""
  const execute: RuntimeToolDefinition["execute"] = async (context, value) => {
    const remainingSteps = context.remainingTurnSteps
    if (remainingSteps === undefined || !Number.isSafeInteger(remainingSteps) || remainingSteps < MIN_CONTINUATION_STEPS) {
      // Preserve one root step to establish the durable wait and one to evaluate results after wake.
      const code = "task_graph_continuation_budget_required"
      throw new ToolExecutionError(code, "The Turn needs two remaining steps to supervise a TaskGraph plan", { code, requiredSteps: MIN_CONTINUATION_STEPS })
    }
    const input = value as TaskGraphProposalInput
    const encoded = JSON.stringify(input)
    if (!encoded || Buffer.byteLength(encoded, "utf8") > MAX_PROPOSAL_BYTES) {
      throw new ToolExecutionError("task_graph_proposal_too_large", "TaskGraph proposal exceeds the bounded request size", { code: "task_graph_proposal_too_large", maxBytes: MAX_PROPOSAL_BYTES })
    }
    if (input.nodes.some(node => redactSensitiveText(node.key) !== node.key)) {
      throw new ToolExecutionError("task_graph_sensitive_key_rejected", "TaskGraph keys cannot contain contact or credential data")
    }
    const operation = steeringReconciliationOperation(context, options, "revise", input.expectedRevision)
    const scope = operation.scope
    const proposal: TaskGraphProposal = {
      expectedRevision: input.expectedRevision,
      nodes: input.nodes.map(node => {
        const repairOf = node.repairOf
        if (repairOf?.graphRootTaskId !== undefined && repairOf.graphRootTaskId !== scope.rootTaskId) {
          throw new ToolExecutionError("task_graph_repair_root_mismatch", "The repair target does not belong to the active root task", { code: "task_graph_repair_root_mismatch" })
        }
        return {
          key: node.key, templateId: node.templateId, goal: node.goal,
          successCriteria: [...node.successCriteria], dependsOn: [...node.dependsOn],
          ...(node.verification ? { verification: node.verification } : {}),
          ...(repairOf ? { repairOf: { ...repairOf, graphRootTaskId: scope.rootTaskId, criterionIds: [...repairOf.criterionIds] } } : {}),
        }
      }),
    }
    const coverage = evaluateTaskGraphObjectiveCoverage(options.verificationRequirements ?? { status: "absent" }, proposal, options.templates)
    if (coverage.status === "incomplete") {
      const code = "task_graph_objective_coverage_incomplete"
      throw new ToolExecutionError(code, "TaskGraph plan does not cover the canonical objective requirements", {
        code, requirements: coverage.requirements,
      })
    }
    try {
      if (typeof options.commandPort.appendAndScheduleWithReconciliation !== "function") {
        throw new ToolExecutionError("steering_reconciliation_unavailable", "TaskGraph revision requires an atomic reconciliation-capable port")
      }
      const receipt = await options.commandPort.appendAndScheduleWithReconciliation({
        scope,
        proposal,
        templates: options.templates,
      }, operation)
      return receipt
    } catch (error: unknown) {
      if (error instanceof ToolExecutionError) throw error
      const code = scheduleErrorCode(error)
      throw new ToolExecutionError(code, "TaskGraph proposal could not be durably scheduled", safeScheduleError(error, code))
    }
  }
  return {
    schemaVersion,
    name: "agent.plan",
    version: "1",
    description: `For non-trivial goals, call agent.plan before executing child work. Scout and Analyst nodes must include verification {schemaVersion:"${TASK_GRAPH_VERIFICATION_SCHEMA_VERSION}",role,criteria:[{id,check}]}; IDs are stable lowercase identifiers. Allowed checks: candidate_count_gte, finding_count_gte, evidence_count_gte, all_candidates_have_evidence, all_findings_have_evidence, reported_score_gte, findings_from_scout_dependency, findings_cover_scout_candidates_gte. Use only checks allowed for that role. findings_from_scout_dependency is Analyst-only and names a direct Scout dependency by dependencyNodeKey. findings_cover_scout_candidates_gte is Analyst-only; use it only when the plan explicitly declares a cohort percentage, with a direct Scout dependency and minimumPercent from 1 to 100. Omitting it preserves normal top-N selection; do not infer a percentage or require processing of every candidate. A repair uses repairOf={nodeKey,taskId,criterionIds} for a prior typed same-template node; omit graphRootTaskId because the server binds the active Root. A matching legacy graphRootTaskId is accepted, but a mismatch is rejected. Repeat exactly those criteria and checks, and must not add the target to dependsOn; this relation does not pass the target or alter its verdict. successCriteria prose is explanatory and never proof. reported_score_gte checks an Analyst-reported number, not its correctness.${selectedJobWriterGuidance}\nTaskGraph maxNodes is an eight-node lifetime history cap, separate from active-child concurrency. When present, read the current owner-scoped task_graph_current.nodeCapacity: remaining is total space; ordinaryRemaining is the ordinary-addition budget while reserveActive is true. In a typed graph before its first accepted repair, preserve one global final slot for a valid failed-target criterion repair. A valid proposal containing that repair may use the reserve in any node order but must fit remaining and the hard eight-node cap; the server still validates the exact current failed target and unresolved criteria. An accepted repair relation consumes the reserve even while queued or if it later fails; it does not pass a criterion, make the target successful, or promise another retry. Refresh current state and use remaining honestly; do not spend the reserve with agent.spawn or agent.followup.\nIf agent.plan returns task_graph_repair_conflict, inspect or refresh the current owner-scoped graph. If an overlapping repair is active, wait for it to become terminal and retry only if the criterion remains unresolved and capacity permits; if none is active, correct the rejected batch so each target/criterion has only one proposed attempt, then replan. An active repair is not evidence of success.\nWait for children, inspect their evidence, then replan or complete the goal.\nRegistered templates:\n${templateCatalog}`,
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
  if (typeof options.commandPort.reconcileSteering === "function") {
    registry.register(createSteeringReconciliationTool(options.commandPort, options))
  }
}
