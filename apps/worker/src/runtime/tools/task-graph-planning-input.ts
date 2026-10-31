import { Type, type TSchema } from "@sinclair/typebox"
import type { TaskGraphNodeProposal, TaskGraphProposal, TaskGraphRepairOf } from "../planning/task-graph.js"
import { TASK_GRAPH_LIMITS } from "../planning/task-graph.js"
import { TASK_GRAPH_VERIFICATION_LIMITS } from "../planning/task-graph-verification-cross-node.js"
import { TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, taskGraphVerificationRole,
  type TaskGraphVerificationRole } from "../planning/task-graph-verification-contract.js"
import type { TaskGraphTaskTemplate } from "../subagents/task-graph-command-port.js"
import { TaskGraphBranchReplacementInputSchema, parseTaskGraphBranchReplacement, type TaskGraphBranchReplacement } from "../planning/task-graph-branch-replacement.js"
import {
  TaskGraphOperationalFailureReplacementInputSchema,
  parseTaskGraphOperationalFailureReplacement,
  type TaskGraphOperationalFailureReplacement,
} from "../planning/task-graph-operational-failure-replacement.js"

type ModelTaskGraphRepairOf = Omit<TaskGraphRepairOf, "graphRootTaskId"> & Readonly<{ graphRootTaskId?: string }>
export type TaskGraphModelNodeProposal = Omit<TaskGraphNodeProposal, "repairOf"> & Readonly<{ repairOf?: ModelTaskGraphRepairOf }>
export type TaskGraphProposalInput = Omit<TaskGraphProposal, "nodes"> & Readonly<{
  nodes: readonly TaskGraphModelNodeProposal[]
  rootSuccessCriteria?: readonly string[]
  replaceUnstarted?: Readonly<{ nodeKey: string }>
  replaceBranch?: TaskGraphBranchReplacement
  replaceOperationalFailure?: TaskGraphOperationalFailureReplacement
}>

export const TASK_GRAPH_PLANNING_REPLACEMENT_SCHEMA_PROPERTIES = {
  replaceUnstarted: Type.Optional(Type.Object({
    nodeKey: Type.String({ minLength: 1, maxLength: TASK_GRAPH_LIMITS.maxKeyLength }),
  }, { additionalProperties: false })),
  replaceBranch: Type.Optional(TaskGraphBranchReplacementInputSchema),
  replaceOperationalFailure: Type.Optional(TaskGraphOperationalFailureReplacementInputSchema),
}

const DEPENDENCY_SELECTOR_PATTERN = "^\\S(?:[\\s\\S]*\\S)?(?![\\s\\S])"

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
      Type.Object({
        kind: Type.Literal("findings_from_scout_union"),
        dependencyNodeKeys: Type.Array(Type.String({ minLength: 1, maxLength: TASK_GRAPH_LIMITS.maxKeyLength, pattern: DEPENDENCY_SELECTOR_PATTERN }),
          { minItems: 2, maxItems: 8, uniqueItems: true }),
      }, { additionalProperties: false }),
      Type.Object({
        kind: Type.Literal("findings_cover_scout_candidate_union_gte"),
        dependencyNodeKeys: Type.Array(Type.String({ minLength: 1, maxLength: TASK_GRAPH_LIMITS.maxKeyLength, pattern: DEPENDENCY_SELECTOR_PATTERN }),
          { minItems: 2, maxItems: 8, uniqueItems: true }),
        minimumPercent: Type.Integer({ minimum: 1, maximum: 100 }),
      }, { additionalProperties: false }),
      Type.Object({
        kind: Type.Literal("findings_cover_each_scout_candidates_gte"),
        dependencyNodeKeys: Type.Array(Type.String({ minLength: 1, maxLength: TASK_GRAPH_LIMITS.maxKeyLength, pattern: DEPENDENCY_SELECTOR_PATTERN }),
          { minItems: 2, maxItems: 8, uniqueItems: true }),
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

export function buildTaskGraphProposalInputSchema<T extends TSchema>(
  templateIdSchema: T,
  templates?: readonly (readonly [string, TaskGraphTaskTemplate])[],
) {
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
    ...TASK_GRAPH_PLANNING_REPLACEMENT_SCHEMA_PROPERTIES,
  }, { additionalProperties: false })
}

export const TaskGraphProposalInputSchema = buildTaskGraphProposalInputSchema(Type.String({ minLength: 1, maxLength: 128 }))

export type TaskGraphPlanningReplacementModes = Readonly<{
  replaceUnstarted?: Readonly<{ nodeKey: string }>
  replaceBranch?: TaskGraphBranchReplacement
  replaceOperationalFailure?: TaskGraphOperationalFailureReplacement
}>
export type TaskGraphPlanningReplacementModesResult =
  | Readonly<{ ok: true; value: TaskGraphPlanningReplacementModes }>
  | Readonly<{ ok: false; code: string }>

export function normalizeTaskGraphPlanningNodes(nodes: readonly TaskGraphModelNodeProposal[], rootTaskId: string):
  | Readonly<{ ok: true; nodes: readonly TaskGraphNodeProposal[] }>
  | Readonly<{ ok: false }> {
  const normalized: TaskGraphNodeProposal[] = []
  for (const node of nodes) {
    const repairOf = node.repairOf
    if (repairOf?.graphRootTaskId !== undefined && repairOf.graphRootTaskId !== rootTaskId) return { ok: false }
    normalized.push({
      key: node.key, templateId: node.templateId, goal: node.goal,
      successCriteria: [...node.successCriteria], dependsOn: [...node.dependsOn],
      ...(node.verification ? { verification: node.verification } : {}),
      ...(repairOf ? { repairOf: { ...repairOf, graphRootTaskId: rootTaskId, criterionIds: [...repairOf.criterionIds] } } : {}),
    })
  }
  return { ok: true, nodes: normalized }
}

function plainDataRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  try {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return undefined
    const keys = Reflect.ownKeys(value)
    if (keys.some(key => typeof key !== "string")) return undefined
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const record: Record<string, unknown> = Object.create(null) as Record<string, unknown>
    for (const key of keys as string[]) {
      const descriptor = descriptors[key]
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return undefined
      record[key] = descriptor.value
    }
    return record
  } catch { return undefined }
}

/** Keeps the three replacement modes exclusive before any scheduling port is called. */
export function parseTaskGraphPlanningReplacementModes(input: TaskGraphProposalInput): TaskGraphPlanningReplacementModesResult {
  const row = plainDataRecord(input)
  if (!row) return { ok: false, code: "task_graph_replacement_mode_invalid" }
  const replaceUnstarted = row.replaceUnstarted as TaskGraphProposalInput["replaceUnstarted"]
  const replaceBranch = row.replaceBranch as TaskGraphProposalInput["replaceBranch"]
  const replaceOperationalFailure = row.replaceOperationalFailure as TaskGraphProposalInput["replaceOperationalFailure"]
  const nodes = Array.isArray(row.nodes) ? row.nodes as TaskGraphProposalInput["nodes"] : []
  const present = [replaceUnstarted !== undefined, replaceBranch !== undefined,
    replaceOperationalFailure !== undefined].filter(Boolean).length
  if (present > 1) return { ok: false, code: "task_graph_replacement_modes_conflict" }
  if (replaceUnstarted !== undefined) {
    const mode = plainDataRecord(replaceUnstarted)
    if (!mode || Object.keys(mode).sort().join(",") !== "nodeKey" || typeof mode.nodeKey !== "string"
      || mode.nodeKey.trim() !== mode.nodeKey || mode.nodeKey.length < 1 || mode.nodeKey.length > TASK_GRAPH_LIMITS.maxKeyLength) {
      return { ok: false, code: "task_graph_replacement_mode_invalid" }
    }
    if (nodes.length !== 1) return { ok: false, code: "task_graph_supersession_requires_one_replacement" }
    return { ok: true, value: { replaceUnstarted: { nodeKey: mode.nodeKey } } }
  }
  if (replaceBranch !== undefined) {
    const parsed = parseTaskGraphBranchReplacement(replaceBranch, nodes)
    return parsed.ok ? { ok: true, value: { replaceBranch: parsed.value } } : parsed
  }
  if (replaceOperationalFailure !== undefined) {
    const parsed = parseTaskGraphOperationalFailureReplacement(replaceOperationalFailure, nodes)
    return parsed.ok ? { ok: true, value: { replaceOperationalFailure: parsed.value } } : parsed
  }
  return { ok: true, value: {} }
}
