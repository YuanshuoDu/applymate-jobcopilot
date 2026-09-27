import type pg from "pg"
import { redactSensitiveText } from "@jobcopilot/shared"
import { deriveTaskGraphReadModel, type TaskGraphEvent } from "../planning/task-graph.js"
import type { TaskGraphCurrentNode, TaskGraphCurrentState, TaskGraphReadScope } from "./task-graph-command-port.js"
import { parseTaskGraphSnapshot, taskGraphItemId, taskGraphState, type TaskGraphSnapshot } from "./task-graph-snapshot.js"
import { parsePersistedTaskGraphReceipt } from "./task-graph-pg-event-validation.js"
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
export type GraphTaskRow = Readonly<{ id: string; status: SubagentTaskStatus; role: string; failureReason: string | null; result: unknown }>
export type LoadedGraph = Readonly<{
  snapshot: TaskGraphSnapshot | null
  item: GraphItem | null
  state: ReturnType<typeof taskGraphState> | null
  tasks: ReadonlyMap<string, GraphTaskRow>
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
export async function lockTaskGraphScope(client: Queryable, scope: GraphScope): Promise<GraphParent> {
  validateScope(scope)
  const session = await client.query(`SELECT "id" FROM "agent_sessions"
    WHERE "id" = $1 AND "userId" = $2 AND "status" NOT IN ('aborted', 'archived') FOR UPDATE`, [scope.sessionId, scope.userId])
  if (!session.rows[0]) throw new Error("task_graph_session_fenced")
  const turn = await client.query(`SELECT "id" FROM "agent_turns"
    WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3 AND "rootTaskId" = $4
      AND "leaseOwnerId" = $5 AND "leaseVersion" = $6 AND "status" = 'in_progress' FOR UPDATE`,
  [scope.turnId, scope.sessionId, scope.userId, scope.rootTaskId, scope.turnLeaseOwner, scope.turnLeaseVersion])
  if (!turn.rows[0]) throw new Error("task_graph_turn_fenced")
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

export async function loadTaskGraph(client: Queryable, scope: GraphIdentityScope, forUpdate = true): Promise<LoadedGraph> {
  const item = await client.query(`SELECT item."id", item."revision", item."content", item."createdAt"
    FROM "agent_items" AS item JOIN "agent_turns" AS turn ON turn."id" = item."turnId" AND turn."sessionId" = item."sessionId"
    JOIN "agent_sessions" AS session ON session."id" = item."sessionId"
    WHERE item."id" = $1 AND item."sessionId" = $2 AND item."turnId" = $3 AND item."taskId" = $4
      AND item."type" = 'task_graph' AND turn."userId" = $5 AND session."userId" = $5${forUpdate ? " FOR UPDATE OF item" : ""}`,
  [taskGraphItemId(scope.parentTaskId), scope.sessionId, scope.turnId, scope.parentTaskId, scope.userId])
  if (!item.rows[0]) return { item: null, snapshot: null, state: null, tasks: new Map() }
  const stored = item.rows[0] as Record<string, unknown>
  const snapshot = parseTaskGraphSnapshot(stored.content)
  const revision = Number(stored.revision)
  if (!Number.isSafeInteger(revision) || revision < 1) throw new Error("task_graph_revision_invalid")
  const ids = snapshot.nodes.map(node => node.taskId)
  const taskRows = await client.query(`SELECT task."id", task."status", task."role", task."failureReason", task."result"
    FROM "sub_agent_tasks" AS task JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
    WHERE task."id" = ANY($1::text[]) AND task."sessionId" = $2 AND task."turnId" = $3
      AND task."rootTaskId" = $4 AND task."parentTaskId" = $5 AND session."userId" = $6`,
  [ids, scope.sessionId, scope.turnId, scope.rootTaskId, scope.parentTaskId, scope.userId])
  if (taskRows.rows.length !== ids.length) throw new Error("task_graph_task_scope_invalid")
  const tasks = new Map<string, GraphTaskRow>(taskRows.rows.map(raw => {
    const row = raw as Record<string, unknown>
    return [String(row.id), {
      id: String(row.id), status: String(row.status) as SubagentTaskStatus, role: String(row.role),
      failureReason: nonEmpty(row.failureReason) ? String(row.failureReason) : null, result: row.result ?? null,
    }]
  }))
  const events = await client.query(`SELECT event."type", event."payload" FROM "agent_events" AS event
    JOIN "agent_sessions" AS session ON session."id" = event."sessionId"
    JOIN "agent_turns" AS turn ON turn."id" = event."turnId" AND turn."sessionId" = event."sessionId"
    WHERE event."sessionId" = $1 AND event."turnId" = $2 AND event."itemId" = $3
      AND event."type" IN ('task_graph.lifecycle', 'item.delta') AND session."userId" = $4 AND turn."userId" = $4 ORDER BY event."sequence" ASC`,
  [scope.sessionId, scope.turnId, taskGraphItemId(scope.parentTaskId), scope.userId])
  const appliedEvents: TaskGraphEvent[] = []
  for (const raw of events.rows) {
    const row = raw as Record<string, unknown>
    const event = parsePersistedTaskGraphReceipt(row.type, row.payload, { id: String(stored.id), revision }, snapshot, scope)
    if (event) appliedEvents.push(event)
  }
  const state = taskGraphState(snapshot, revision, new Map([...tasks].map(([id, task]) => [id, { status: task.status, failureReason: task.failureReason }])), appliedEvents)
  return { item: { id: String(stored.id), revision, content: stored.content, createdAt: stored.createdAt }, snapshot, state, tasks }
}

/** Uses the durable proposal receipt to distinguish graph children from legacy tasks sharing a root. */
export async function hasPersistedTaskGraphMembership(client: Queryable, scope: GraphIdentityScope, taskId: string): Promise<boolean> {
  const result = await client.query(`SELECT event."payload" FROM "agent_events" AS event
    JOIN "agent_sessions" AS session ON session."id" = event."sessionId"
    JOIN "agent_turns" AS turn ON turn."id" = event."turnId" AND turn."sessionId" = event."sessionId"
    WHERE event."sessionId" = $1 AND event."turnId" = $2 AND event."itemId" = $3 AND event."taskId" = $4
      AND event."type" IN ('item.started', 'item.delta') AND event."payload"->>'kind' = 'proposal'
      AND session."userId" = $5 AND turn."userId" = $5 ORDER BY event."sequence" ASC`,
  [scope.sessionId, scope.turnId, taskGraphItemId(scope.parentTaskId), scope.parentTaskId, scope.userId])
  if (!result.rows.length) return false
  let member = false
  for (const raw of result.rows) {
    const payload = parseObject((raw as Record<string, unknown>).payload)
    const receipt = parseObject(payload?.receipt)
    if (payload?.kind !== "proposal" || !receipt || !Number.isSafeInteger(receipt.revision) || Number(receipt.revision) < 1
      || !Array.isArray(receipt.nodes) || receipt.nodes.length === 0 || !Array.isArray(receipt.readyTaskIds)
      || receipt.readyTaskIds.some(id => typeof id !== "string")) throw new Error("task_graph_receipt_invalid")
    const taskIds: string[] = []
    for (const value of receipt.nodes) {
      const node = parseObject(value)
      if (!node || typeof node.key !== "string" || !node.key.trim() || typeof node.taskId !== "string" || !node.taskId.trim()
        || (node.status !== "queued" && node.status !== "waiting")) throw new Error("task_graph_receipt_invalid")
      taskIds.push(node.taskId)
    }
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
    const proposedProjection = projectTaskGraphResult(task.role, task.status, task.result)
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
      dependsOn: node.dependsOn, taskId: loaded.snapshot!.nodes.find(stored => stored.key === node.key)!.taskId,
      status: task.status, readiness: node.readiness, resultSummary: resultSummary(task.result),
      resultProjection,
      failureReason: safeText(task.failureReason, 500),
    }
  })
  return { revision: loaded.state.revision, nodes }
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
