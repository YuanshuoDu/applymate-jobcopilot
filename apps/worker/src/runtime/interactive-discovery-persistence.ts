import type pg from "pg"

import { buildDiscoveryShortlist, type DiscoveryShortlistFailureCode, type DiscoveryShortlistResult } from "./subagents/discovery-shortlist.js"
import { createObservedEvidenceIndex, hydrateObservedEvidence } from "./subagents/child-evidence.js"
import { lockTaskGraphScope, loadTaskGraph, type GraphIdentityScope, type GraphScope, type GraphTaskRow } from "./subagents/task-graph-pg-state.js"
import { restoreToolCallState } from "./turns/persisted-tool-call-state.js"
import type { TurnLease } from "./turns/lease.js"
import type { SubagentTaskRecord } from "./subagents/types.js"

type Row = Record<string, unknown>
type DiscoveryGraphNode = Readonly<{ templateId: string; taskId: string }>
type LatestDiscoveryTasks =
  | Readonly<{ ok: true; scout: GraphTaskRow; analyst: GraphTaskRow }>
  | Readonly<{ ok: false; failures: readonly DiscoveryShortlistFailureCode[] }>
const ROLE_TASK_TERMINAL_FAILURES = new Set(["failed", "interrupted", "cancelled", "closed"])

/** Rebuilds the shortlist from this owner's exact Scout/Analyst TaskGraph results and read receipts. */
export async function loadInteractiveDiscoveryShortlist(input: {
  readonly pool: Pick<pg.Pool, "connect">
  readonly lease: TurnLease
  readonly root: Pick<SubagentTaskRecord, "id" | "attemptCount">
}): Promise<DiscoveryShortlistResult | undefined> {
  const client = await input.pool.connect()
  let committed = false
  try {
    await client.query("BEGIN")
    await client.query("SELECT set_config($1, $2, true)", ["app.user_id", input.lease.userId])
    const identity: GraphIdentityScope = {
      userId: input.lease.userId, sessionId: input.lease.sessionId, turnId: input.lease.turnId,
      rootTaskId: input.root.id, parentTaskId: input.root.id,
    }
    const scope: GraphScope = {
      ...identity, turnLeaseOwner: input.lease.ownerId, turnLeaseVersion: input.lease.leaseVersion,
      parentLeaseOwner: input.lease.ownerId, parentAttemptCount: input.root.attemptCount,
    }
    await lockTaskGraphScope(client, scope)
    const graph = await loadTaskGraph(client, identity, false)
    const nodes = graph.snapshot?.nodes ?? []
    if (!graph.state || nodes.some(node => node.templateId !== "scout" && node.templateId !== "analyst")) return await commitUndefined()
    const selection = selectLatestDiscoveryTasks(nodes, graph.tasks)
    if (!selection.ok) {
      const failed: DiscoveryShortlistResult = { schemaVersion: 1, status: "failed", items: [], failures: [...selection.failures] }
      await client.query("COMMIT")
      committed = true
      return failed
    }
    const { scout: scoutTask, analyst: analystTask } = selection
    const taskIds = [scoutTask.id, analystTask.id]
    const items = await client.query<Row>(
      `SELECT item."id", item."stepId", item."taskId", item."type", item."status", item."revision", item."content"
       FROM "agent_items" AS item
       JOIN "agent_sessions" AS session ON session."id" = item."sessionId"
       JOIN "agent_turns" AS turn ON turn."id" = item."turnId" AND turn."sessionId" = item."sessionId"
       WHERE item."sessionId" = $1 AND item."turnId" = $2 AND item."taskId" = ANY($3::text[])
         AND item."type" IN ('tool_call', 'tool_result') AND session."userId" = $4 AND turn."userId" = $4
       ORDER BY item."createdAt" ASC`,
      [input.lease.sessionId, input.lease.turnId, taskIds, input.lease.userId],
    )
    const events = await client.query<Row>(
      `SELECT event."type", event."taskId", event."payload"
       FROM "agent_events" AS event
       JOIN "agent_sessions" AS session ON session."id" = event."sessionId"
       JOIN "agent_turns" AS turn ON turn."id" = event."turnId" AND turn."sessionId" = event."sessionId"
       WHERE event."sessionId" = $1 AND event."turnId" = $2 AND event."taskId" = ANY($3::text[])
         AND event."type" IN ('tool_call.completed', 'tool_call.failed')
         AND session."userId" = $4 AND turn."userId" = $4
       ORDER BY event."sequence" ASC`,
      [input.lease.sessionId, input.lease.turnId, taskIds, input.lease.userId],
    )
    const observations = new Map<string, ReturnType<typeof restoreToolCallState>["observations"]>()
    for (const taskId of taskIds) observations.set(taskId, restoreToolCallState(items.rows.filter(row => row.taskId === taskId), events.rows.filter(row => row.taskId === taskId)).observations)
    const shortlist = buildInteractiveDiscoveryShortlist({
      ownerUserId: input.lease.userId, scoutResult: structuredResult(scoutTask.result), analystResult: structuredResult(analystTask.result),
      scoutObservations: observations.get(scoutTask.id) ?? [], analystObservations: observations.get(analystTask.id) ?? [],
    })
    return await requireCurrentOwnerJobs(client, input.lease.userId, shortlist).then(async result => { await client.query("COMMIT"); committed = true; return result })
  } catch (error: unknown) {
    if (!committed) await client.query("ROLLBACK").catch(() => undefined)
    throw error
  } finally { client.release() }

  async function commitUndefined(): Promise<undefined> {
    await client.query("COMMIT")
    committed = true
    return undefined
  }
}

/** Re-checks ranked IDs against the same user's current Job rows before root completion. */
export async function requireCurrentOwnerJobs(
  client: Pick<pg.PoolClient, "query">,
  ownerUserId: string,
  shortlist: DiscoveryShortlistResult,
): Promise<DiscoveryShortlistResult> {
  if (shortlist.items.length === 0) return shortlist
  const result = await client.query<{ id: unknown }>(
    `SELECT "id" FROM "Job" WHERE "userId" = $1 AND "id" = ANY($2::text[])`,
    [ownerUserId, shortlist.items.map(item => item.jobId)],
  )
  const current = new Set(result.rows.map(row => typeof row.id === "string" ? row.id : ""))
  const items = shortlist.items.filter(item => current.has(item.jobId))
  if (items.length === shortlist.items.length) return shortlist
  const failures = FAILURE_ORDER.filter(code => new Set([...shortlist.failures, "evidence_unverified" as const]).has(code))
  return { schemaVersion: 1, status: items.length ? "partial" : "failed", items, failures }
}

const FAILURE_ORDER: readonly DiscoveryShortlistFailureCode[] = [
  "owner_scope_missing", "observed_evidence_invalid", "invalid_scout_result", "invalid_analyst_result",
  "scout_task_missing", "analyst_task_missing", "scout_task_failed", "analyst_task_failed", "scout_task_incomplete", "analyst_task_incomplete",
  "scout_result_partial", "analyst_result_partial", "evidence_conflict", "evidence_unverified",
  "invalid_job_id", "duplicate_scout_job", "duplicate_analyst_finding", "conflicting_analyst_score",
  "no_common_candidates", "discovery_runtime_unavailable", "discovery_runtime_failed",
]

/** Selects the last appended task for each role; a newer failed or pending task blocks older success. */
export function selectLatestDiscoveryTasks(
  nodes: readonly DiscoveryGraphNode[],
  tasks: ReadonlyMap<string, GraphTaskRow>,
): LatestDiscoveryTasks {
  const scout = latestCompletedRoleTask(nodes, tasks, "scout")
  const analyst = latestCompletedRoleTask(nodes, tasks, "analyst")
  const failures = [scout.failure, analyst.failure].filter((failure): failure is DiscoveryShortlistFailureCode => Boolean(failure))
  return failures.length > 0 ? { ok: false, failures } : { ok: true, scout: scout.task!, analyst: analyst.task! }
}

function latestCompletedRoleTask(
  nodes: readonly DiscoveryGraphNode[],
  tasks: ReadonlyMap<string, GraphTaskRow>,
  role: "scout" | "analyst",
): { readonly task?: GraphTaskRow; readonly failure?: DiscoveryShortlistFailureCode } {
  let latest: DiscoveryGraphNode | undefined
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const node = nodes[index]!
    if (node.templateId === role) { latest = node; break }
  }
  if (!latest) return { failure: `${role}_task_missing` }
  const task = tasks.get(latest.taskId)
  if (!task) return { failure: `${role}_task_incomplete` }
  if (task.role !== role) return { failure: role === "scout" ? "invalid_scout_result" : "invalid_analyst_result" }
  if (task.status === "completed") return { task }
  return { failure: ROLE_TASK_TERMINAL_FAILURES.has(task.status) ? `${role}_task_failed` : `${role}_task_incomplete` }
}

export function buildInteractiveDiscoveryShortlist(input: {
  readonly ownerUserId: string
  readonly scoutResult: unknown
  readonly analystResult: unknown
  readonly scoutObservations: readonly { readonly id: string; readonly content: Record<string, unknown> }[]
  readonly analystObservations: readonly { readonly id: string; readonly content: Record<string, unknown> }[]
}): DiscoveryShortlistResult {
  const observedEvidence = createObservedEvidenceIndex()
  hydrateObservedEvidence(observedEvidence, input.scoutObservations)
  hydrateObservedEvidence(observedEvidence, input.analystObservations)
  return buildDiscoveryShortlist({ ...input, observedEvidence })
}

function structuredResult(value: unknown): unknown { return object(value).structuredResult }
function object(value: unknown): Row {
  const parsed = typeof value === "string" ? parseJson(value) : value
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Row : {}
}
function parseJson(value: string): unknown { try { return JSON.parse(value) as unknown } catch { return undefined } }
