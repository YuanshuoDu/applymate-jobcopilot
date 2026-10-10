import type pg from "pg"
import type { RepositoryJsonValue } from "@jobcopilot/agent-protocol"
import { taskGraphVerificationDependencyNodeKeys } from "../planning/task-graph-verification.js"
import { loadTaskGraph, type GraphIdentityScope } from "./task-graph-pg-state.js"
import { parseTaskGraphVerificationReport } from "./task-graph-command-port.js"
import { parseStoredTaskGraphVerificationReport, publicTaskGraphVerificationReport } from "./task-graph-verification-report.js"
import { canonicalTaskGraphJson, parseTaskGraphSnapshot, taskGraphItemId, type TaskGraphSnapshot } from "./task-graph-snapshot.js"

type Queryable = Pick<pg.PoolClient, "query">
export type DurableWaitTarget = Record<string, unknown>
export type DurableWaitProjection = Readonly<{ id: string; content: RepositoryJsonValue }>
export type DurableWaitGraph = Readonly<{
  snapshot: TaskGraphSnapshot | null
  targets: readonly DurableWaitTarget[]
  dependencyTaskIds: ReadonlySet<string>
}>

export async function readDurableWaitSnapshot(client: Queryable, scope: GraphIdentityScope): Promise<TaskGraphSnapshot | null> {
  const row = (await client.query<{ content: unknown }>(`SELECT item."content" FROM "agent_items" AS item JOIN "agent_turns" AS turn ON turn."id" = item."turnId" AND turn."sessionId" = item."sessionId" JOIN "agent_sessions" AS session ON session."id" = item."sessionId" WHERE item."id" = $1 AND item."sessionId" = $2 AND item."turnId" = $3 AND item."taskId" = $4 AND item."type" = 'task_graph' AND turn."userId" = $5 AND session."userId" = $5`, [taskGraphItemId(scope.parentTaskId), scope.sessionId, scope.turnId, scope.parentTaskId, scope.userId])).rows[0]
  if (!row) return null
  try { return parseTaskGraphSnapshot(row.content) } catch { return null }
}

export function projectDurableWaitOutcome(waitId: string, prepared: { readonly value: RepositoryJsonValue; readonly taskIds: readonly string[]; readonly mode: "any" | "all" }): DurableWaitProjection {
  return { id: `wait-result:${waitId}`, content: {
    toolCallId: `wait:${waitId}`, toolName: "agent.wait", input: { taskIds: [...prepared.taskIds], mode: prepared.mode },
    status: "completed", output: prepared.value, errorCode: null,
  } }
}

function object(value: unknown): Record<string, unknown> | null {
  const parsed = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown } catch { return null } })() : value
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
  try { const prototype = Object.getPrototypeOf(parsed); return prototype === Object.prototype || prototype === null ? parsed as Record<string, unknown> : null } catch { return null }
}

function hasStoredBindings(target: DurableWaitTarget): boolean {
  const result = object(target.result), report = object(result?.taskGraphVerificationReport)
  return Boolean(report && Object.hasOwn(report, "dependencyBindings"))
}

/** Selects only wait targets whose completed cross-node proof needs a fresh graph read. */
export function durableWaitDependencyTaskIds(snapshot: TaskGraphSnapshot | null, targets: readonly DurableWaitTarget[]): ReadonlySet<string> {
  const selected = new Set<string>()
  for (const target of targets) {
    const taskId = typeof target.id === "string" ? target.id : ""
    const node = snapshot?.nodes.find(candidate => candidate.taskId === taskId)
    if (node?.verificationDisposition === "typed" && node.verification && taskGraphVerificationDependencyNodeKeys(node.verification).length > 0
      || hasStoredBindings(target)) selected.add(taskId)
  }
  return selected
}

/** Uses the caller-owned transaction and central graph validator only for selected cross-node targets. */
export async function revalidateDurableWaitDependencies(
  client: Queryable,
  scope: GraphIdentityScope,
  snapshot: TaskGraphSnapshot | null,
  targets: readonly DurableWaitTarget[],
): Promise<DurableWaitGraph> {
  const dependencyTaskIds = durableWaitDependencyTaskIds(snapshot, targets)
  if (dependencyTaskIds.size === 0) return { snapshot, targets, dependencyTaskIds }
  const current = await loadTaskGraph(client, scope, false)
  if (!current.item || !current.snapshot) throw new Error("task_graph_verification_report_invalid")
  return {
    snapshot: current.snapshot,
    targets: targets.map(target => {
      const task = current.tasks.get(typeof target.id === "string" ? target.id : "")
      return task ? { ...target, status: task.status, role: task.role, result: task.result, failureReason: task.failureReason } : target
    }),
    dependencyTaskIds,
  }
}

/** Confirms an archived wait report is the current public view of its freshly validated proof. */
export function durableWaitReportMatchesCurrent(
  snapshot: TaskGraphSnapshot | null,
  taskId: string,
  archivedReport: unknown,
  currentResult: unknown,
): boolean {
  const node = snapshot?.nodes.find(candidate => candidate.taskId === taskId)
  if (node?.verificationDisposition !== "typed" || !node.verification) return false
  const criterionIds = node.verification.criteria.map(item => item.id)
  const expectedKeys = taskGraphVerificationDependencyNodeKeys(node.verification)
  const archived = parseTaskGraphVerificationReport(archivedReport, criterionIds)
  const stored = parseStoredTaskGraphVerificationReport(object(currentResult)?.taskGraphVerificationReport, criterionIds, expectedKeys)
  return Boolean(archived && stored && canonicalTaskGraphJson(archived) === canonicalTaskGraphJson(publicTaskGraphVerificationReport(stored)))
}
