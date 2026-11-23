import type pg from "pg"
import { currentTaskGraph, loadTaskGraph, type GraphIdentityScope } from "../subagents/task-graph-pg-state.js"
import { projectLoadedRootTaskHistoryGraph, type LoadedRootTaskHistoryGraphProjection } from "./root-task-history-lesson-projection.js"
import type { ValidatedRootTaskHistoryOutcome } from "./root-task-history.js"
import { projectRootTaskHistoryBranchReplacementEpisode } from "./root-task-history-branch-replacement-history.js"
import { STEERING_RECONCILIATION_EVENT_TYPE, STEERING_RECONCILIATION_FAILED_BRANCH_REPAIR_SCHEMA_VERSION,
  parseSteeringReconciliationReceipt, steeringReconciliationDurableIdempotencyKey, steeringReconciliationId } from "../subagents/steering-reconciliation-contract.js"
import { verifyHistoricalFailedBranchReplacementMemory } from "../subagents/steering-reconciliation-failed-branch-history.js"
import { mergeRootTaskHistorySearchFootprintSources, projectRootTaskHistorySearchFootprintContext,
  type RootTaskHistorySearchFootprintContext, type RootTaskHistorySearchFootprintSource } from "./root-task-history-search-footprint-context.js"
import { readRootTaskHistoryCandidates, readRootTaskHistoryFootprintCandidates, type RootTaskHistoryCandidate } from "./root-task-history-source-store.js"
import {
  readRootTaskHistoryFence, validateRootTaskHistoryFenceInput, withRootTaskHistoryTransaction,
  type RootTaskHistoryFenceInput,
} from "./root-task-history-fence.js"

type Pool = Pick<pg.Pool, "connect">
type Client = pg.PoolClient
const GRAPH_LOAD_LIMIT = 8

export type DirectRootTaskHistoryLoadInput = RootTaskHistoryFenceInput
export type DirectRootTaskHistorySearchFootprintLoadInput = Omit<RootTaskHistoryFenceInput, "crossSessionRootTaskHistoryEnabled">
  & Readonly<{ searchFootprintReadAllowed: boolean }>

function databaseError(value: unknown): boolean {
  return !!value && typeof value === "object" && "code" in value && typeof value.code === "string"
    && /^[0-9A-Z]{5}$/.test(value.code)
}

const SCOPE_ERRORS = new Set([
  "task_graph_scope_invalid", "task_graph_session_fenced", "task_graph_turn_fenced",
  "task_graph_parent_fenced", "task_graph_step_fenced", "task_graph_task_scope_invalid",
])

function graphEvidenceError(value: unknown): boolean {
  return value instanceof Error && !databaseError(value) && !SCOPE_ERRORS.has(value.message)
    && /^task_graph_[a-z0-9_]+$/.test(value.message)
}

function historicalPayload(value: unknown): unknown {
  if (typeof value !== "string") return value
  try { return JSON.parse(value) as unknown } catch { return null }
}

function positiveSequence(value: unknown): bigint | null {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,18}$/.test(value)) return null
  const parsed = BigInt(value)
  return parsed <= 9_223_372_036_854_775_807n ? parsed : null
}

async function branchReplacementEpisodeForCandidate(client: Client, input: RootTaskHistoryFenceInput,
  source: RootTaskHistoryCandidate): Promise<ValidatedRootTaskHistoryOutcome["branchReplacementEpisode"]> {
  if (source.sessionId !== input.lease.sessionId) return undefined
  const scope = { userId: input.lease.userId, sessionId: source.sessionId, turnId: source.turnId,
    rootTaskId: source.rootTaskId, parentTaskId: source.rootTaskId }
  const result = await client.query<Record<string, unknown>>(`SELECT event."id", event."sequence"::text AS "sequence", event."itemId", event."taskId",
      event."type", event."actor", event."correlationId", event."causationId", event."idempotencyKey", event."payload",
      session."userId" AS "sessionUserId", turn."userId" AS "turnUserId", turn."rootTaskId" AS "turnRootTaskId",
      outbox."idempotencyKey" AS "outboxIdempotencyKey"
    FROM "agent_events" AS event JOIN "agent_sessions" AS session ON session."id" = event."sessionId" AND session."userId" = $4
      JOIN "agent_turns" AS turn ON turn."id" = event."turnId" AND turn."sessionId" = event."sessionId"
        AND turn."userId" = $4 AND turn."rootTaskId" = $3
      LEFT JOIN "agent_outbox" AS outbox ON outbox."idempotencyKey" = 'agent-event:' || event."id"
    WHERE event."sessionId" = $1 AND event."turnId" = $2 AND event."type" = $5
      AND event."payload"->>'schemaVersion' = $6 AND event."sequence" < $7::bigint
    ORDER BY event."sequence" DESC, event."id" DESC LIMIT 2`, [scope.sessionId, scope.turnId, scope.rootTaskId,
    scope.userId, STEERING_RECONCILIATION_EVENT_TYPE, STEERING_RECONCILIATION_FAILED_BRANCH_REPAIR_SCHEMA_VERSION,
    source.terminalSequence.toString()])
  const row = result.rows[0], receipt = parseSteeringReconciliationReceipt(historicalPayload(row?.payload))
  const relation = receipt?.failedBranch, sequence = positiveSequence(row?.sequence), nextSequence = positiveSequence(result.rows[1]?.sequence)
  if (result.rows.length < 1 || !row || !steeringReconciliationId(row.id) || !receipt || !relation || !sequence
    || sequence === nextSequence || sequence >= source.terminalSequence
    || row.sessionUserId !== scope.userId || row.turnUserId !== scope.userId || row.turnRootTaskId !== scope.rootTaskId
    || row.itemId !== null || row.taskId !== scope.rootTaskId || row.type !== STEERING_RECONCILIATION_EVENT_TYPE
    || row.actor !== "orchestrator" || row.correlationId !== scope.turnId || row.causationId !== receipt.stepId
    || row.outboxIdempotencyKey !== null || receipt.sessionId !== scope.sessionId || receipt.turnId !== scope.turnId
    || receipt.rootTaskId !== scope.rootTaskId || relation.operationKey !== row.idempotencyKey
    || row.idempotencyKey !== steeringReconciliationDurableIdempotencyKey(scope, receipt.stepId, relation.agentPlanCall.callId)) return undefined
  const receiptEvent = { id: row.id, sequence, stepId: receipt.stepId, idempotencyKey: String(row.idempotencyKey) }
  try {
    const witness = await verifyHistoricalFailedBranchReplacementMemory(client, scope, relation, receiptEvent)
    return projectRootTaskHistoryBranchReplacementEpisode(witness) ?? undefined
  } catch (error: unknown) {
    if (error instanceof Error && (error.message === "steering_reconciliation_failed_branch_event_invalid" || graphEvidenceError(error))) return undefined
    throw error
  }
}

async function lockEligibleSourceSession(client: Client, sessionId: string, userId: string): Promise<boolean> {
  const result = await client.query<{ id: string }>(`SELECT "id" FROM "agent_sessions"
    WHERE "id" = $1 AND "userId" = $2 AND "status" NOT IN ('aborted', 'archived') FOR SHARE SKIP LOCKED`, [sessionId, userId])
  return result.rows.length === 1 && result.rows[0]?.id === sessionId
}

async function graphForCandidate(client: Client, input: RootTaskHistoryFenceInput, source: RootTaskHistoryCandidate): Promise<LoadedRootTaskHistoryGraphProjection | undefined> {
  const sourceSessionDiffers = input.crossSessionRootTaskHistoryEnabled === true && source.sessionId !== input.lease.sessionId
  if (sourceSessionDiffers
    && !await lockEligibleSourceSession(client, source.sessionId, input.lease.userId)) return undefined
  const scope: GraphIdentityScope = { userId: input.lease.userId, sessionId: source.sessionId,
    turnId: source.turnId, rootTaskId: source.rootTaskId, parentTaskId: source.rootTaskId }
  try {
    const loaded = await loadTaskGraph(client, scope, false)
    if (!loaded.item || !loaded.snapshot || !loaded.state) return undefined
    const graph = projectLoadedRootTaskHistoryGraph(loaded, sourceSessionDiffers)
    return graph?.taskGraph.nodes.length ? graph : undefined
  } catch (error: unknown) {
    if (graphEvidenceError(error)) return undefined
    throw error
  }
}

async function assertTenantScope(client: Client, userId: string): Promise<void> {
  const result = await client.query<{ userId: string | null }>(`SELECT current_setting('app.user_id', true) AS "userId"`)
  if (result.rows.length !== 1 || result.rows[0]?.userId !== userId) throw new Error("root_task_history_scope_mismatch")
}

async function readSearchFootprintsWithClient(client: Client, input: DirectRootTaskHistorySearchFootprintLoadInput): Promise<RootTaskHistorySearchFootprintContext> {
  if (input.searchFootprintReadAllowed !== true) return { roles: [], locations: [], atsSources: [] }
  const request: RootTaskHistoryFenceInput = { ...input, crossSessionRootTaskHistoryEnabled: true }
  const fence = await readRootTaskHistoryFence(client, request)
  if (!fence?.searchFootprintOrigin || !fence.searchFootprintStartWitness) return { roles: [], locations: [], atsSources: [] }
  const candidates = await readRootTaskHistoryFootprintCandidates(client, request, fence), sources: RootTaskHistorySearchFootprintSource[] = []
  let graphLoads = 0
  for (const candidate of candidates) {
    if (candidate.sessionId === input.lease.sessionId || graphLoads >= GRAPH_LOAD_LIMIT) continue
    graphLoads += 1
    if (!await lockEligibleSourceSession(client, candidate.sessionId, input.lease.userId)) continue
    const scope: GraphIdentityScope = { userId: input.lease.userId, sessionId: candidate.sessionId,
      turnId: candidate.turnId, rootTaskId: candidate.rootTaskId, parentTaskId: candidate.rootTaskId }
    try {
      const loaded = await loadTaskGraph(client, scope, false)
      if (!loaded.item || !loaded.snapshot || !loaded.state || !projectLoadedRootTaskHistoryGraph(loaded, true)) continue
      const footprint = projectRootTaskHistorySearchFootprintContext(currentTaskGraph(loaded))
      if (footprint && candidate.terminalXid8 && candidate.terminalWitnessEventId) sources.push({
        sourceTurnId: candidate.turnId, sourceRootTaskId: candidate.rootTaskId,
        terminalXid8: candidate.terminalXid8, terminalWitnessEventId: candidate.terminalWitnessEventId, footprint,
      })
    } catch (error: unknown) {
      if (graphEvidenceError(error)) continue
      throw error
    }
  }
  return mergeRootTaskHistorySearchFootprintSources(sources, fence.searchFootprintStartWitness.xid8) ?? { roles: [], locations: [], atsSources: [] }
}

export function createPgDirectRootTaskHistoryStore(pool: Pool) {
  async function readWithClient(client: Client, input: DirectRootTaskHistoryLoadInput): Promise<readonly ValidatedRootTaskHistoryOutcome[]> {
    const fence = await readRootTaskHistoryFence(client, input)
    if (!fence) return []
    const sources = await readRootTaskHistoryCandidates(client, input, fence)
    const outcomes: ValidatedRootTaskHistoryOutcome[] = []
    let graphLoads = 0
    for (const source of sources) {
      if (graphLoads >= GRAPH_LOAD_LIMIT) break
      graphLoads += 1
      const graph = await graphForCandidate(client, input, source)
      if (graph) {
        const branchReplacementEpisode = await branchReplacementEpisodeForCandidate(client, input, source)
        outcomes.push({ sourceTurnId: source.turnId, sourceRootTaskId: source.rootTaskId,
          terminalSequence: source.terminalSequence,
          ...(source.terminalXid8 ? { terminalXid8: source.terminalXid8 } : {}),
          ...(source.terminalWitnessEventId ? { terminalWitnessEventId: source.terminalWitnessEventId } : {}),
          ...(input.crossSessionRootTaskHistoryEnabled === true ? { sourceSessionDiffers: source.sessionId !== input.lease.sessionId } : {}),
          taskGraph: graph.taskGraph, sourceNodeOrdinals: graph.sourceNodeOrdinals,
          ...(graph.nodeLessons ? { nodeLessons: graph.nodeLessons } : {}), ...(graph.reportedOutputs ? { reportedOutputs: graph.reportedOutputs } : {}),
          ...(branchReplacementEpisode ? { branchReplacementEpisode } : {}) })
      }
    }
    return outcomes
  }

  return {
    async loadWithClient(client: Client, input: DirectRootTaskHistoryLoadInput): Promise<readonly ValidatedRootTaskHistoryOutcome[]> {
      validateRootTaskHistoryFenceInput(input)
      await assertTenantScope(client, input.lease.userId)
      return readWithClient(client, input)
    },
    async load(input: DirectRootTaskHistoryLoadInput): Promise<readonly ValidatedRootTaskHistoryOutcome[]> {
      validateRootTaskHistoryFenceInput(input)
      return withRootTaskHistoryTransaction(pool, input.lease.userId, client => readWithClient(client, input))
    },
    async loadSearchFootprintsWithClient(client: Client, input: DirectRootTaskHistorySearchFootprintLoadInput): Promise<RootTaskHistorySearchFootprintContext> {
      if (input.searchFootprintReadAllowed !== true) return { roles: [], locations: [], atsSources: [] }
      validateRootTaskHistoryFenceInput({ ...input, crossSessionRootTaskHistoryEnabled: true })
      await assertTenantScope(client, input.lease.userId)
      return readSearchFootprintsWithClient(client, input)
    },
    async loadSearchFootprints(input: DirectRootTaskHistorySearchFootprintLoadInput): Promise<RootTaskHistorySearchFootprintContext> {
      if (input.searchFootprintReadAllowed !== true) return { roles: [], locations: [], atsSources: [] }
      validateRootTaskHistoryFenceInput({ ...input, crossSessionRootTaskHistoryEnabled: true })
      return withRootTaskHistoryTransaction(pool, input.lease.userId, client => readSearchFootprintsWithClient(client, input))
    },
  }
}
