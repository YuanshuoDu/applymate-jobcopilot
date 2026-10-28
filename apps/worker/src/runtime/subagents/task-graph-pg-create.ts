import { randomUUID } from "node:crypto"
import { appendTaskGraphProposal, TASK_GRAPH_LIMITS, type TaskGraphNodeProposal, type TaskGraphProposal, type TaskGraphState } from "../planning/task-graph.js"
import { taskGraphCreateCapacityAllowed, type OperationalFailureCapacityReuse } from "./task-graph-pg-create-capacity.js"
import { hasOverlappingTaskGraphRepair } from "./task-graph-repair-conflicts.js"
import { APPLICATION_FILLER_TEMPLATE_ID, isApplicationFillerTemplate, isHarnessSubagentRole } from "./role-policy.js"
import { createSubagentTask } from "./pg-store-create.js"
import { json, type Queryable } from "./pg-store-persistence.js"
import { inheritSubagentPolicy, type SubagentTaskRecord } from "./types.js"
import { policyFromTask } from "./manager-task-scope.js"
import type { TaskGraphScheduleInput, TaskGraphTaskTemplate } from "./task-graph-command-port.js"
import type { GraphParent, LoadedGraph } from "./task-graph-pg-state.js"
import { taskGraphSnapshot, type TaskGraphSnapshot } from "./task-graph-snapshot.js"
import { materializeTaskGraphDependencyContext, type ScopedDependencyResult } from "./task-graph-dependency-context.js"
import { validateTaskGraphRepairTargets } from "./task-graph-pg-create-repair-validation.js"
import { loadTaskGraphDependencyResults } from "./task-graph-pg-dependency-context-loader.js"
import { evaluateTaskGraphObjectiveCoverage } from "../planning/task-graph-objective-coverage.js"
import { isScheduledDraftTemplate, scheduledDraftPair, scheduledDraftTaskContext, selectVerifiedScheduledDraftCandidate, type ScheduledDraftCandidateBinding } from "./scheduled-draft-candidate.js"
import { sourceIntentForTaskGraphNode } from "./task-graph-source-intent-context.js"
import { scheduledScoutPlanCapacityAllowed } from "./scheduled-taskgraph-plan-capacity.js"

const EXTERNAL_ACTION = /(?:^|[._-])(submit|send|publish|delete|mutate|execute)(?:$|[._-])/i

export type CreatedGraphTasks = Readonly<{
  state: TaskGraphState
  snapshot: TaskGraphSnapshot
  taskIds: ReadonlyMap<string, string>
  created: readonly { key: string; taskId: string; status: "queued" | "waiting" }[]
  readyTaskIds: readonly string[]
}>

function safeTemplate(templateId: string, template: TaskGraphTaskTemplate): void {
  const applicationFiller = isApplicationFillerTemplate(templateId, template.role, template.taskType)
  if ((!applicationFiller && (!isHarnessSubagentRole(template.role) || templateId === APPLICATION_FILLER_TEMPLATE_ID)) || !Array.isArray(template.allowedActions)
    || applicationFiller && template.allowedActions.length !== 0 || template.allowedActions.some(action => typeof action !== "string" || !action.trim() || EXTERNAL_ACTION.test(action))) {
    throw new Error("task_graph_template_policy_rejected")
  }
}

function safeProposalSize(proposal: TaskGraphProposal): void {
  if (Buffer.byteLength(JSON.stringify(proposal), "utf8") > TASK_GRAPH_LIMITS.maxProposalBytes) throw new Error("task_graph_proposal_too_large")
}

function assertWriterReviewPlan(nodes: readonly TaskGraphNodeProposal[]): void {
  const byKey = new Map(nodes.map(node => [node.key, node] as const))
  const usedReviewers = new Set<string>()
  for (const writer of nodes) {
    if (writer.templateId !== "cover_letter_writer") continue
    const reviewers = writer.dependsOn.filter(key => byKey.get(key)?.templateId === "cover_letter_reviewer")
    if (reviewers.length > 1 || reviewers.some(key => usedReviewers.has(key))) {
      throw Object.assign(new Error("Selected-job Writer and Reviewer dependencies conflict"), { code: "task_graph_writer_review_conflict" })
    }
    reviewers.forEach(key => usedReviewers.add(key))
  }
}

export async function createGraphTasks(
  client: Queryable, input: TaskGraphScheduleInput, parent: GraphParent, current: TaskGraphState,
  priorTaskIds: ReadonlyMap<string, string>, provenance?: Pick<LoadedGraph, "sourceInputCheckpointByNodeKey" | "currentInputCheckpoint">,
  operationalFailureReuse?: OperationalFailureCapacityReuse,
): Promise<CreatedGraphTasks> {
  const parentTask = { budgetSnapshot: parent.budgetSnapshot } as Pick<SubagentTaskRecord, "budgetSnapshot">
  const policy = policyFromTask(parentTask)
  safeProposalSize(input.proposal)
  if (input.proposal.nodes.length > policy.maxFanOut) throw new Error("task_graph_proposal_fan_out_limit")
  for (const [id, template] of Object.entries(input.templates)) safeTemplate(id, template)
  const applicationFillerCount = current.nodes.filter(node => node.templateId === APPLICATION_FILLER_TEMPLATE_ID).length + input.proposal.nodes.filter(node => node.templateId === APPLICATION_FILLER_TEMPLATE_ID).length
  if (applicationFillerCount > 1) throw Object.assign(new Error("TaskGraph Turn may contain at most one application filler"), { code: "task_graph_application_filler_limit" })
  const options = {
    registeredTemplateIds: new Set(Object.keys(input.templates)),
    // Lifetime DAG size is independent from the active-child fan-out limit.
    // createSubagentTask enforces fan-out against nonterminal rows on each insert.
    maxNodes: TASK_GRAPH_LIMITS.maxNodes,
    maxDepth: Math.min(TASK_GRAPH_LIMITS.maxDepth, policy.maxDepth),
  }
  const appended = appendTaskGraphProposal(current, input.proposal, options)
  if (!appended.ok) throw Object.assign(new Error(appended.error.message), { code: appended.error.code })
  if (!await scheduledScoutPlanCapacityAllowed(client, input.scope, appended.state.nodes)) {
    throw Object.assign(new Error("TaskGraph node limit exceeded"), { code: "node_limit" })
  }
  assertWriterReviewPlan([...current.nodes, ...appended.addedNodes])
  const scheduled = isScheduledDraftTemplate(input.templates)
  const draftPair = scheduled ? scheduledDraftPair([...current.nodes, ...appended.addedNodes], new Set(current.nodes.map(node => node.key))) : undefined
  if (scheduled && input.proposal.nodes.some(node => node.templateId === APPLICATION_FILLER_TEMPLATE_ID)) {
    throw Object.assign(new Error("Scheduled draft Turns cannot create an application filler"), { code: "task_graph_scheduled_application_filler_rejected" })
  }
  if (hasOverlappingTaskGraphRepair(current.nodes, appended.addedNodes)) throw Object.assign(new Error("Overlapping TaskGraph repair"), { code: "task_graph_repair_conflict" })
  if (!taskGraphCreateCapacityAllowed({ nodeCount: current.nodes.length, proposalCount: input.proposal.nodes.length,
    hasTypedVerification: appended.state.nodes.some(node => (node.verification?.criteria.length ?? 0) > 0),
    repairRecorded: appended.state.nodes.some(node => node.repairOf !== undefined), operationalFailureReuse })) {
    throw Object.assign(new Error("TaskGraph node limit exceeded"), { code: "node_limit" })
  }
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
  const logicalStatuses = new Map(statuses)
  for (const key of current.repairSatisfiedNodeKeys ?? []) logicalStatuses.set(key, "completed")
  const dependencies = new Map([...current.nodes, ...input.proposal.nodes].map(node => [node.key, node] as const))
  const preflightStatuses = new Map(statuses)
  input.proposal.nodes.forEach((node, index) => {
    const status = node.dependsOn.every(key => isPreflightDependency(key, logicalStatuses, dispositions, current.repairSatisfiedNodeKeys)) ? "queued" : "waiting"
    preflightStatuses.set(node.key, status); logicalStatuses.set(node.key, status)
  })
  await validateTaskGraphRepairTargets(client, input, current, priorTaskIds)
  const coverage = evaluateTaskGraphObjectiveCoverage(input.verificationRequirements ?? { status: "absent" }, appended.state.nodes, input.templates, input.scope.rootTaskId)
  if (coverage.status === "incomplete") throw Object.assign(new Error("TaskGraph plan does not cover the canonical objective requirements"), {
    code: "task_graph_objective_coverage_incomplete", requirements: coverage.requirements,
  })
  const readyDependencyKeys = [...new Set(input.proposal.nodes.flatMap(node => preflightStatuses.get(node.key) === "queued" ? node.dependsOn : []))]
  const dependencyResults = await loadTaskGraphDependencyResults(client, input.scope, readyDependencyKeys, snapshot.nodes)
  const sourceNodes = new Map(current.nodes.map(node => [node.key, node] as const))
  const completedDependencies = new Map(dependencyResults.map(item => {
    const sourceNode = sourceNodes.get(item.key)
    const sourceIntent = provenance && sourceNode ? sourceIntentForTaskGraphNode(sourceNode,
      provenance?.sourceInputCheckpointByNodeKey?.get(item.key), provenance?.currentInputCheckpoint) : undefined
    return [item.key, sourceIntent ? { ...item, sourceIntent } : item] as const
  }))
  let scheduledBinding: ScheduledDraftCandidateBinding | undefined
  if (draftPair) {
    const statusByKey = preflightStatuses
    const analystKeys = snapshot.nodes.filter(node => node.templateId === "analyst" && node.verificationDisposition === "typed" && statusByKey.get(node.key) === "completed").map(node => node.key)
    const selected = await selectVerifiedScheduledDraftCandidate(client, input.scope, snapshot, appended.state.revision, analystKeys, statusByKey,
      appended.addedNodes.filter(node => node.templateId !== "cover_letter_writer" && node.templateId !== "cover_letter_reviewer").map(node => node.key))
    if (!selected) throw Object.assign(new Error("No currently verified Analyst finding can be drafted"), { code: "task_graph_scheduled_draft_candidate_missing" })
    if (selected.sourceAnalystKeys.some(key => !draftPair.writer.dependsOn.includes(key))) throw Object.assign(new Error("Scheduled Writer omitted the source of the highest-scoring finding"), { code: "task_graph_scheduled_draft_candidate_dependency_missing" })
    scheduledBinding = { candidate: selected.candidate, witness: selected.witness }
  }
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
    const candidateContext = scheduled && (node.templateId === "cover_letter_writer" || node.templateId === "cover_letter_reviewer")
      ? scheduledDraftTaskContext(template, scheduledBinding) : template.context ?? {}
    const dependencyResults = node.dependsOn.map(key => completedDependencies.get(key))
      .filter((value): value is ScopedDependencyResult => value !== undefined)
    const contextDependencies = template.role === "analyst" ? dependencyResults
      : dependencyResults.map(({ sourceIntent: _sourceIntent, ...dependency }) => dependency)
    const context = status === "queued" && node.dependsOn.length > 0
      ? materializeTaskGraphDependencyContext(candidateContext, input.scope, node.dependsOn, contextDependencies)
      : candidateContext
    const child = await createSubagentTask(client, {
      userId: input.scope.userId, sessionId: input.scope.sessionId, turnId: input.scope.turnId,
      parentTaskId: input.scope.parentTaskId, role: template.role, taskType: template.taskType,
      goal: node.goal, constraints: template.constraints ?? [], successCriteria: node.successCriteria,
      allowedActions: template.allowedActions, context,
      expectedOutputSchema: template.expectedOutputSchema ?? {}, policy: childPolicy,
    }, true, {
      preserveEmptyAllowedActions: isApplicationFillerTemplate(node.templateId, template.role, template.taskType),
      taskGraphChildDeadline: true,
    })
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
