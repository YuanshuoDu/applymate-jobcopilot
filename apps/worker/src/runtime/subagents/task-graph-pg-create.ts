import { randomUUID } from "node:crypto"
import { appendTaskGraphProposal, TASK_GRAPH_LIMITS, type TaskGraphProposal, type TaskGraphState } from "../planning/task-graph.js"
import { getSubagentRolePolicy } from "./role-policy.js"
import { createSubagentTask } from "./pg-store-create.js"
import { json, type Queryable } from "./pg-store-persistence.js"
import { inheritSubagentPolicy, type SubagentTaskRecord } from "./types.js"
import { policyFromTask } from "./manager-task-scope.js"
import type { TaskGraphScheduleInput, TaskGraphTaskTemplate } from "./task-graph-command-port.js"
import type { GraphParent } from "./task-graph-pg-state.js"
import { canonicalTaskGraphJson, parseTaskGraphSnapshot, taskGraphItemId, taskGraphSnapshot, type TaskGraphSnapshot } from "./task-graph-snapshot.js"
import { materializeTaskGraphDependencyContext, type ScopedDependencyResult } from "./task-graph-dependency-context.js"
import { parseTaskGraphRepairReceipt, parseTaskGraphVerificationReport, taskGraphVerificationReportMatchesStatus } from "./task-graph-command-port.js"
import { loadTaskGraphDependencyResults } from "./task-graph-pg-dependency-context-loader.js"
import type { TaskGraphInputRelation } from "./task-graph-source-intent-context.js"

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

export async function createGraphTasks(client: Queryable, input: TaskGraphScheduleInput, parent: GraphParent, current: TaskGraphState, priorTaskIds: ReadonlyMap<string, string>, sourceInputRelations: ReadonlyMap<string, TaskGraphInputRelation> = new Map()): Promise<CreatedGraphTasks> {
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
  const previewTaskIds = new Map(existingIds)
  input.proposal.nodes.forEach((node, index) => previewTaskIds.set(node.key, `subagent-${String(index).padStart(36, "0")}`))
  const snapshot = taskGraphSnapshot(appended.state, previewTaskIds)
  const dispositions = new Map(snapshot.nodes.map(node => [node.key, node.verificationDisposition] as const))
  const completedLegacyDependencies = new Set(current.nodes.filter(node => node.status === "completed"
    && dispositions.get(node.key) === "legacy_unverified").map(node => node.key))
  const unverifiedAncestors = new Set(completedLegacyDependencies)
  let propagated = true
  while (propagated) {
    propagated = false
    for (const node of [...current.nodes, ...input.proposal.nodes]) if (dispositions.get(node.key) === "typed" && !unverifiedAncestors.has(node.key)
      && node.dependsOn.some(key => unverifiedAncestors.has(key))) {
      unverifiedAncestors.add(node.key)
      propagated = true
    }
  }
  if (input.proposal.nodes.some(node => unverifiedAncestors.has(node.key))) {
    throw new Error("task_graph_dependency_unverified")
  }
  const statuses = new Map(current.nodes.map(node => [node.key, node.status] as const))
  const currentNodesByKey = new Map(current.nodes.map(node => [node.key, node] as const))
  const logicalStatuses = new Map(statuses)
  for (const key of current.repairSatisfiedNodeKeys ?? []) logicalStatuses.set(key, "completed")
  const dependencies = new Map([...current.nodes, ...input.proposal.nodes].map(node => [node.key, node] as const))
  const preflightStatuses = new Map(statuses)
  input.proposal.nodes.forEach((node, index) => {
    const status = node.dependsOn.every(key => isPreflightDependency(key, logicalStatuses, dispositions, current.repairSatisfiedNodeKeys)) ? "queued" : "waiting"
    preflightStatuses.set(node.key, status); logicalStatuses.set(node.key, status)
  })
  await validateRepairTargets(client, input, current, priorTaskIds)
  const readyDependencyKeys = [...new Set(input.proposal.nodes.flatMap(node => preflightStatuses.get(node.key) === "queued" ? node.dependsOn : []))]
  const completedDependencies = new Map((await loadTaskGraphDependencyResults(client, input.scope, readyDependencyKeys, snapshot.nodes)).map(item => [item.key, item] as const))
  const satisfiedDependencies = new Set<string>()
  for (const [key, dependency] of completedDependencies) {
    if (current.repairSatisfiedNodeKeys?.includes(key)) {
      if (dependency.repairComposite === true) satisfiedDependencies.add(key)
    } else if (dependency.status === "completed" && !dependency.failureReason
      && dependency.verificationDisposition !== "legacy_unverified") satisfiedDependencies.add(key)
  }
  const taskIds = new Map(existingIds)
  const created: Array<{ key: string; taskId: string; status: "queued" | "waiting" }> = []
  const readyTaskIds: string[] = []
  logicalStatuses.clear()
  for (const [key, status] of statuses) logicalStatuses.set(key, status)
  for (const key of satisfiedDependencies) logicalStatuses.set(key, "completed")
  for (const node of input.proposal.nodes) {
    if (node.dependsOn.some(key => hasFailedAncestor(key, dependencies, logicalStatuses, new Set()))) throw new Error("task_graph_dependency_blocked")
    const template = input.templates[node.templateId]!
    const dependenciesDone = node.dependsOn.every(key => satisfiedDependencies.has(key))
    const status = dependenciesDone ? "queued" : "waiting"
    const childPolicy = inheritSubagentPolicy(policy, template.maxAttempts === undefined ? {} : { maxAttempts: template.maxAttempts })
    const dependencyResults = node.dependsOn.map(key => {
      const dependency = completedDependencies.get(key), source = currentNodesByKey.get(key)
      if (!dependency || template.role !== "analyst" || dependency.verificationDisposition !== "typed"
        || !source || priorTaskIds.get(key) !== dependency.taskId || source.verificationDisposition !== "typed") return dependency
      return { ...dependency, sourceIntent: {
        goal: source.goal, successCriteria: source.successCriteria, inputRelation: sourceInputRelations.get(key) ?? "unknown",
      } }
    }).filter((dependency): dependency is ScopedDependencyResult => dependency !== undefined)
    const context = status === "queued" && node.dependsOn.length > 0
      ? materializeTaskGraphDependencyContext(template.context ?? {}, input.scope, node.dependsOn,
        dependencyResults)
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
    logicalStatuses.set(node.key, status)
    statuses.set(node.key, status)
    created.push({ key: node.key, taskId: child.id, status })
  }
  const state = {
    ...appended.state,
    nodes: appended.state.nodes.map(node => ({ ...node, status: statuses.get(node.key)! })),
  }
  return { state, snapshot: taskGraphSnapshot(state, taskIds), taskIds, created, readyTaskIds }
}

function isPreflightDependency(
  key: string,
  statuses: ReadonlyMap<string, string>,
  dispositions: ReadonlyMap<string, TaskGraphSnapshot["nodes"][number]["verificationDisposition"]>,
  repairSatisfied?: readonly string[],
): boolean {
  return repairSatisfied?.includes(key) === true
    || statuses.get(key) === "completed" && dispositions.get(key) !== "legacy_unverified"
}

async function validateRepairTargets(client: Queryable, input: TaskGraphScheduleInput, current: TaskGraphState, priorTaskIds: ReadonlyMap<string, string>): Promise<void> {
  const proposals = input.proposal.nodes.filter(node => node.repairOf)
  if (!proposals.length) return
  const scope = input.scope
  const stored = await client.query(`SELECT item."content" FROM "agent_items" AS item
    JOIN "agent_sessions" AS session ON session."id" = item."sessionId"
    JOIN "agent_turns" AS turn ON turn."id" = item."turnId" AND turn."sessionId" = item."sessionId"
    WHERE item."id" = $1 AND item."sessionId" = $2 AND item."turnId" = $3 AND item."taskId" = $4
      AND item."type" = 'task_graph' AND session."userId" = $5 AND turn."userId" = $5 FOR UPDATE OF item`,
  [taskGraphItemId(scope.parentTaskId), scope.sessionId, scope.turnId, scope.parentTaskId, scope.userId])
  const snapshot = stored.rows[0] ? parseTaskGraphSnapshot((stored.rows[0] as Record<string, unknown>).content) : undefined
  if (!snapshot || canonicalTaskGraphJson(snapshot) !== canonicalTaskGraphJson(taskGraphSnapshot(current, priorTaskIds))) throw new Error("task_graph_repair_snapshot_invalid")
  for (const proposal of proposals) {
    const relation = proposal.repairOf!
    const target = snapshot.nodes.find(node => node.key === relation.nodeKey)
    const ids = target?.verification?.criteria.map(item => item.id) ?? []
    if (relation.graphRootTaskId !== scope.rootTaskId || !target || target.taskId !== relation.taskId
      || target.verificationDisposition !== "typed" || !target.verification || !ids.length) throw new Error("task_graph_repair_target_unresolved")
    const result = await client.query(`SELECT task."id", task."status", task."role", task."failureReason", task."result",
        task."rootTaskId", task."parentTaskId", task."sessionId", task."turnId"
      FROM "sub_agent_tasks" AS task JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
      JOIN "agent_turns" AS turn ON turn."id" = task."turnId" AND turn."sessionId" = task."sessionId"
      WHERE task."id" = $1 AND task."sessionId" = $2 AND task."turnId" = $3 AND task."rootTaskId" = $4
        AND task."parentTaskId" = $5 AND session."userId" = $6 AND turn."userId" = $6 FOR UPDATE OF task`,
    [target.taskId, scope.sessionId, scope.turnId, scope.rootTaskId, scope.parentTaskId, scope.userId])
    const row = result.rows[0] as Record<string, unknown> | undefined
    const report = parseTaskGraphVerificationReport(object(row?.result)?.taskGraphVerificationReport, ids)
    if (!row || row.id !== relation.taskId || row.status !== "failed" || row.role !== input.templates[proposal.templateId]?.role
      || row.rootTaskId !== scope.rootTaskId || row.parentTaskId !== scope.parentTaskId || row.sessionId !== scope.sessionId
      || row.turnId !== scope.turnId || !report || !taskGraphVerificationReportMatchesStatus(report, "failed")
      || row.failureReason !== `task_graph_verification_${report.status}`) throw new Error("task_graph_repair_target_unresolved")
    const statuses = new Map(report.criteria.map(item => [item.criterionId, item.status] as const))
    if (!relation.criterionIds.every(id => statuses.get(id) === "failed" || statuses.get(id) === "unverified")) throw new Error("task_graph_repair_criteria_resolved")
    const priorRepairs = snapshot.nodes.filter(node => node.repairOf?.graphRootTaskId === relation.graphRootTaskId
      && node.repairOf.nodeKey === relation.nodeKey && node.repairOf.taskId === relation.taskId)
    if (priorRepairs.length && await hasResolvingRepairReceipt(client, scope, priorRepairs, relation.criterionIds)) {
      throw new Error("task_graph_repair_criteria_resolved")
    }
  }
}

async function hasResolvingRepairReceipt(
  client: Queryable, scope: TaskGraphScheduleInput["scope"], repairs: TaskGraphSnapshot["nodes"], criterionIds: readonly string[],
): Promise<boolean> {
  const result = await client.query(`SELECT task."id", task."status", task."result" FROM "sub_agent_tasks" AS task
    JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
    JOIN "agent_turns" AS turn ON turn."id" = task."turnId" AND turn."sessionId" = task."sessionId"
    WHERE task."id" = ANY($1::text[]) AND task."sessionId" = $2 AND task."turnId" = $3
      AND task."rootTaskId" = $4 AND task."parentTaskId" = $5 AND session."userId" = $6 AND turn."userId" = $6`,
  [repairs.map(node => node.taskId), scope.sessionId, scope.turnId, scope.rootTaskId, scope.parentTaskId, scope.userId])
  const byId = new Map(result.rows.map(value => { const row = value as Record<string, unknown>; return [String(row.id), row] as const }))
  if (byId.size !== repairs.length) throw new Error("task_graph_repair_target_scope_invalid")
  for (const repair of repairs) {
    const row = byId.get(repair.taskId)!, ids = repair.verification?.criteria.map(item => item.id) ?? []
    const resultValue = object(row.result)
    const report = parseTaskGraphVerificationReport(resultValue?.taskGraphVerificationReport, ids)
    const receipt = parseTaskGraphRepairReceipt(resultValue?.taskGraphRepairReceipt, {
      repairOf: repair.repairOf, repairNodeKey: repair.key, repairTaskId: repair.taskId, report,
    })
    if (row.status === "completed" && report?.status === "passed" && taskGraphVerificationReportMatchesStatus(report, "completed")
      && receipt?.criterionIds.some(id => criterionIds.includes(id))) return true
  }
  return false
}

function object(value: unknown): Record<string, unknown> | null {
  const parsed = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown } catch { return null } })() : value
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null
}

function hasFailedAncestor(key: string, dependencies: ReadonlyMap<string, { readonly dependsOn: readonly string[] }>, statuses: ReadonlyMap<string, string>, visited: Set<string>): boolean {
  if (visited.has(key)) return false
  visited.add(key)
  const status = statuses.get(key)
  if (status === "failed" || status === "interrupted" || status === "cancelled" || status === "closed") return true
  const node = dependencies.get(key)
  return Boolean(node?.dependsOn.some(dependency => hasFailedAncestor(dependency, dependencies, statuses, visited)))
}

export async function enqueueGraphTask(client: Queryable, sessionId: string, task: SubagentTaskRecord): Promise<void> {
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
