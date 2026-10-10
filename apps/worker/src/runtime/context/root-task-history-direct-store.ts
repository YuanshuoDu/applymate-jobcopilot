import type pg from "pg"
import { currentTaskGraph, loadTaskGraph, type GraphIdentityScope } from "../subagents/task-graph-pg-state.js"
import type { TaskGraphCurrentState } from "../subagents/task-graph-command-port.js"
import type { ValidatedRootTaskHistoryOutcome } from "./root-task-history.js"
import { readRootTaskHistoryCandidates, type RootTaskHistoryCandidate } from "./root-task-history-source-store.js"
import { readRootTaskHistoryFence, validateRootTaskHistoryFenceInput, withRootTaskHistoryTransaction, type RootTaskHistoryFenceInput } from "./root-task-history-fence.js"

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

async function lockEligibleSourceSession(client: Client, sessionId: string, userId: string): Promise<boolean> {
  const result = await client.query<{ id: string }>(`SELECT "id" FROM "agent_sessions"
    WHERE "id" = $1 AND "userId" = $2 AND "status" NOT IN ('aborted', 'archived') FOR SHARE SKIP LOCKED`, [sessionId, userId])
  return result.rows.length === 1 && result.rows[0]?.id === sessionId
}

async function graphForCandidate(client: Client, input: RootTaskHistoryFenceInput, source: RootTaskHistoryCandidate): Promise<TaskGraphCurrentState | undefined> {
  if (input.crossSessionRootTaskHistoryEnabled === true && source.sessionId !== input.lease.sessionId
    && !await lockEligibleSourceSession(client, source.sessionId, input.lease.userId)) return undefined
  const scope: GraphIdentityScope = { userId: input.lease.userId, sessionId: source.sessionId,
    turnId: source.turnId, rootTaskId: source.rootTaskId, parentTaskId: source.rootTaskId }
  try {
    const loaded = await loadTaskGraph(client, scope, false)
    if (!loaded.item || !loaded.snapshot || !loaded.state) return undefined
    const graph = currentTaskGraph(loaded)
    return graph.nodes.length ? graph : undefined
  } catch (error: unknown) {
    if (graphEvidenceError(error)) return undefined
    throw error
  }
}

export function createPgDirectRootTaskHistoryStore(pool: Pool) {
  return {
    async load(input: DirectRootTaskHistoryLoadInput): Promise<readonly ValidatedRootTaskHistoryOutcome[]> {
      validateRootTaskHistoryFenceInput(input)
      return withRootTaskHistoryTransaction(pool, input.lease.userId, async client => {
        const fence = await readRootTaskHistoryFence(client, input)
        if (!fence) return []
        const sources = await readRootTaskHistoryCandidates(client, input, fence)
        const outcomes: ValidatedRootTaskHistoryOutcome[] = []
        let graphLoads = 0
        for (const source of sources) {
          if (graphLoads >= GRAPH_LOAD_LIMIT) break
          graphLoads += 1
          const taskGraph = await graphForCandidate(client, input, source)
          if (taskGraph) outcomes.push({ sourceTurnId: source.turnId, sourceRootTaskId: source.rootTaskId,
            terminalSequence: source.terminalSequence, ...(source.terminalAt ? { terminalAt: source.terminalAt } : {}), taskGraph })
        }
        return outcomes
      })
    },
  }
}
