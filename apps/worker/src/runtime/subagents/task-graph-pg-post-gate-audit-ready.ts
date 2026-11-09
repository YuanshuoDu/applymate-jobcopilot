import type { TaskGraphReadScope } from "./task-graph-command-port.js"
import { materializeTaskGraphDependencyContext } from "./task-graph-dependency-context.js"
import { loadScopedTaskGraphDependencyContext } from "./task-graph-pg-dependency-context-loader.js"
import type { Queryable } from "./pg-store-persistence.js"
import { readScheduledPostGateReceipt, validateScheduledPostGateHandoff } from "./scheduled-post-gate-handoff.js"
import {
  SCHEDULED_POST_GATE_AUDIT_CRITERIA, SCHEDULED_POST_GATE_AUDIT_GOAL, SCHEDULED_POST_GATE_AUDIT_OUTPUT_SCHEMA,
  SCHEDULED_POST_GATE_AUDIT_ROLE, SCHEDULED_POST_GATE_AUDIT_TASK_TYPE, SCHEDULED_POST_GATE_AUDIT_TEMPLATE_ID,
  SCHEDULED_POST_GATE_EXECUTE_TEMPLATE_ID, scheduledPostGateScopeMatchesOwner,
} from "./scheduled-post-gate-contract.js"
import { isScheduledTaskGraphSpecializedEnvelope } from "./task-graph-pg-specialized-envelope.js"
import type { GraphIdentityScope, GraphTaskRow, LoadedGraph } from "./task-graph-pg-state.js"
import { sourceIntentForTaskGraphNode } from "./task-graph-source-intent-context.js"
import { canonicalTaskGraphJson } from "./task-graph-snapshot.js"

type Node = NonNullable<LoadedGraph["snapshot"]>["nodes"][number]

/** Resolve normal dependency context, bypassing StructuredRole only for the immutable server-owned Post-Gate Audit. */
export async function readyTaskDependencyContext(
  client: Queryable, scope: GraphIdentityScope, loaded: LoadedGraph, node: Node, row: GraphTaskRow,
): Promise<unknown> {
  if (!loaded.snapshot) throw new Error("task_graph_state_missing")
  if (await isServerOwnedPostGateAuditReady(client, scope, loaded, node, row)) return {}

  const contextRows = await loadScopedTaskGraphDependencyContext(client, scope, row.id, node.dependsOn, loaded.snapshot.nodes)
  const nodesByKey = new Map(loaded.snapshot.nodes.map(candidate => [candidate.key, candidate] as const))
  const dependencies = row.role === "analyst" ? contextRows.dependencies.map(dependency => {
    const sourceNode = nodesByKey.get(dependency.key)
    if (!sourceNode || !node.dependsOn.includes(sourceNode.key) || sourceNode.taskId !== dependency.taskId) return dependency
    const sourceIntent = sourceIntentForTaskGraphNode(sourceNode,
      loaded.sourceInputCheckpointByNodeKey?.get(sourceNode.key), loaded.currentInputCheckpoint)
    return sourceIntent ? { ...dependency, sourceIntent } : dependency
  }) : contextRows.dependencies
  return materializeTaskGraphDependencyContext(contextRows.childContext, scope, node.dependsOn, dependencies)
}

async function isServerOwnedPostGateAuditReady(
  client: Queryable, scope: GraphIdentityScope, loaded: LoadedGraph, node: Node, row: GraphTaskRow,
): Promise<boolean> {
  const snapshot = loaded.snapshot
  if (!snapshot || loaded.discoveryTurnEligibility !== "scheduled" || !exactAuditNode(node, row)) return false
  const executeNodes = snapshot.nodes.filter(candidate => candidate.templateId === SCHEDULED_POST_GATE_EXECUTE_TEMPLATE_ID)
  if (executeNodes.length < 1 || executeNodes.length > 3 || !sameUniqueStringSet(node.dependsOn, executeNodes.map(item => item.key))) return false
  const receipt = await readScheduledPostGateReceipt(client, scope)
  if (!receipt || receipt.auditTaskId !== node.taskId
    || !sameUniqueStringSet(receipt.executeNodes.map(item => item.key), executeNodes.map(item => item.key))
    || !sameUniqueStringSet(receipt.executeNodes.map(item => item.taskId), executeNodes.map(item => item.taskId))) return false
  for (const executeNode of executeNodes) {
    const reference = receipt.executeNodes.find(candidate => candidate.key === executeNode.key)
    const task = loaded.tasks.get(executeNode.taskId)
    if (!reference || reference.taskId !== executeNode.taskId || !sameJson(reference.packageRefs, executeNode.packageRefs)
      || !task || task.status !== "completed"
      || isScheduledTaskGraphSpecializedEnvelope({ snapshot, tasks: loaded.tasks, node: executeNode, task }) !== "execute") return false
  }

  const parent = await client.query(`SELECT task."attemptCount", task."leaseOwner" AS "parentLeaseOwner",
      turn."leaseOwnerId" AS "turnLeaseOwner", turn."leaseVersion" AS "turnLeaseVersion"
    FROM "sub_agent_tasks" AS task
    JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
    JOIN "agent_turns" AS turn ON turn."id" = task."turnId" AND turn."sessionId" = task."sessionId"
    WHERE task."id" = $1 AND task."sessionId" = $2 AND task."turnId" = $3
      AND task."rootTaskId" = $4 AND task."parentTaskId" IS NULL
      AND task."role" = 'orchestrator' AND task."taskType" = 'root'
      AND session."userId" = $5 AND turn."userId" = $5`,
  [scope.parentTaskId, scope.sessionId, scope.turnId, scope.rootTaskId, scope.userId])
  const owner = parent.rows[0] as Record<string, unknown> | undefined
  if (!owner || !positive(owner.attemptCount) || typeof owner.turnLeaseOwner !== "string"
    || !owner.turnLeaseOwner.trim() || !positive(owner.turnLeaseVersion)) return false
  const validationScope: TaskGraphReadScope = {
    ...scope, parentAttemptCount: Number(owner.attemptCount),
    parentLeaseOwner: typeof owner.parentLeaseOwner === "string" ? owner.parentLeaseOwner : "",
    turnLeaseOwner: owner.turnLeaseOwner, turnLeaseVersion: Number(owner.turnLeaseVersion),
  }
  if (!scheduledPostGateScopeMatchesOwner(validationScope, receipt.owner)) return false
  return validateScheduledPostGateHandoff(client, validationScope, loaded, receipt)
}

function exactAuditNode(node: Node, task: GraphTaskRow): boolean {
  return node.key === SCHEDULED_POST_GATE_AUDIT_TEMPLATE_ID && node.templateId === SCHEDULED_POST_GATE_AUDIT_TEMPLATE_ID
    && node.depth === 6 && node.verificationDisposition === "specialized" && node.verification === undefined
    && node.goal === SCHEDULED_POST_GATE_AUDIT_GOAL && sameJson(node.successCriteria, SCHEDULED_POST_GATE_AUDIT_CRITERIA)
    && task.id === node.taskId && task.status === "waiting" && task.failureReason === null
    && task.role === SCHEDULED_POST_GATE_AUDIT_ROLE && task.taskType === SCHEDULED_POST_GATE_AUDIT_TASK_TYPE
    && sameJson(task.expectedOutputSchema, SCHEDULED_POST_GATE_AUDIT_OUTPUT_SCHEMA) && sameJson(task.allowedActions, [])
    && task.contextIsEmpty === true
}

function sameJson(left: unknown, right: unknown): boolean {
  try { return canonicalTaskGraphJson(left) === canonicalTaskGraphJson(right) } catch { return false }
}
function sameUniqueStringSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && new Set(left).size === left.length && new Set(right).size === right.length
    && left.every(value => right.includes(value))
}
function positive(value: unknown): boolean { return Number.isSafeInteger(value) && Number(value) > 0 }
