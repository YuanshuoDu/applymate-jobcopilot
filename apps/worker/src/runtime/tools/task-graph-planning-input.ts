import { Type } from "@sinclair/typebox"
import type { TaskGraphNodeProposal, TaskGraphProposal, TaskGraphRepairOf } from "../planning/task-graph.js"
import { TASK_GRAPH_LIMITS } from "../planning/task-graph.js"
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
