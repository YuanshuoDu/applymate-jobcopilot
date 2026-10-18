import type pg from "pg"
import { loadTaskGraph, type GraphIdentityScope, type GraphTaskRow, type LoadedGraph } from "../subagents/task-graph-pg-state.js"
import type { TaskGraphReadScope } from "../subagents/task-graph-command-port.js"
import { TASK_GRAPH_RESULT_SOURCE_BYTE_LIMIT } from "../subagents/task-graph-result-page-contract.js"
import {
  TASK_GRAPH_HISTORICAL_DISCOVERY_PAGE_SCHEMA, parseTaskGraphHistoricalDiscoveryPageRequest,
  type TaskGraphHistoricalDiscoveryPage, type TaskGraphHistoricalDiscoveryPageRequest,
} from "../subagents/task-graph-historical-discovery-page-contract.js"
import { historicalScoutTaskIds, projectHistoricalDiscoveryPage, selectHistoricalScoutSource } from "./root-task-history-result-page-selection.js"
import { readRootTaskHistoryCandidates, type RootTaskHistoryCandidate } from "./root-task-history-source-store.js"
import {
  readRootTaskHistoryFence, validateRootTaskHistoryFenceInput, withRootTaskHistoryTransaction,
  type RootTaskHistoryFenceInput,
} from "./root-task-history-fence.js"

type Pool = Pick<pg.Pool, "connect">
type Client = pg.PoolClient
type HistoricalReadScope = TaskGraphReadScope & Readonly<{ stepId: string }>
const GRAPH_LOAD_LIMIT = 8

export function createPgRootTaskHistoryResultPageStore(pool: Pool) {
  return {
    async read(scope: HistoricalReadScope, request: TaskGraphHistoricalDiscoveryPageRequest): Promise<TaskGraphHistoricalDiscoveryPage> {
      const parsedRequest = parseTaskGraphHistoricalDiscoveryPageRequest(request)
      if (!parsedRequest || scope.parentLeaseOwner !== scope.turnLeaseOwner) return unavailable("no_source")
      const input = fenceInput(scope)
      validateRootTaskHistoryFenceInput(input)
      return withRootTaskHistoryTransaction(pool, scope.userId, client => readWithClient(client, input, scope, parsedRequest))
    },
  }
}

async function readWithClient(
  client: Client,
  input: RootTaskHistoryFenceInput,
  scope: HistoricalReadScope,
  request: TaskGraphHistoricalDiscoveryPageRequest,
): Promise<TaskGraphHistoricalDiscoveryPage> {
  const fence = await readRootTaskHistoryFence(client, input)
  if (!fence) return unavailable("no_source")
  const sources = await readRootTaskHistoryCandidates(client, input, fence)
  let graphLoads = 0
  for (const source of sources) {
    if (graphLoads >= GRAPH_LOAD_LIMIT) break
    graphLoads += 1
    const graphScope: GraphIdentityScope = { userId: scope.userId, sessionId: source.sessionId,
      turnId: source.turnId, rootTaskId: source.rootTaskId, parentTaskId: source.rootTaskId }
    if (!await historicalGraphResultsWithinLimit(client, graphScope)) continue
    const loaded = await graphForCandidate(client, graphScope)
    if (!loaded) continue
    const current = await currentScoutRows(client, source, scope.userId, loaded)
    if (!current) continue
    const selected = selectHistoricalScoutSource({ source, loaded: current.loaded, attemptCounts: current.attemptCounts })
    if (selected) return projectHistoricalDiscoveryPage(selected, binding(scope, fence.objectiveDigest), request)
  }
  return unavailable("no_source")
}

async function graphForCandidate(client: Client, scope: GraphIdentityScope): Promise<LoadedGraph | undefined> {
  try {
    const loaded = await loadTaskGraph(client, scope, false)
    return loaded.item && loaded.snapshot && loaded.state ? loaded : undefined
  } catch (error: unknown) {
    if (historyGraphEvidenceError(error)) return undefined
    throw error
  }
}

async function historicalGraphResultsWithinLimit(client: Client, scope: GraphIdentityScope): Promise<boolean> {
  const result = await client.query<Record<string, unknown>>(`SELECT NOT EXISTS (
      SELECT 1 FROM "sub_agent_tasks" AS task
      JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
      WHERE task."sessionId" = $1 AND task."turnId" = $2 AND task."rootTaskId" = $3
        AND session."userId" = $4
        AND COALESCE(octet_length(task."result"::text), 0) > $5
    ) AS "withinLimit"`,
  [scope.sessionId, scope.turnId, scope.rootTaskId, scope.userId, TASK_GRAPH_RESULT_SOURCE_BYTE_LIMIT])
  return result.rows.length === 1 && result.rows[0]?.withinLimit === true
}

async function currentScoutRows(
  client: Client,
  source: RootTaskHistoryCandidate,
  userId: string,
  loaded: LoadedGraph,
): Promise<Readonly<{ loaded: LoadedGraph; attemptCounts: ReadonlyMap<string, number> }> | undefined> {
  const ids = historicalScoutTaskIds(loaded)
  if (!ids.length) return undefined
  const result = await client.query<Record<string, unknown>>(`SELECT task."id", task."attemptCount", task."status", task."role", task."taskType",
      task."expectedOutputSchema", task."result"::text AS "result"
    FROM "sub_agent_tasks" AS task
    JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
    WHERE task."id" = ANY($1::text[]) AND task."sessionId" = $2 AND task."turnId" = $3
      AND task."rootTaskId" = $4 AND task."parentTaskId" = $5 AND session."userId" = $6
    ORDER BY task."id"`,
  [ids, source.sessionId, source.turnId, source.rootTaskId, source.rootTaskId, userId])
  if (result.rows.length !== ids.length) return undefined
  const attempts = new Map<string, number>(), tasks = new Map(loaded.tasks)
  for (const row of result.rows) {
    const id = typeof row.id === "string" ? row.id : "", old = loaded.tasks.get(id)
    const attempt = Number(row.attemptCount)
    if (!old || !ids.includes(id) || attempts.has(id) || old.status !== row.status || old.role !== row.role || old.taskType !== row.taskType
      || !Number.isSafeInteger(attempt) || attempt < 1) return undefined
    attempts.set(id, attempt)
    tasks.set(id, { ...old, expectedOutputSchema: row.expectedOutputSchema ?? {}, result: row.result ?? null } satisfies GraphTaskRow)
  }
  return { loaded: { ...loaded, tasks }, attemptCounts: attempts }
}

function fenceInput(scope: HistoricalReadScope): RootTaskHistoryFenceInput {
  return {
    lease: { userId: scope.userId, sessionId: scope.sessionId, turnId: scope.turnId,
      ownerId: scope.turnLeaseOwner, leaseVersion: scope.turnLeaseVersion,
      leaseStartedAt: new Date(0), leaseExpiresAt: new Date(0) },
    rootTaskId: scope.rootTaskId, rootAttemptCount: scope.parentAttemptCount, stepId: scope.stepId,
    now: new Date(), crossSessionRootTaskHistoryEnabled: false, objectiveHistoryIndexEnabled: false,
  }
}

function binding(scope: HistoricalReadScope, objectiveDigest: string) {
  return {
    userId: scope.userId, sessionId: scope.sessionId, turnId: scope.turnId, rootTaskId: scope.rootTaskId,
    turnLeaseOwner: scope.turnLeaseOwner, turnLeaseVersion: scope.turnLeaseVersion,
    parentLeaseOwner: scope.parentLeaseOwner, parentAttemptCount: scope.parentAttemptCount, objectiveDigest,
  }
}

function databaseError(value: unknown): boolean {
  return !!value && typeof value === "object" && "code" in value && typeof value.code === "string" && /^[0-9A-Z]{5}$/.test(value.code)
}

function historyGraphEvidenceError(value: unknown): boolean {
  return value instanceof Error && !databaseError(value)
    && /^task_graph_[a-z0-9_]+$/.test(value.message)
}

function unavailable(reason: "no_source"): TaskGraphHistoricalDiscoveryPage {
  return { schemaVersion: TASK_GRAPH_HISTORICAL_DISCOVERY_PAGE_SCHEMA, trust: "untrusted", availability: "unavailable", reason }
}
