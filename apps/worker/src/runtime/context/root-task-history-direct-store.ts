import type pg from "pg"
import { loadTaskGraph, type GraphIdentityScope } from "../subagents/task-graph-pg-state.js"
import { projectLoadedRootTaskHistoryGraph, type LoadedRootTaskHistoryGraphProjection } from "./root-task-history-lesson-projection.js"
import type { ValidatedRootTaskHistoryOutcome } from "./root-task-history.js"
import { readRootTaskHistoryCandidates, type RootTaskHistoryCandidate } from "./root-task-history-source-store.js"
import {
  readRootTaskHistoryFence, validateRootTaskHistoryFenceInput, withRootTaskHistoryTransaction,
  type RootTaskHistoryFenceInput,
} from "./root-task-history-fence.js"

type Pool = Pick<pg.Pool, "connect">
type Client = pg.PoolClient
const GRAPH_LOAD_LIMIT = 8

export type DirectRootTaskHistoryLoadInput = RootTaskHistoryFenceInput

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

async function retainSameSessionTerminalTimes(
  client: Client, input: DirectRootTaskHistoryLoadInput, outcomes: readonly ValidatedRootTaskHistoryOutcome[],
): Promise<readonly ValidatedRootTaskHistoryOutcome[]> {
  if (!outcomes.length || input.crossSessionRootTaskHistoryEnabled === true) return outcomes
  const result = await client.query<Record<string, unknown>>(`WITH expected AS MATERIALIZED (
      SELECT * FROM unnest($2::text[], $3::text[], $4::text[]) AS source("turnId", "rootTaskId", "sequence")
    )
    SELECT event."sessionId", event."turnId", event."taskId", event."sequence", event."type", event."createdAt"
    FROM expected AS source
    JOIN "agent_events" AS event ON event."sessionId"=$1 AND event."turnId"=source."turnId"
      AND event."taskId"=source."rootTaskId" AND event."sequence"=source."sequence"::bigint
      AND event."type" IN ('turn.completed','turn.failed','turn.interrupted')
    JOIN "agent_turns" AS turn ON turn."id"=event."turnId" AND turn."sessionId"=event."sessionId"
      AND turn."rootTaskId"=event."taskId" AND turn."userId"=$5
    JOIN "agent_sessions" AS session ON session."id"=event."sessionId" AND session."userId"=$5
      AND session."status" NOT IN ('aborted','archived')
    FOR SHARE OF event`, [input.lease.sessionId,
    outcomes.map(outcome => outcome.sourceTurnId), outcomes.map(outcome => outcome.sourceRootTaskId),
    outcomes.map(outcome => outcome.terminalSequence.toString()), input.lease.userId])
  const byIdentity = new Map<string, Date>()
  for (const row of result.rows) {
    const identity = JSON.stringify([row.turnId, row.taskId, String(row.sequence)])
    if (row.sessionId !== input.lease.sessionId || !(row.createdAt instanceof Date) || !Number.isFinite(row.createdAt.getTime())
      || byIdentity.has(identity)) return outcomes
    byIdentity.set(identity, row.createdAt)
  }
  return outcomes.map(outcome => {
    const terminalAt = byIdentity.get(JSON.stringify([outcome.sourceTurnId, outcome.sourceRootTaskId, outcome.terminalSequence.toString()]))
    return terminalAt ? { ...outcome, sourceSessionDiffers: false, terminalAt } : outcome
  })
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
      if (graph) outcomes.push({ sourceTurnId: source.turnId, sourceRootTaskId: source.rootTaskId,
        terminalSequence: source.terminalSequence, ...(source.terminalAt ? { terminalAt: source.terminalAt } : {}),
        ...(input.crossSessionRootTaskHistoryEnabled === true ? { sourceSessionDiffers: source.sessionId !== input.lease.sessionId } : {}),
        taskGraph: graph.taskGraph, sourceNodeOrdinals: graph.sourceNodeOrdinals,
        ...(graph.nodeLessons ? { nodeLessons: graph.nodeLessons } : {}), ...(graph.reportedOutputs ? { reportedOutputs: graph.reportedOutputs } : {}) })
    }
    return retainSameSessionTerminalTimes(client, input, outcomes)
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
  }
}
