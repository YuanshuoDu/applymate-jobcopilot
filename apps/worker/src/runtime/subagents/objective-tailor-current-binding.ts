import type pg from "pg"
import { canonicalTaskGraphJson } from "./task-graph-snapshot.js"
import { isExactObjectiveTaskGraphIntent, objectiveTailorPlan } from "./objective-task-graph-child-authority.js"
import { materializeTaskGraphDependencyContext, type ScopedDependencyResult } from "./task-graph-dependency-context.js"
import type { GraphIdentityScope, LoadedGraph } from "./task-graph-pg-state.js"
import { revalidateObjectiveTailorCandidateWitness } from "./objective-tailor-candidate.js"
import { parseObjectiveTailorCandidateWitness, type ObjectiveTailorCandidateWitness } from "./objective-tailor-witness.js"

type Queryable = Pick<pg.PoolClient, "query">
type Row = Record<string, unknown>
export type ObjectiveTailorCurrentBinding = Readonly<{ status: "absent" }>
  | Readonly<{ status: "invalid" }>
  | Readonly<{ status: "bound"; witness: ObjectiveTailorCandidateWitness; writerTaskId: string; reviewerTaskId: string }>

/** Reads the exact persisted pair and revalidates its proof on the caller's current graph/client. */
export async function readCurrentObjectiveTailorBinding(
  client: Queryable, scope: GraphIdentityScope, loaded: LoadedGraph,
): Promise<ObjectiveTailorCurrentBinding> {
  if (!scopeIdsValid(scope) || scope.parentTaskId !== scope.rootTaskId) return { status: "invalid" }
  const children = await client.query(`SELECT task."id", task."sessionId", task."turnId", task."rootTaskId", task."parentTaskId",
      task."role", task."taskType", task."status", task."context", session."userId" AS "userId"
    FROM "sub_agent_tasks" AS task JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
    JOIN "agent_turns" AS turn ON turn."id" = task."turnId" AND turn."sessionId" = task."sessionId"
    WHERE task."sessionId" = $1 AND task."turnId" = $2
      AND session."userId" = $3 AND turn."userId" = $3
      AND (task."context" ? 'objectiveTailorCandidateMode' OR task."context" ? 'objectiveTailorCandidateWitness')
    ORDER BY task."id"`, [scope.sessionId, scope.turnId, scope.userId])
  const turnResult = await client.query(`SELECT turn."input", turn."source", turn."executionMode", turn."rootTaskId"
    FROM "agent_turns" AS turn JOIN "agent_sessions" AS session ON session."id" = turn."sessionId"
    WHERE turn."id" = $1 AND turn."sessionId" = $2 AND turn."userId" = $3 AND session."userId" = $3
    `, [scope.turnId, scope.sessionId, scope.userId])
  const turn = turnResult.rows[0] as Row | undefined
  const exactOwnedTurn = turnResult.rows.length === 1 && turn?.rootTaskId === scope.rootTaskId
    && turn.source === "user" && turn.executionMode === "canonical_task_graph"
  if (!exactOwnedTurn) return { status: "invalid" }
  const exactObjectiveTurn = isExactObjectiveTaskGraphIntent(turn.input)
  if (children.rows.length === 0) {
    const pairPresent = loaded.snapshot?.nodes.some(node => node.templateId === "cover_letter_writer" || node.templateId === "cover_letter_reviewer")
    if (!exactObjectiveTurn) return hasSelectedJobPreparation(turn.input) ? { status: "absent" } : { status: "invalid" }
    if (loaded.discoveryTurnEligibility !== "ordinary" || !loaded.snapshot || !loaded.item || !loaded.state
      || loaded.rootTaskId !== scope.rootTaskId) return { status: "invalid" }
    return pairPresent ? { status: "invalid" } : { status: "absent" }
  }
  if (!exactObjectiveTurn || loaded.discoveryTurnEligibility !== "ordinary" || !loaded.snapshot || !loaded.item || !loaded.state
    || loaded.rootTaskId !== scope.rootTaskId) return { status: "invalid" }
  const writers = loaded.snapshot.nodes.filter(node => node.templateId === "cover_letter_writer")
  const reviewers = loaded.snapshot.nodes.filter(node => node.templateId === "cover_letter_reviewer")
  if (writers.length !== 1 || reviewers.length !== 1 || children.rows.length !== 2) return { status: "invalid" }
  const writer = writers[0]!, reviewer = reviewers[0]!, plan = objectiveTailorPlan(contextWitness(children.rows))
  if (!plan || writer.key !== plan.proposal.nodes[0]?.key || reviewer.key !== plan.proposal.nodes[1]?.key
    || writer.taskId !== rowByRole(children.rows, "writer")?.id || reviewer.taskId !== rowByRole(children.rows, "reviewer")?.id
    || canonicalTaskGraphJson(writer.dependsOn) !== canonicalTaskGraphJson(plan.proposal.nodes[0]?.dependsOn)
    || canonicalTaskGraphJson(reviewer.dependsOn) !== canonicalTaskGraphJson(plan.proposal.nodes[1]?.dependsOn)) return { status: "invalid" }
  const writerRow = rowByRole(children.rows, "writer"), reviewerRow = rowByRole(children.rows, "reviewer")
  if (!writerRow || !reviewerRow || !validOwnedRow(writerRow, scope, writer.taskId, "writer", "cover_letter_draft")
    || !validOwnedRow(reviewerRow, scope, reviewer.taskId, "reviewer", "cover_letter_review")) return { status: "invalid" }
  const writerTask = loaded.tasks.get(writer.taskId), reviewerTask = loaded.tasks.get(reviewer.taskId)
  if (!writerTask || !reviewerTask || writerTask.role !== "writer" || writerTask.taskType !== "cover_letter_draft"
    || reviewerTask.role !== "reviewer" || reviewerTask.taskType !== "cover_letter_review"
    || writerTask.status !== writerRow.status || reviewerTask.status !== reviewerRow.status
    || !matchesPairContext(writerRow.context, plan.templates.cover_letter_writer!, scope, writer, loaded)
    || !matchesPairContext(reviewerRow.context, plan.templates.cover_letter_reviewer!, scope, reviewer, loaded)) return { status: "invalid" }
  const witness = parseObjectiveTailorCandidateWitness(contextWitness(children.rows))
  if (!witness || !parseObjectiveTailorCandidateWitness(writerRow.context && record(writerRow.context)?.objectiveTailorCandidateWitness)
    || canonicalTaskGraphJson(record(writerRow.context)?.objectiveTailorCandidateWitness) !== canonicalTaskGraphJson(witness)
    || canonicalTaskGraphJson(record(reviewerRow.context)?.objectiveTailorCandidateWitness) !== canonicalTaskGraphJson(witness)
    || !await revalidateObjectiveTailorCandidateWitness(client, scope, loaded, witness)) return { status: "invalid" }
  return { status: "bound", witness, writerTaskId: writer.taskId, reviewerTaskId: reviewer.taskId }
}

function contextWitness(rows: readonly unknown[]): unknown {
  const values = rows.map(value => record(record(value)?.context)?.objectiveTailorCandidateWitness)
  return values.length === 2 && values[0] !== undefined && values[1] !== undefined
    && canonicalTaskGraphJson(values[0]) === canonicalTaskGraphJson(values[1]) ? values[0] : undefined
}
function rowByRole(rows: readonly unknown[], role: string): Row | undefined {
  const matches = rows.map(record).filter((row): row is Row => row?.role === role)
  return matches.length === 1 ? matches[0] : undefined
}
function validOwnedRow(row: Row, scope: GraphIdentityScope, taskId: string, role: string, taskType: string): boolean {
  return row.id === taskId && row.userId === scope.userId && row.sessionId === scope.sessionId && row.turnId === scope.turnId
    && row.rootTaskId === scope.rootTaskId && row.parentTaskId === scope.parentTaskId && row.role === role && row.taskType === taskType
}
function matchesPairContext(value: unknown, template: Readonly<{ context?: unknown }>, scope: GraphIdentityScope,
  node: Readonly<{ dependsOn: readonly string[] }>, loaded: LoadedGraph): boolean {
  const context = record(value), expected = record(template.context)
  if (!context || !expected || context.objectiveTailorCandidateMode !== true
    || canonicalTaskGraphJson(context.selectedJobPreparation) !== canonicalTaskGraphJson(expected.selectedJobPreparation)
    || canonicalTaskGraphJson(context.objectiveTailorCandidateWitness) !== canonicalTaskGraphJson(expected.objectiveTailorCandidateWitness)) return false
  const hasDependency = Object.hasOwn(context, "taskGraphDependencyResults"), base = { ...context }
  delete base.taskGraphDependencyResults
  if (canonicalTaskGraphJson(base) !== canonicalTaskGraphJson(expected)) return false
  const dependenciesComplete = node.dependsOn.every(key => loaded.state?.nodes.find(item => item.key === key)?.status === "completed")
  if (!hasDependency) return !dependenciesComplete
  if (!dependenciesComplete) return false
  try {
    const dependencies: ScopedDependencyResult[] = node.dependsOn.map(key => {
      const dependencyNode = loaded.snapshot?.nodes.find(item => item.key === key), task = dependencyNode && loaded.tasks.get(dependencyNode.taskId)
      if (!dependencyNode || !task) throw new Error("task_graph_dependency_missing")
      return { ...scope, key, taskId: dependencyNode.taskId, status: task.status, role: task.role,
        expectedOutputSchema: task.expectedOutputSchema, result: task.result, failureReason: task.failureReason,
        verificationDisposition: dependencyNode.verificationDisposition, verification: dependencyNode.verification }
    })
    const expectedContext = materializeTaskGraphDependencyContext(expected, scope, node.dependsOn, dependencies)
    return canonicalTaskGraphJson(context) === canonicalTaskGraphJson(expectedContext)
  } catch { return false }
}
function scopeIdsValid(scope: GraphIdentityScope): boolean {
  return [scope.userId, scope.sessionId, scope.turnId, scope.rootTaskId, scope.parentTaskId]
    .every(value => typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= 256)
}
function hasSelectedJobPreparation(value: unknown): boolean {
  const input = record(value), preparation = record(input?.selectedJobPreparation)
  return Boolean(preparation && Object.keys(preparation).length === 1 && typeof preparation.jobId === "string"
    && preparation.jobId.trim() === preparation.jobId && preparation.jobId.length > 0 && preparation.jobId.length <= 256)
}
function record(value: unknown): Row | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  try {
    const row = value as Row, keys = Reflect.ownKeys(row)
    return (Object.getPrototypeOf(row) === Object.prototype || Object.getPrototypeOf(row) === null)
      && keys.every(key => typeof key === "string" && Object.getOwnPropertyDescriptor(row, key)?.enumerable
        && "value" in Object.getOwnPropertyDescriptor(row, key)!) ? row : undefined
  } catch { return undefined }
}
