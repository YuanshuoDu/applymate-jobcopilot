import type pg from "pg"
import {
  parseVerifiedShortlistSelectionBinding,
  SELECTED_JOB_BATCH_PREPARATION_INTENT,
  VERIFIED_SHORTLIST_SELECTION_SCHEMA,
  type VerifiedShortlistSelectionBinding,
} from "@jobcopilot/agent-protocol"

import { parseInteractiveDiscoveryShortlist } from "./interactive-discovery-contract.js"
import { loadTaskGraph } from "./subagents/task-graph-pg-state.js"
import {
  SELECTED_JOB_BATCH_SLOT_IDS,
  type SelectedJobBatchSlot,
} from "./subagents/selected-job-batch-plan.js"
import { taskGraphItemId } from "./subagents/task-graph-snapshot.js"
import type { TurnLease } from "./turns/lease.js"

const BATCH_INTENT = SELECTED_JOB_BATCH_PREPARATION_INTENT.kind
const DISCOVERY_INTENT = "interactive_discovery_shortlist"
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

export type { VerifiedShortlistSelectionBinding } from "@jobcopilot/agent-protocol"

type QueryClient = Pick<pg.PoolClient, "query">
type TurnRow = Readonly<{
  id: string; sessionId: string; userId: string; source: string; status: string
  executionMode: string | null; rootTaskId: string | null; leaseOwnerId: string | null
  leaseVersion: number; input: unknown
}>
type RootRow = Readonly<{
  id: string; sessionId: string; turnId: string; rootTaskId: string; parentTaskId: string | null
  role: string; taskType: string; status: string; failureReason: string | null; result: unknown
}>

/** Reads a verified batch scope on the caller's already-open transaction, locking Session before Turn. */
export async function loadVerifiedShortlistBatchResources(input: Readonly<{
  client: QueryClient
  lease: TurnLease
  expectedRootTaskId: string | null
  binding: unknown
}>): Promise<readonly SelectedJobBatchSlot[] | null> {
  const { client, lease } = input
  const binding = parseVerifiedShortlistSelectionBinding(input.binding)
  if (!binding || !validBinding(binding, lease) || (input.expectedRootTaskId !== null && !safeId(input.expectedRootTaskId))) return null

  const sessionResult = await client.query<{ id: string }>(
    `SELECT "id" FROM "agent_sessions"
     WHERE "id" = $1 AND "userId" = $2 AND "status" NOT IN ('aborted', 'archived')
     FOR UPDATE`,
    [lease.sessionId, lease.userId],
  )
  if (sessionResult.rows[0]?.id !== lease.sessionId) return null

  const currentResult = await client.query<TurnRow>(
    `SELECT turn."id", turn."sessionId", turn."userId", turn."source", turn."status", turn."executionMode",
        turn."rootTaskId", turn."leaseOwnerId", turn."leaseVersion", turn."input"
     FROM "agent_turns" AS turn
     JOIN "agent_sessions" AS session ON session."id" = turn."sessionId"
     WHERE turn."id" = $1 AND turn."sessionId" = $2 AND turn."userId" = $3
       AND session."userId" = $3 AND session."status" NOT IN ('aborted', 'archived')
       AND turn."source" = 'user' AND turn."executionMode" = 'canonical_task_graph'
       AND turn."status" = 'in_progress' AND turn."leaseOwnerId" = $4 AND turn."leaseVersion" = $5
       AND turn."rootTaskId" IS NOT DISTINCT FROM $6
       AND turn."leaseStartedAt" IS NOT NULL AND turn."leaseExpiresAt" > clock_timestamp()
       AND turn."input"->'intent' = jsonb_build_object('kind', 'selected_job_batch_preparation', 'version', 1)
       AND turn."input"->'verifiedShortlistSelection' = $7::jsonb
       AND NOT (turn."input" ? 'automationRunMode') AND NOT (turn."input" ? 'selectedJobPreparation')
     FOR UPDATE OF turn`,
    [lease.turnId, lease.sessionId, lease.userId, lease.ownerId, lease.leaseVersion,
      input.expectedRootTaskId, bindingJson(binding)],
  )
  const current = currentResult.rows[0]
  if (!current || current.id !== lease.turnId || current.sessionId !== lease.sessionId || current.userId !== lease.userId
    || current.source !== "user" || current.status !== "in_progress" || current.executionMode !== "canonical_task_graph"
    || current.rootTaskId !== input.expectedRootTaskId || current.leaseOwnerId !== lease.ownerId || current.leaseVersion !== lease.leaseVersion
    || !exactIntent(current.input, BATCH_INTENT) || hasOwnInput(current.input, "automationRunMode")
    || hasOwnInput(current.input, "selectedJobPreparation")) return null

  const source = binding.source
  const sourceResult = await client.query<TurnRow>(
    `SELECT turn."id", turn."sessionId", turn."userId", turn."source", turn."status", turn."executionMode",
        turn."rootTaskId", turn."leaseOwnerId", turn."leaseVersion", turn."input"
     FROM "agent_turns" AS turn
     JOIN "agent_sessions" AS session ON session."id" = turn."sessionId"
     WHERE turn."id" = $1 AND turn."sessionId" = $2 AND turn."userId" = $3 AND session."userId" = $3
       AND turn."source" = 'user' AND turn."status" = 'completed' AND turn."rootTaskId" = $4
       AND (turn."executionMode" IS NULL OR turn."executionMode" = 'canonical_task_graph')
       AND turn."input"->'intent' = jsonb_build_object('kind', 'interactive_discovery_shortlist', 'version', 1)`,
    [source.sourceTurnId, lease.sessionId, lease.userId, source.rootTaskId],
  )
  const sourceTurn = sourceResult.rows[0]
  if (!sourceTurn || sourceTurn.id !== source.sourceTurnId || sourceTurn.sessionId !== lease.sessionId
    || sourceTurn.userId !== lease.userId || sourceTurn.source !== "user" || sourceTurn.status !== "completed"
    || sourceTurn.rootTaskId !== source.rootTaskId
    || (sourceTurn.executionMode !== null && sourceTurn.executionMode !== "canonical_task_graph")
    || !exactIntent(sourceTurn.input, DISCOVERY_INTENT)) return null

  const rootResult = await client.query<RootRow>(
    `SELECT task."id", task."sessionId", task."turnId", task."rootTaskId", task."parentTaskId",
        task."role", task."taskType", task."status", task."failureReason", task."result"
     FROM "sub_agent_tasks" AS task
     JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
     WHERE task."id" = $1 AND task."sessionId" = $2 AND task."turnId" = $3
       AND task."rootTaskId" = $1 AND task."parentTaskId" IS NULL AND task."role" = 'orchestrator'
       AND task."taskType" = 'root' AND task."status" = 'completed' AND task."failureReason" IS NULL
       AND session."userId" = $4`,
    [source.rootTaskId, lease.sessionId, source.sourceTurnId, lease.userId],
  )
  const root = rootResult.rows[0]
  if (!root || root.id !== source.rootTaskId || root.sessionId !== lease.sessionId || root.turnId !== source.sourceTurnId
    || root.rootTaskId !== source.rootTaskId || root.parentTaskId !== null || root.role !== "orchestrator"
    || root.taskType !== "root" || root.status !== "completed" || root.failureReason !== null) return null
  const rootValue = record(root.result), structuredResult = record(rootValue?.structuredResult)
  if (rootValue?.status !== "completed") return null
  const shortlist = parseInteractiveDiscoveryShortlist(structuredResult?.interactiveDiscoveryShortlist)
  if (!shortlist || shortlist.status !== "completed"
    || shortlist.items.some(item => item.evidenceIds.length !== 1 || item.evidenceIds[0] !== `read:job:${item.jobId}`)) return null

  const graph = await loadTaskGraph(client, {
    userId: lease.userId, sessionId: lease.sessionId, turnId: source.sourceTurnId,
    rootTaskId: source.rootTaskId, parentTaskId: source.rootTaskId,
  }, false)
  if (graph.rootTaskId !== source.rootTaskId || !graph.item || graph.item.id !== source.graphItemId
    || graph.item.revision !== source.graphRevision || !graph.snapshot || graph.snapshot.nodes.length === 0) return null

  const selectedSet = new Set(binding.selectedJobIds)
  const orderedJobIds = shortlist.items.map(item => item.jobId).filter(jobId => selectedSet.has(jobId))
  if (orderedJobIds.length !== binding.selectedJobIds.length
    || orderedJobIds.some((jobId, index) => jobId !== binding.selectedJobIds[index])) return null

  const jobs = await client.query<{ id: string }>(
    `SELECT "id" FROM "Job" WHERE "userId" = $1 AND "id" = ANY($2::text[]) FOR KEY SHARE`,
    [lease.userId, orderedJobIds],
  )
  const ownedJobIds = new Set(jobs.rows.map(row => row.id))
  if (jobs.rows.length !== orderedJobIds.length || ownedJobIds.size !== orderedJobIds.length
    || orderedJobIds.some(id => !ownedJobIds.has(id))) return null

  return Object.freeze(orderedJobIds.map((jobId, index) => Object.freeze({
    slotId: SELECTED_JOB_BATCH_SLOT_IDS[index]!, jobId,
  })))
}

function validBinding(binding: VerifiedShortlistSelectionBinding, lease: TurnLease): boolean {
  const source = binding?.source, ids = binding?.selectedJobIds
  return binding?.schemaVersion === VERIFIED_SHORTLIST_SELECTION_SCHEMA && !!source
    && source.sessionId === lease.sessionId && source.sourceTurnId !== lease.turnId
    && safeId(source.sessionId) && safeId(source.sourceTurnId) && safeId(source.rootTaskId)
    && source.graphItemId === taskGraphItemId(source.rootTaskId)
    && Number.isSafeInteger(source.graphRevision) && source.graphRevision >= 1
    && Array.isArray(ids) && ids.length >= 2 && ids.length <= SELECTED_JOB_BATCH_SLOT_IDS.length
}

function bindingJson(binding: VerifiedShortlistSelectionBinding): string {
  return JSON.stringify(binding)
}

function exactIntent(value: unknown, kind: string): boolean {
  const input = record(value), intent = record(input?.intent)
  return Boolean(intent && Object.keys(intent).length === 2 && intent.kind === kind && intent.version === 1)
}

function hasOwnInput(value: unknown, key: string): boolean {
  const input = record(value)
  return Boolean(input && Object.hasOwn(input, key))
}

function record(value: unknown): Record<string, unknown> | null {
  const parsed = typeof value === "string" ? parseJson(value) : value
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
  try {
    const prototype = Object.getPrototypeOf(parsed)
    return prototype === Object.prototype || prototype === null ? parsed as Record<string, unknown> : null
  } catch { return null }
}

function parseJson(value: string): unknown {
  try { return JSON.parse(value) as unknown } catch { return null }
}

function safeId(value: unknown): value is string { return typeof value === "string" && ID.test(value) }
