import { createHash } from "node:crypto"
import type pg from "pg"
import { loadTaskGraph, type GraphIdentityScope, type LoadedGraph } from "../subagents/task-graph-pg-state.js"
import { currentTaskGraph } from "../subagents/task-graph-pg-state.js"
import type { TaskGraphExecutionScope } from "../subagents/task-graph-command-port.js"
import type { TaskGraphHistoricalDiscoveryPage, TaskGraphHistoricalDiscoveryPageRequest } from "../subagents/task-graph-historical-discovery-page-contract.js"
import { parseTaskGraphHistoricalDiscoveryPage } from "../subagents/task-graph-historical-discovery-page-contract.js"
import { TASK_GRAPH_HISTORICAL_DISCOVERY_MAX_OFFSET } from "../subagents/task-graph-historical-discovery-page-contract.js"
import { readRootTaskHistoryCandidates, type RootTaskHistoryCandidate } from "./root-task-history-source-store.js"
import {
  readRootTaskHistoryFence, validateRootTaskHistoryFenceInput, withRootTaskHistoryTransaction,
  type RootTaskHistoryFenceInput,
} from "./root-task-history-fence.js"
import {
  pageForHistoricalDiscoverySelection, selectOrdinaryHistoricalScout, unavailableHistoricalDiscoveryPage,
  type HistoricalDiscoveryTaskBinding, type HistoricalDiscoveryTokenBinding,
} from "./root-task-history-result-page-selection.js"

type Pool = Pick<pg.Pool, "connect">
type Client = pg.PoolClient
type Row = Record<string, unknown>
const GRAPH_LOAD_LIMIT = 8
const TERMINAL_STATUSES = new Set(["completed", "failed", "interrupted"])
const SCOPE_ERRORS = new Set([
  "task_graph_scope_invalid", "task_graph_session_fenced", "task_graph_turn_fenced",
  "task_graph_parent_fenced", "task_graph_step_fenced", "task_graph_task_scope_invalid",
])

function historyInput(scope: TaskGraphExecutionScope): RootTaskHistoryFenceInput {
  const now = new Date()
  return {
    lease: {
      userId: scope.userId, sessionId: scope.sessionId, turnId: scope.turnId,
      ownerId: scope.turnLeaseOwner, leaseVersion: scope.turnLeaseVersion,
      leaseStartedAt: now, leaseExpiresAt: now,
    },
    rootTaskId: scope.rootTaskId, rootAttemptCount: scope.parentAttemptCount, stepId: scope.stepId, now,
  }
}

function databaseError(value: unknown): boolean {
  return !!value && typeof value === "object" && "code" in value && typeof value.code === "string"
    && /^[0-9A-Z]{5}$/.test(value.code)
}

function graphEvidenceError(value: unknown): boolean {
  return value instanceof Error && !databaseError(value) && !SCOPE_ERRORS.has(value.message)
    && /^task_graph_[a-z0-9_]+$/.test(value.message)
}

function validRequest(request: TaskGraphHistoricalDiscoveryPageRequest): boolean {
  return !!request && Number.isSafeInteger(request.offset) && request.offset >= 0
    && request.offset <= TASK_GRAPH_HISTORICAL_DISCOVERY_MAX_OFFSET
    && (request.sourceToken === undefined || /^[0-9a-f]{64}$/.test(request.sourceToken))
    && (request.offset === 0 || request.sourceToken !== undefined)
}

async function persistedScoutBindings(
  client: Client, scope: GraphIdentityScope, loaded: LoadedGraph,
): Promise<ReadonlyMap<string, HistoricalDiscoveryTaskBinding> | undefined> {
  const nodes = loaded.snapshot?.nodes
  if (!nodes?.some(node => node.templateId === "scout" && node.verificationDisposition === "typed" && !node.repairOf)) return new Map()
  const ids = nodes.map(node => node.taskId)
  const result = await client.query<Row>(`SELECT task."id", task."allowedActions",
      COALESCE(jsonb_typeof(task."context") = 'object', false) AS "contextIsObject",
      COALESCE(jsonb_typeof(task."context") = 'object' AND task."context" ?| ARRAY[
        'selectedJobPreparation', 'coverLetterBase', 'writerReviewFeedback']::text[], false) AS "hasPrivateSelectionContext"
    FROM "sub_agent_tasks" AS task
    JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
    WHERE task."id" = ANY($1::text[]) AND task."sessionId" = $2 AND task."turnId" = $3
      AND task."rootTaskId" = $4 AND task."parentTaskId" = $5 AND session."userId" = $6`,
  [ids, scope.sessionId, scope.turnId, scope.rootTaskId, scope.parentTaskId, scope.userId])
  if (result.rows.length !== ids.length) return undefined
  const bindings = new Map<string, HistoricalDiscoveryTaskBinding>()
  for (const row of result.rows) {
    if (typeof row.id !== "string" || bindings.has(row.id)) return undefined
    bindings.set(row.id, {
      allowedActions: row.allowedActions,
      contextIsObject: row.contextIsObject,
      hasPrivateSelectionContext: row.hasPrivateSelectionContext,
    })
  }
  return bindings.size === ids.length && ids.every(id => bindings.has(id)) ? bindings : undefined
}

async function graphForCandidate(client: Client, userId: string, source: RootTaskHistoryCandidate): Promise<LoadedGraph | undefined> {
  const scope: GraphIdentityScope = {
    userId,
    sessionId: source.sessionId,
    turnId: source.turnId,
    rootTaskId: source.rootTaskId,
    parentTaskId: source.rootTaskId,
  }
  try {
    const loaded = await loadTaskGraph(client, scope, false)
    if (!loaded.item || !loaded.snapshot || !loaded.state || loaded.rootTaskId !== source.rootTaskId
      || loaded.state.revision !== loaded.item.revision) return undefined
    const current = currentTaskGraph(loaded)
    if (current.revision !== loaded.item.revision || current.nodes.length !== loaded.snapshot.nodes.length) return undefined
    return loaded
  } catch (error: unknown) {
    if (graphEvidenceError(error)) return undefined
    throw error
  }
}

async function terminalReceiptBinding(
  client: Client, input: RootTaskHistoryFenceInput, source: RootTaskHistoryCandidate,
): Promise<Readonly<{ status: "completed" | "failed" | "interrupted"; digest: string }> | undefined> {
  const result = await client.query<Row>(`SELECT turn."status" AS "turnStatus", root."status" AS "rootStatus",
      event."sequence", event."type", event."actor", event."correlationId", event."idempotencyKey", event."itemId", event."payload"
    FROM "agent_turns" AS turn
    JOIN "agent_sessions" AS session ON session."id" = turn."sessionId" AND session."userId" = $3
    JOIN "sub_agent_tasks" AS root ON root."id" = turn."rootTaskId" AND root."sessionId" = turn."sessionId"
      AND root."turnId" = turn."id" AND root."parentTaskId" IS NULL AND root."role" = 'orchestrator' AND root."taskType" = 'root'
    JOIN "agent_events" AS event ON event."sessionId" = turn."sessionId" AND event."turnId" = turn."id"
      AND event."taskId" = turn."rootTaskId" AND event."sequence" = $5::bigint
    WHERE turn."id" = $1 AND turn."sessionId" = $2 AND turn."userId" = $3 AND turn."rootTaskId" = $4
      AND turn."status" IN ('completed', 'failed', 'interrupted')
      AND event."type" IN ('turn.completed', 'turn.failed', 'turn.interrupted')`,
  [source.turnId, source.sessionId, input.lease.userId, source.rootTaskId, String(source.terminalSequence)])
  if (result.rows.length !== 1) return undefined
  const row = result.rows[0]!, status = row.turnStatus
  if (!TERMINAL_STATUSES.has(String(status)) || row.rootStatus !== status || row.sequence?.toString() !== String(source.terminalSequence)
    || (status === "completed" && row.type !== "turn.completed")
    || (status === "failed" && row.type !== "turn.failed")
    || (status === "interrupted" && row.type !== "turn.interrupted")
    || row.actor !== "orchestrator") return undefined
  const receipt = {
    status, rootStatus: row.rootStatus, sequence: String(row.sequence), type: row.type, actor: row.actor,
    correlationId: row.correlationId, idempotencyKey: row.idempotencyKey, itemId: row.itemId,
    payload: stableJson(row.payload),
  }
  const digest = createHash("sha256").update(JSON.stringify(receipt)).digest("hex")
  return { status: status as "completed" | "failed" | "interrupted", digest }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
  if (value && typeof value === "object") {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) throw new Error("root_task_history_terminal_receipt_invalid")
    const keys = Reflect.ownKeys(value)
    if (!keys.every((key): key is string => typeof key === "string")) throw new Error("root_task_history_terminal_receipt_invalid")
    return `{${keys.sort().map(key => `${JSON.stringify(key)}:${stableJson((value as Row)[key])}`).join(",")}}`
  }
  const encoded = JSON.stringify(value)
  if (encoded === undefined) throw new Error("root_task_history_terminal_receipt_invalid")
  return encoded
}

export function createPgRootTaskHistoryResultPageStore(pool: Pool) {
  return {
    async read(scope: TaskGraphExecutionScope, request: TaskGraphHistoricalDiscoveryPageRequest): Promise<TaskGraphHistoricalDiscoveryPage> {
      if (!validRequest(request)) throw new Error("task_graph_historical_discovery_request_invalid")
      if (scope.parentTaskId !== scope.rootTaskId || scope.parentLeaseOwner !== scope.turnLeaseOwner) {
        throw new Error("task_graph_scope_invalid")
      }
      const input = historyInput(scope)
      validateRootTaskHistoryFenceInput(input)
      return withRootTaskHistoryTransaction(pool, input.lease.userId, async client => {
        const fence = await readRootTaskHistoryFence(client, input)
        if (!fence) return unavailableHistoricalDiscoveryPage(request.sourceToken ? "source_changed" : "no_source")
        const sources = await readRootTaskHistoryCandidates(client, input, fence)
        let graphLoads = 0
        for (const source of sources) {
          if (graphLoads >= GRAPH_LOAD_LIMIT) break
          graphLoads += 1
          const loaded = await graphForCandidate(client, input.lease.userId, source)
          if (!loaded || !loaded.snapshot || !loaded.state || !loaded.item) continue
          const taskScope: GraphIdentityScope = {
            userId: input.lease.userId, sessionId: source.sessionId, turnId: source.turnId,
            rootTaskId: source.rootTaskId, parentTaskId: source.rootTaskId,
          }
          const bindings = await persistedScoutBindings(client, taskScope, loaded)
          if (!bindings) continue
          const current = currentTaskGraph(loaded)
          const currentByKey = new Map(current.nodes.map(node => [node.key, node] as const))
          const candidates = [...loaded.snapshot.nodes].sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0)
          let selection
          for (const node of candidates) {
            const task = loaded.tasks.get(node.taskId)
            const selected = selectOrdinaryHistoricalScout(node, currentByKey.get(node.key), task, bindings.get(node.taskId))
            if (selected) { selection = selected; break }
          }
          if (!selection) continue
          const terminal = await terminalReceiptBinding(client, input, source)
          if (!terminal) continue
          const binding: HistoricalDiscoveryTokenBinding = {
            current: {
              userId: scope.userId, sessionId: scope.sessionId, turnId: scope.turnId, rootTaskId: scope.rootTaskId,
              turnLeaseOwner: scope.turnLeaseOwner, turnLeaseVersion: scope.turnLeaseVersion,
              parentLeaseOwner: scope.parentLeaseOwner, rootAttemptCount: scope.parentAttemptCount,
            },
            objectiveDigest: fence.objectiveDigest,
            source: {
              sessionId: source.sessionId, turnId: source.turnId, rootTaskId: source.rootTaskId,
              terminalSequence: String(source.terminalSequence), terminalStatus: terminal.status,
              terminalReceiptDigest: terminal.digest,
              graphRevision: loaded.item.revision, nodeKey: selection.nodeKey, taskId: selection.taskId,
              attemptCount: selection.attemptCount, sourceResultStatus: selection.sourceResultStatus,
              resultIdsDigest: selection.resultIdsDigest,
            },
          }
          return parseTaskGraphHistoricalDiscoveryPage(pageForHistoricalDiscoverySelection(selection, binding, request))
            ?? unavailableHistoricalDiscoveryPage("source_changed")
        }
        return unavailableHistoricalDiscoveryPage(request.sourceToken ? "source_changed" : "no_source")
      })
    },
  }
}
