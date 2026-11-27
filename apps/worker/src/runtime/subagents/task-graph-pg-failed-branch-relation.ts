import {
  parseTaskGraphFailedBranchRepairRelation as parseSharedFailedBranchRelation,
  TASK_GRAPH_FAILED_BRANCH_REPAIR_RELATION_SCHEMA_VERSION,
} from "@jobcopilot/agent-protocol/task-graph-failed-branch-reconciliation"
import type {
  TaskGraphFailedBranchEventIdentity,
  TaskGraphFailedBranchIdentity,
  TaskGraphFailedBranchRepairRelation,
} from "@jobcopilot/agent-protocol/task-graph-failed-branch-reconciliation"
import type { TaskGraphBranchReplacement } from "../planning/task-graph-branch-replacement.js"
import { taskGraphFingerprint } from "./task-graph-snapshot.js"
import { taskGraphProtocolCodecs } from "./task-graph-receipt-keys.js"

export { TASK_GRAPH_FAILED_BRANCH_REPAIR_RELATION_SCHEMA_VERSION }
export type { TaskGraphFailedBranchEventIdentity, TaskGraphFailedBranchIdentity, TaskGraphFailedBranchRepairRelation }

/** Fingerprint the whole original agent.plan call before any current-graph reads. */
export function taskGraphFailedBranchRepairFingerprint(input: Readonly<{
  expectedRevision: number
  replaceBranch: TaskGraphBranchReplacement
  nodes: readonly unknown[]
  rootSuccessCriteria?: readonly string[]
}>): string {
  return taskGraphFingerprint({ expectedRevision: input.expectedRevision, replaceBranch: input.replaceBranch, nodes: input.nodes,
    ...(input.rootSuccessCriteria === undefined ? {} : { rootSuccessCriteria: input.rootSuccessCriteria }) })
}

/** Keeps the existing Worker import surface while sharing the closed structural parser. */
export function parseTaskGraphFailedBranchRepairRelation(value: unknown): TaskGraphFailedBranchRepairRelation | null {
  return parseSharedFailedBranchRelation(value, taskGraphProtocolCodecs)
}
