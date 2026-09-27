import { randomUUID } from "node:crypto"
import { appendTaskGraphProposal, TASK_GRAPH_LIMITS, type TaskGraphProposal, type TaskGraphState } from "../planning/task-graph.js"
import { getSubagentRolePolicy } from "./role-policy.js"
import { createSubagentTask } from "./pg-store-create.js"
import { json, type Queryable } from "./pg-store-persistence.js"
import { inheritSubagentPolicy, type SubagentTaskRecord } from "./types.js"
import { policyFromTask } from "./manager-task-scope.js"
import type { TaskGraphScheduleInput, TaskGraphTaskTemplate } from "./task-graph-command-port.js"
import type { GraphParent } from "./task-graph-pg-state.js"
import { taskGraphSnapshot, type TaskGraphSnapshot } from "./task-graph-snapshot.js"
import { materializeTaskGraphDependencyContext, type ScopedDependencyResult } from "./task-graph-dependency-context.js"

const EXTERNAL_ACTION = /(?:^|[._-])(submit|send|publish|delete|mutate|execute)(?:$|[._-])/i

export type CreatedGraphTasks = Readonly<{
  state: TaskGraphState
  snapshot: TaskGraphSnapshot
  taskIds: ReadonlyMap<string, string>
  created: readonly { key: string; taskId: string; status: "queued" | "waiting" }[]
  readyTaskIds: readonly string[]
}>

function safeTemplate(template: TaskGraphTaskTemplate): void {
  if (!getSubagentRolePolicy(template.role) || !Array.isArray(template.allowedActions)
    || template.allowedActions.some(action => typeof action !== "string" || !action.trim() || EXTERNAL_ACTION.test(action))) {
    throw new Error("task_graph_template_policy_rejected")
  }
}

function safeProposalSize(proposal: TaskGraphProposal): void {
  if (Buffer.byteLength(JSON.stringify(proposal), "utf8") > TASK_GRAPH_LIMITS.maxProposalBytes) {
    throw new Error("task_graph_proposal_too_large")
  }
}

export async function createGraphTasks(client: Queryable, input: TaskGraphScheduleInput, parent: GraphParent, current: TaskGraphState, priorTaskIds: ReadonlyMap<string, string>): Promise<CreatedGraphTasks> {
  const parentTask = { budgetSnapshot: parent.budgetSnapshot } as Pick<SubagentTaskRecord, "budgetSnapshot">
  const policy = policyFromTask(parentTask)
  safeProposalSize(input.proposal)
  if (input.proposal.nodes.length > policy.maxFanOut) throw new Error("task_graph_proposal_fan_out_limit")
  for (const template of Object.values(input.templates)) safeTemplate(template)
  const options = {
    registeredTemplateIds: new Set(Object.keys(input.templates)),
    // Lifetime DAG size is independent from the active-child fan-out limit.
    // createSubagentTask enforces fan-out against nonterminal rows on each insert.
    maxNodes: TASK_GRAPH_LIMITS.maxNodes,
    maxDepth: Math.min(TASK_GRAPH_LIMITS.maxDepth, policy.maxDepth),
  }
  const appended = appendTaskGraphProposal(current, input.proposal, options)
  if (!appended.ok) throw Object.assign(new Error(appended.error.message), { code: appended.error.code })
  const existingIds = new Map(priorTaskIds)
  const statuses = new Map(current.nodes.map(node => [node.key, node.status] as const))
  const dependencies = new Map([...current.nodes, ...input.proposal.nodes].map(node => [node.key, node] as const))
  const previewStatuses = new Map(statuses)
  const previewTaskIds = new Map(existingIds)
  input.proposal.nodes.forEach((node, index) => {
    const dependenciesDone = node.dependsOn.every(key => previewStatuses.get(key) === "completed")
    previewStatuses.set(node.key, dependenciesDone ? "queued" : "waiting")
    // Child IDs are generated as `subagent-<UUID>`; fixed-width placeholders
    // let the 40 KB snapshot guard run before any child task is written.
    previewTaskIds.set(node.key, `subagent-${String(index).padStart(36, "0")}`)
  })
  taskGraphSnapshot({
    ...appended.state,
    nodes: appended.state.nodes.map(node => ({ ...node, status: previewStatuses.get(node.key)! })),
  }, previewTaskIds)
  const readyDependencyKeys = new Set(input.proposal.nodes.flatMap(node =>
    previewStatuses.get(node.key) === "queued" ? node.dependsOn : []))
  const dependencyTaskIds = new Map<string, string>()
  for (const key of readyDependencyKeys) {
    const taskId = existingIds.get(key)
    if (!taskId) throw new Error("task_graph_dependency_task_missing")
    dependencyTaskIds.set(key, taskId)
  }
  const completedDependencies = await readCompletedDependencies(client, input.scope, dependencyTaskIds)
  const taskIds = new Map(existingIds)
  const created: Array<{ key: string; taskId: string; status: "queued" | "waiting" }> = []
  const readyTaskIds: string[] = []
  for (const node of input.proposal.nodes) {
    if (node.dependsOn.some(key => hasFailedAncestor(key, dependencies, statuses, new Set()))) throw new Error("task_graph_dependency_blocked")
    const template = input.templates[node.templateId]!
    const dependenciesDone = node.dependsOn.every(key => statuses.get(key) === "completed")
    const status = dependenciesDone ? "queued" : "waiting"
    const childPolicy = inheritSubagentPolicy(policy, template.maxAttempts === undefined ? {} : { maxAttempts: template.maxAttempts })
    const context = status === "queued" && node.dependsOn.length > 0
      ? materializeTaskGraphDependencyContext(template.context ?? {}, input.scope, node.dependsOn,
        node.dependsOn.map(key => completedDependencies.get(key)).filter((value): value is ScopedDependencyResult => value !== undefined))
      : template.context ?? {}
    const child = await createSubagentTask(client, {
      userId: input.scope.userId, sessionId: input.scope.sessionId, turnId: input.scope.turnId,
      parentTaskId: input.scope.parentTaskId, role: template.role, taskType: template.taskType,
      goal: node.goal, constraints: template.constraints ?? [], successCriteria: node.successCriteria,
      allowedActions: template.allowedActions, context,
      expectedOutputSchema: template.expectedOutputSchema ?? {}, policy: childPolicy,
    }, true)
    if (status === "waiting") {
      const updated = await client.query(`UPDATE "sub_agent_tasks" SET "status" = 'waiting', "updatedAt" = CURRENT_TIMESTAMP
        WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "rootTaskId" = $4 AND "parentTaskId" = $5 AND "status" = 'queued'`,
      [child.id, input.scope.sessionId, input.scope.turnId, input.scope.rootTaskId, input.scope.parentTaskId])
      if (updated.rowCount !== 1) throw new Error("task_graph_child_wait_state_failed")
    } else {
      await enqueueGraphTask(client, input.scope.sessionId, child)
      readyTaskIds.push(child.id)
    }
    taskIds.set(node.key, child.id)
    statuses.set(node.key, status)
    created.push({ key: node.key, taskId: child.id, status })
  }
  const state = {
    ...appended.state,
    nodes: appended.state.nodes.map(node => ({ ...node, status: statuses.get(node.key)! })),
  }
  return { state, snapshot: taskGraphSnapshot(state, taskIds), taskIds, created, readyTaskIds }
}

async function readCompletedDependencies(
  client: Queryable,
  scope: TaskGraphScheduleInput["scope"],
  taskIds: ReadonlyMap<string, string>,
): Promise<Map<string, ScopedDependencyResult>> {
  if (taskIds.size === 0) return new Map()
  const result = await client.query(`SELECT task."id", task."status", task."role", task."expectedOutputSchema", task."result",
      session."userId" AS "userId", task."sessionId", task."turnId", task."rootTaskId", task."parentTaskId"
    FROM "sub_agent_tasks" AS task JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
    JOIN "agent_turns" AS turn ON turn."id" = task."turnId" AND turn."sessionId" = task."sessionId"
    WHERE task."id" = ANY($1::text[]) AND task."sessionId" = $2 AND task."turnId" = $3
      AND task."rootTaskId" = $4 AND task."parentTaskId" = $5 AND session."userId" = $6 AND turn."userId" = $6
      AND task."status" = 'completed'`,
  [[...taskIds.values()], scope.sessionId, scope.turnId, scope.rootTaskId, scope.parentTaskId, scope.userId])
  const byId = new Map(result.rows.map(raw => {
    const row = raw as Record<string, unknown>
    return [String(row.id), row] as const
  }))
  const output = new Map<string, ScopedDependencyResult>()
  for (const [key, taskId] of taskIds) {
    const row = byId.get(taskId)
    if (!row) continue
    output.set(key, {
      key, taskId, status: String(row.status), role: String(row.role),
      expectedOutputSchema: row.expectedOutputSchema, result: row.result,
      userId: String(row.userId), sessionId: String(row.sessionId), turnId: String(row.turnId),
      rootTaskId: String(row.rootTaskId), parentTaskId: String(row.parentTaskId),
    })
  }
  return output
}

function hasFailedAncestor(key: string, dependencies: ReadonlyMap<string, { readonly dependsOn: readonly string[] }>, statuses: ReadonlyMap<string, string>, visited: Set<string>): boolean {
  if (visited.has(key)) return false
  visited.add(key)
  const status = statuses.get(key)
  if (status === "failed" || status === "interrupted" || status === "cancelled" || status === "closed") return true
  const node = dependencies.get(key)
  return Boolean(node?.dependsOn.some(dependency => hasFailedAncestor(dependency, dependencies, statuses, visited)))
}

async function enqueueGraphTask(client: Queryable, sessionId: string, task: SubagentTaskRecord): Promise<void> {
  const payload = { taskId: task.id, sessionId, rootTaskId: task.rootTaskId, ownerId: `coordination-${randomUUID()}` }
  const inserted = await client.query(`INSERT INTO "agent_outbox" ("id", "topic", "aggregateId", "idempotencyKey", "payload")
    VALUES ($1, 'agent.subagent.dispatch', $2, $3, $4::jsonb) ON CONFLICT ("idempotencyKey") DO NOTHING`,
  [`subagent-dispatch-${randomUUID()}`, sessionId, `subagent-dispatch:${task.id}`, json(payload, {}, "task_graph_dispatch")])
  if (inserted.rowCount === 0) {
    const existing = await client.query<{ payload: unknown }>(`SELECT "payload" FROM "agent_outbox"
      WHERE "topic" = 'agent.subagent.dispatch' AND "aggregateId" = $1 AND "idempotencyKey" = $2`,
    [sessionId, `subagent-dispatch:${task.id}`])
    const value = existing.rows[0]?.payload as Record<string, unknown> | undefined
    if (value?.taskId !== task.id || value?.sessionId !== sessionId || value?.rootTaskId !== task.rootTaskId) throw new Error("task_graph_dispatch_conflict")
  }
}
