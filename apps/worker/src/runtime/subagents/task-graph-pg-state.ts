import type pg from "pg"
import { redactSensitiveText } from "@jobcopilot/shared"
import { deriveTaskGraphReadModel, type TaskGraphEvent } from "../planning/task-graph.js"
import { parseTaskGraphRepairReceipt, parseTaskGraphVerificationReport, taskGraphVerificationReportMatchesStatus, type TaskGraphCurrentNode, type TaskGraphCurrentState, type TaskGraphReadScope } from "./task-graph-command-port.js"
import { parseTaskGraphSnapshot, taskGraphItemId, taskGraphState, type TaskGraphSnapshot } from "./task-graph-snapshot.js"
import { parsePersistedTaskGraphReceipt } from "./task-graph-pg-event-validation.js"
import { parsePersistedTaskGraphNativeReceipt } from "./task-graph-native-command.js"
import { resolveTaskGraphRepairDependencies } from "./task-graph-dependency-context.js"
import { assertSessionWorkAdmission } from "../session-gate.js"
import { taskGraphNativeCurrentView } from "./task-graph-native-result.js"
import { loadTaskGraphSourceInputRelations, parsePersistedTaskGraphProposalNodes, type PersistedTaskGraphProposalSource } from "./task-graph-pg-source-provenance.js"
import { copyTaskGraphSourceCheckpointMetadata, type TaskGraphInputRelation } from "./task-graph-source-intent-context.js"
import {
  projectTaskGraphResult,
  taskGraphResultProjectionBytes,
  taskGraphResultProjectionItemCount,
  TASK_GRAPH_RESULT_PROJECTION_ITEMS_TOTAL,
  TASK_GRAPH_RESULT_PROJECTION_TOTAL_BYTE_LIMIT,
} from "./task-graph-result-projection.js"
import type { SubagentTaskStatus } from "./types.js"
export type GraphIdentityScope = Pick<TaskGraphReadScope, "userId" | "sessionId" | "turnId" | "rootTaskId" | "parentTaskId">
export type GraphEventScope = GraphIdentityScope & Readonly<{ stepId?: string }>
export type GraphScope = TaskGraphReadScope & Readonly<{ stepId?: string }>
export type GraphParent = Record<string, unknown>
export type GraphItem = Readonly<{ id: string; revision: number; content: unknown; createdAt: unknown }>
export type GraphTaskRow = Readonly<{ id: string; status: SubagentTaskStatus; role: string; taskType?: string; expectedOutputSchema?: unknown; failureReason: string | null; result: unknown }>
export type LoadedGraph = Readonly<{
  rootTaskId: string
  snapshot: TaskGraphSnapshot | null
  item: GraphItem | null
  state: ReturnType<typeof taskGraphState> | null
  tasks: ReadonlyMap<string, GraphTaskRow>
  sourceInputRelations?: ReadonlyMap<string, TaskGraphInputRelation>
}>
type Queryable = Pick<pg.PoolClient, "query">
function nonEmpty(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0 }
function parseObject(value: unknown): Record<string, unknown> | null {
  const parsed = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown } catch { return null } })() : value
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null
}
function validateScope(scope: GraphScope): void {
  const ids = [scope.userId, scope.sessionId, scope.turnId, scope.rootTaskId, scope.parentTaskId, scope.turnLeaseOwner, scope.parentLeaseOwner]
  if (ids.some(value => !nonEmpty(value)) || scope.parentTaskId !== scope.rootTaskId
    || !Number.isSafeInteger(scope.turnLeaseVersion) || scope.turnLeaseVersion < 1
    || !Number.isSafeInteger(scope.parentAttemptCount) || scope.parentAttemptCount < 1
    || (scope.stepId !== undefined && !nonEmpty(scope.stepId))) throw new Error("task_graph_scope_invalid")
}
/** Locks the tenant, Turn and parent in the same order used by TaskGraph writes. */
export async function lockTaskGraphScope(client: Queryable, scope: GraphScope, requireWorkAdmission = false): Promise<GraphParent> {
  validateScope(scope)
  const session = await client.query(`SELECT "id" FROM "agent_sessions"
    WHERE "id" = $1 AND "userId" = $2 AND "status" NOT IN ('aborted', 'archived') FOR UPDATE`, [scope.sessionId, scope.userId])
  if (!session.rows[0]) throw new Error("task_graph_session_fenced")
  const turn = await client.query(`SELECT "id" FROM "agent_turns"
    WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3 AND "rootTaskId" = $4
      AND "leaseOwnerId" = $5 AND "leaseVersion" = $6 AND "status" = 'in_progress' FOR UPDATE`,
  [scope.turnId, scope.sessionId, scope.userId, scope.rootTaskId, scope.turnLeaseOwner, scope.turnLeaseVersion])
  if (!turn.rows[0]) throw new Error("task_graph_turn_fenced")
  if (requireWorkAdmission) await assertSessionWorkAdmission(client, scope)
  const parent = await client.query(`SELECT task.*, session."userId" AS "userId" FROM "sub_agent_tasks" AS task
    JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
    WHERE task."id" = $1 AND task."sessionId" = $2 AND task."turnId" = $3
      AND task."rootTaskId" = $4 AND session."userId" = $5 AND task."status" = 'running'
      AND task."leaseOwner" = $6 AND task."attemptCount" = $7
      AND task."interruptRequestedAt" IS NULL FOR UPDATE OF task`,
  [scope.parentTaskId, scope.sessionId, scope.turnId, scope.rootTaskId, scope.userId, scope.parentLeaseOwner, scope.parentAttemptCount])
  if (!parent.rows[0]) throw new Error("task_graph_parent_fenced")
  if (scope.stepId !== undefined) {
    const step = await client.query(`SELECT "id" FROM "agent_steps"
      WHERE "id" = $1 AND "turnId" = $2 AND "sessionId" = $3 AND "status" = 'streaming'
        AND ("taskId" = $4 OR "taskId" IS NULL) FOR UPDATE`,
    [scope.stepId, scope.turnId, scope.sessionId, scope.parentTaskId])
    if (!step.rows[0]) throw new Error("task_graph_step_fenced")
  }
  // Check lease deadlines only after every scope row lock has been acquired. A
  // transaction can wait on any lock above, while CURRENT_TIMESTAMP remains
  // fixed at the transaction start time.
  const leases = await client.query(`WITH wall_clock AS MATERIALIZED (SELECT clock_timestamp() AS "at")
    SELECT turn."leaseExpiresAt" > wall_clock."at" AS "turnLeaseValid",
      task."leaseExpiresAt" > wall_clock."at" AS "parentLeaseValid"
    FROM wall_clock
    JOIN "agent_turns" AS turn ON turn."id" = $1 AND turn."sessionId" = $2
      AND turn."userId" = $3 AND turn."rootTaskId" = $4
    JOIN "agent_sessions" AS session ON session."id" = turn."sessionId" AND session."userId" = $3
    JOIN "sub_agent_tasks" AS task ON task."id" = $7 AND task."sessionId" = $2
      AND task."turnId" = $1 AND task."rootTaskId" = $4
    WHERE turn."leaseOwnerId" = $5 AND turn."leaseVersion" = $6 AND turn."status" = 'in_progress'
      AND task."status" = 'running' AND task."leaseOwner" = $8 AND task."attemptCount" = $9
      AND task."interruptRequestedAt" IS NULL`,
  [scope.turnId, scope.sessionId, scope.userId, scope.rootTaskId, scope.turnLeaseOwner, scope.turnLeaseVersion, scope.parentTaskId, scope.parentLeaseOwner, scope.parentAttemptCount])
  const leaseState = leases.rows[0] as Record<string, unknown> | undefined
  if (!leaseState || leaseState.turnLeaseValid !== true) throw new Error("task_graph_turn_fenced")
  if (leaseState.parentLeaseValid !== true) throw new Error("task_graph_parent_fenced")
  return parent.rows[0] as GraphParent
}
export async function loadTaskGraph(client: Queryable, scope: GraphIdentityScope & Readonly<{ stepId?: string }>, forUpdate = true, includeSourceInputRelations = false): Promise<LoadedGraph> {
  const item = await client.query(`SELECT item."id", item."revision", item."content", item."createdAt"
    FROM "agent_items" AS item JOIN "agent_turns" AS turn ON turn."id" = item."turnId" AND turn."sessionId" = item."sessionId"
    JOIN "agent_sessions" AS session ON session."id" = item."sessionId"
    WHERE item."id" = $1 AND item."sessionId" = $2 AND item."turnId" = $3 AND item."taskId" = $4
      AND item."type" = 'task_graph' AND turn."userId" = $5 AND session."userId" = $5${forUpdate ? " FOR UPDATE OF item" : ""}`,
  [taskGraphItemId(scope.parentTaskId), scope.sessionId, scope.turnId, scope.parentTaskId, scope.userId])
  if (!item.rows[0]) return { rootTaskId: scope.rootTaskId, item: null, snapshot: null, state: null, tasks: new Map(), sourceInputRelations: new Map() }
  const stored = item.rows[0] as Record<string, unknown>
  const snapshot = parseTaskGraphSnapshot(stored.content)
  const revision = Number(stored.revision)
  if (!Number.isSafeInteger(revision) || revision < 1) throw new Error("task_graph_revision_invalid")
  const ids = snapshot.nodes.map(node => node.taskId)
  const taskRows = await client.query(`SELECT task."id", task."status", task."role", task."taskType", task."expectedOutputSchema", task."failureReason", task."result"
    FROM "sub_agent_tasks" AS task JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
    WHERE task."id" = ANY($1::text[]) AND task."sessionId" = $2 AND task."turnId" = $3
      AND task."rootTaskId" = $4 AND task."parentTaskId" = $5 AND session."userId" = $6`,
  [ids, scope.sessionId, scope.turnId, scope.rootTaskId, scope.parentTaskId, scope.userId])
  if (taskRows.rows.length !== ids.length) throw new Error("task_graph_task_scope_invalid")
  const tasks = new Map<string, GraphTaskRow>(taskRows.rows.map(raw => {
    const row = raw as Record<string, unknown>
    return [String(row.id), {
      id: String(row.id), status: String(row.status) as SubagentTaskStatus, role: String(row.role),
      taskType: String(row.taskType), expectedOutputSchema: row.expectedOutputSchema ?? {},
      failureReason: nonEmpty(row.failureReason) ? String(row.failureReason) : null, result: row.result ?? null,
    }]
  }))
  const events = await client.query(`SELECT event."type", event."itemId", event."taskId", event."idempotencyKey", event."payload", event."causationId" FROM "agent_events" AS event
    JOIN "agent_sessions" AS session ON session."id" = event."sessionId"
    JOIN "agent_turns" AS turn ON turn."id" = event."turnId" AND turn."sessionId" = event."sessionId"
    WHERE event."sessionId" = $1 AND event."turnId" = $2 AND event."itemId" = $3
      AND event."type" IN ('task_graph.lifecycle', 'item.started', 'item.delta') AND session."userId" = $4 AND turn."userId" = $4 ORDER BY event."sequence" ASC`,
  [scope.sessionId, scope.turnId, taskGraphItemId(scope.parentTaskId), scope.userId])
  const appliedEvents: TaskGraphEvent[] = []
  const proposalSources: PersistedTaskGraphProposalSource[] = []
  for (const raw of events.rows) {
    const row = raw as Record<string, unknown>
    const event = parsePersistedTaskGraphReceipt(row.type, row.payload, { id: String(stored.id), revision }, snapshot, scope, { itemId: row.itemId, taskId: row.taskId, idempotencyKey: row.idempotencyKey })
    if (event) appliedEvents.push(event)
    else if (parseObject(row.payload)?.kind === "proposal") proposalSources.push({ payload: row.payload, causationId: row.causationId })
  }
  const sourceInputRelations = includeSourceInputRelations ? await loadTaskGraphSourceInputRelations(client, scope, snapshot, proposalSources, scope.stepId) : undefined
  const baseState = taskGraphState(snapshot, revision, new Map([...tasks].map(([id, task]) => [id, { status: task.status, failureReason: task.failureReason }])), appliedEvents)
  const repairs = resolveTaskGraphRepairDependencies(snapshot, tasks, scope.rootTaskId)
  const state = { ...baseState, repairSatisfiedNodeKeys: repairs.satisfied, repairPendingNodeKeys: repairs.pending }
  return { rootTaskId: scope.rootTaskId, item: { id: String(stored.id), revision, content: stored.content, createdAt: stored.createdAt }, snapshot, state, tasks, sourceInputRelations }
}
/** Uses the durable proposal receipt to distinguish graph children from legacy tasks sharing a root. */
export async function hasPersistedTaskGraphMembership(client: Queryable, scope: GraphIdentityScope, taskId: string): Promise<boolean> {
  const result = await client.query(`SELECT event."type", event."itemId", event."taskId", event."idempotencyKey", event."payload" FROM "agent_events" AS event
    JOIN "agent_sessions" AS session ON session."id" = event."sessionId"
    JOIN "agent_turns" AS turn ON turn."id" = event."turnId" AND turn."sessionId" = event."sessionId"
    WHERE event."sessionId" = $1 AND event."turnId" = $2 AND event."itemId" = $3 AND event."taskId" = $4
      AND event."type" IN ('item.started', 'item.delta') AND event."payload"->>'kind' IN ('proposal', 'native_command')
      AND session."userId" = $5 AND turn."userId" = $5 ORDER BY event."sequence" ASC`,
  [scope.sessionId, scope.turnId, taskGraphItemId(scope.parentTaskId), scope.parentTaskId, scope.userId])
  if (!result.rows.length) return false
  let member = false
  for (const raw of result.rows) {
    const persisted = raw as Record<string, unknown>, payload = parseObject(persisted.payload)
    if (payload?.kind === "native_command") {
      const revision = Number(payload.revision), content = parseTaskGraphSnapshot(payload.content)
      const receipt = parsePersistedTaskGraphNativeReceipt(payload, {
        type: persisted.type, itemId: persisted.itemId, taskId: persisted.taskId, idempotencyKey: persisted.idempotencyKey,
      }, { id: taskGraphItemId(scope.parentTaskId), revision }, content, scope)
      if (receipt.child.taskId === taskId) member = true
      continue
    }
    const taskIds = parsePersistedTaskGraphProposalNodes(payload).map(node => node.taskId)
    if (taskIds.includes(taskId)) member = true
  }
  return member
}
export function currentTaskGraph(loaded: LoadedGraph): TaskGraphCurrentState {
  if (!loaded.state || !loaded.snapshot) return { revision: 0, nodes: [] }
  const read = deriveTaskGraphReadModel(loaded.state)
  const taskByKey = new Map(loaded.snapshot.nodes.map(node => [node.key, loaded.tasks.get(node.taskId)!] as const))
  let projectionBytes = 0
  let projectionItems = 0
  const nodes: TaskGraphCurrentNode[] = read.map(node => {
    const task = taskByKey.get(node.key)!
    const stored = loaded.snapshot!.nodes.find(candidate => candidate.key === node.key)!
    const verificationCriterionIds = stored.verificationDisposition === "typed" && stored.verification
      ? stored.verification.criteria.map(criterion => criterion.id) : undefined
    const taskResult = parseObject(task.result)
    const hasReport = Boolean(taskResult && Object.hasOwn(taskResult, "taskGraphVerificationReport"))
    const verificationReport = verificationCriterionIds
      ? parseTaskGraphVerificationReport(taskResult?.taskGraphVerificationReport, verificationCriterionIds) : undefined
    const repairOf = stored.repairOf?.graphRootTaskId === loaded.rootTaskId ? stored.repairOf : undefined
    const hasReceipt = Boolean(taskResult && Object.hasOwn(taskResult, "taskGraphRepairReceipt"))
    const repairReceipt = parseTaskGraphRepairReceipt(taskResult?.taskGraphRepairReceipt, {
      repairOf, repairNodeKey: stored.key, repairTaskId: stored.taskId, report: verificationReport,
    })
    if (hasReport && (!verificationReport || !taskGraphVerificationReportMatchesStatus(verificationReport, task.status)
      || verificationReport.reasonCode === "repair_target_unresolved" && !repairOf)
      || stored.verificationDisposition === "typed" && (task.status === "completed" || task.status === "failed") && !verificationReport
      || hasReceipt && !repairReceipt
      || stored.repairOf && task.status === "completed" && verificationReport?.status === "passed" && !repairReceipt) throw new Error("task_graph_verification_report_invalid")
    const projectionSource = taskGraphProjectionSource(task.result, taskResult, Boolean(verificationReport), Boolean(repairReceipt))
    const proposedProjection = projectTaskGraphResult(task.role, task.status, projectionSource)
    const bytes = taskGraphResultProjectionBytes(proposedProjection)
    const items = taskGraphResultProjectionItemCount(proposedProjection)
    const projectionFits = projectionBytes + bytes <= TASK_GRAPH_RESULT_PROJECTION_TOTAL_BYTE_LIMIT
      && projectionItems + items <= TASK_GRAPH_RESULT_PROJECTION_ITEMS_TOTAL
    const resultProjection = projectionFits ? proposedProjection : projectTaskGraphResult("", "", null)
    if (projectionFits) {
      projectionBytes += bytes
      projectionItems += items
    }
    return {
      key: node.key, templateId: node.templateId, goal: node.goal, successCriteria: node.successCriteria,
      dependsOn: node.dependsOn, taskId: stored.taskId,
      status: task.status, readiness: node.readiness, resultSummary: resultSummary(task.result),
      ...(loaded.sourceInputRelations ? { inputRelation: loaded.sourceInputRelations.get(stored.key) ?? "unknown" } : {}),
      resultProjection,
      ...(verificationCriterionIds ? { verificationCriterionIds } : {}),
      ...(verificationReport ? { verificationReport } : {}),
      ...(repairOf ? { repairOf } : {}), ...(repairReceipt ? { repairReceipt } : {}),
      ...(stored.nativeDelegation ? taskGraphNativeCurrentView(stored.nativeDelegation, task) : {}),
      failureReason: safeText(task.failureReason, 500),
    }
  })
  const current = { revision: loaded.state.revision, nodes }
  copyTaskGraphSourceCheckpointMetadata(loaded.sourceInputRelations, current)
  return current
}
function taskGraphProjectionSource(
  original: unknown,
  result: Record<string, unknown> | null,
  hasValidatedReport: boolean,
  hasValidatedReceipt: boolean,
): unknown {
  if (!result || (!hasValidatedReport && !hasValidatedReceipt)) return original
  const copy = Object.create(Object.getPrototypeOf(result)) as Record<PropertyKey, unknown>
  for (const key of Reflect.ownKeys(result)) {
    if ((hasValidatedReport && key === "taskGraphVerificationReport") || (hasValidatedReceipt && key === "taskGraphRepairReceipt")) continue
    Object.defineProperty(copy, key, Object.getOwnPropertyDescriptor(result, key)!)
  }
  return copy
}
function resultSummary(value: unknown): string | null {
  const row = parseObject(value)
  return row && typeof row.summary === "string" ? safeText(row.summary, 500) : value === null ? null : "Result stored; details are available through the scoped wait observation."
}
function safeText(value: string | null, limit: number): string | null {
  if (value === null) return null
  const safe = redactSensitiveText(value).replace(/[\u0000-\u001f\u007f]/g, " ").trim()
  let output = ""
  for (const character of safe) {
    if (Buffer.byteLength(output + character, "utf8") > limit) break
    output += character
  }
  return output || null
}
