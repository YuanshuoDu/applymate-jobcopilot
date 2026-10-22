import type pg from "pg"
import type { CanonicalTurnState } from "./canonical-turn-state.js"
import type { ExecutionOwnerFence, TurnExecutionOwnerFence } from "./execution-owner.js"
import type { TurnLease } from "./turns/lease.js"
import type { TurnEngineStore } from "./turns/turn-engine-types.js"
import type { TurnEngineCompletionGate } from "./turns/turn-execution-types.js"
import type { DurableWaitPort } from "./tools/coordination-types.js"
import type { TaskGraphCommandPort, TaskGraphExecutionScope } from "./subagents/task-graph-command-port.js"
import type { SubagentTaskRecord } from "./subagents/types.js"
import {
  createScheduledAutomationPipelineBridge,
  type ScheduledAutomationPipelineBridgeResult,
  type ScheduledAutomationPipelineBridgeScope,
  type ScheduledAutomationPersistedRoot,
  type ScheduledAutomationPersistedTask,
  type ScheduledAutomationPersistedTurn,
} from "./subagents/scheduled-automation-pipeline-bridge.js"
import { attachScheduledPipelineCompletion } from "./subagents/scheduled-pipeline-completion.js"
import { createScheduledAutomationPrepareContinuation } from "./subagents/scheduled-automation-prepare-bridge.js"
import {
  createScheduledPipelineCandidateStore,
  type ScheduledPipelineCandidate,
  type ScheduledPipelineCandidateStore,
} from "./subagents/scheduled-pipeline-candidate-store.js"
import { currentTaskGraph, loadTaskGraph } from "./subagents/task-graph-pg-state.js"
import { verifyCompletedTaskGraphNodeEvidence } from "./subagents/task-graph-pg-verification.js"
import { verifyScheduledPrepareTaskGraphEvidence, type ScheduledPrepareVerification } from "./subagents/scheduled-prepare-task-graph-verification.js"

type ScheduledPipelineBridge = (scope: ScheduledAutomationPipelineBridgeScope) => Promise<ScheduledAutomationPipelineBridgeResult>
type ScheduledPipelineStoreFactory = (input: {
  pool: Pick<pg.Pool, "connect">
  eventStore: Pick<TurnEngineStore, "appendEvent">
}) => ScheduledPipelineCandidateStore
type CandidateCompletionInput = Omit<Parameters<typeof attachScheduledPipelineCompletion>[0], "bridge" | "fetcher" | "stageCandidate">
  & { candidateStore: ScheduledPipelineCandidateStore; recoveredCandidate?: ScheduledPipelineCandidate; waitPort?: DurableWaitPort }

export type CanonicalTurnScheduledPipelineOptions = Readonly<{
  bridge?: ScheduledPipelineBridge
  fetcher?: typeof fetch
  candidateStoreFactory?: ScheduledPipelineStoreFactory
  commandPort?: TaskGraphCommandPort
}>

/** Collects the scheduled-only bridge, candidate, owner, and completion wiring for one canonical runtime. */
export function createCanonicalTurnScheduledPipeline(pool: pg.Pool, options: CanonicalTurnScheduledPipelineOptions = {}) {
  const bridge = options.bridge ?? createPersistedScheduledPipelineBridge(pool)
  return {
    bridge,
    createCandidateStore(eventStore: Pick<TurnEngineStore, "appendEvent">) {
      return options.candidateStoreFactory?.({ pool, eventStore }) ?? createScheduledPipelineCandidateStore(pool, eventStore)
    },
    owner(input: Readonly<{
      taskGraphPlanningEnabled: boolean
      state: Pick<CanonicalTurnState, "source" | "automationRunMode">
      lease: TurnLease
      root: Pick<SubagentTaskRecord, "id" | "attemptCount">
    }>): ScheduledAutomationPipelineBridgeScope | undefined {
      if (!input.taskGraphPlanningEnabled || input.state.source !== "automation" || input.state.automationRunMode !== "scheduled") return undefined
      return {
        userId: input.lease.userId,
        sessionId: input.lease.sessionId,
        turnId: input.lease.turnId,
        rootTaskId: input.root.id,
        rootAttemptCount: input.root.attemptCount,
        turnLeaseOwnerId: input.lease.ownerId,
        turnLeaseVersion: input.lease.leaseVersion,
      }
    },
    readCandidate(input: Readonly<{
      store: ScheduledPipelineCandidateStore
      owner: ScheduledAutomationPipelineBridgeScope | undefined
      executionOwner: ExecutionOwnerFence
    }>): Promise<ScheduledPipelineCandidate | null | undefined> {
      return input.owner && input.executionOwner.kind === "turn"
        ? input.store.read({ owner: input.executionOwner, rootAttemptCount: input.owner.rootAttemptCount })
        : Promise.resolve(undefined)
    },
    attachCompletion(input: CandidateCompletionInput): TurnEngineCompletionGate | undefined {
      const { candidateStore, recoveredCandidate, waitPort, ...completion } = input
      const continueAfterAnalyze = completion.continueAfterAnalyze ?? (options.commandPort && waitPort
        ? createScheduledAutomationPrepareContinuation({ commandPort: options.commandPort, waitPort,
          verifyReadyPrepare: ({ scope, prepareTaskId, signal }) => verifyPersistedScheduledPrepare(pool, scope, prepareTaskId, signal) }) : undefined)
      return attachScheduledPipelineCompletion({
        ...completion,
        bridge,
        ...(recoveredCandidate ? { recoveredCandidate } : {}),
        ...(continueAfterAnalyze ? { continueAfterAnalyze } : {}),
        ...(options.fetcher ? { fetcher: options.fetcher } : {}),
        stageCandidate: candidateStore.stage,
      })
    },
  }
}

async function verifyPersistedScheduledPrepare(pool: Pick<pg.Pool, "connect">,
  scope: TaskGraphExecutionScope, prepareTaskId: string, signal: AbortSignal): Promise<ScheduledPrepareVerification> {
  if (signal.aborted) throw signal.reason ?? new Error("scheduled_prepare_verification_cancelled")
  return withScheduledPipelineRead(pool, scope.userId, async client => {
    const loaded = await loadTaskGraph(client, { userId: scope.userId, sessionId: scope.sessionId, turnId: scope.turnId,
      rootTaskId: scope.rootTaskId, parentTaskId: scope.rootTaskId }, false)
    const snapshot = loaded.snapshot, state = loaded.state, task = loaded.tasks.get(prepareTaskId)
    const node = snapshot?.nodes.find(candidate => candidate.key === "prepare")
    const envelope = taskEnvelope(task?.result)
    if (!snapshot || !state || !node || node.taskId !== prepareTaskId || !task?.attemptCount || !envelope) {
      return { verified: false, reasonCode: "scheduled_prepare_graph_invalid" }
    }
    const current = currentTaskGraph(loaded)
    const result = await verifyScheduledPrepareTaskGraphEvidence(client, {
      scope: { userId: scope.userId, sessionId: scope.sessionId, turnId: scope.turnId, rootTaskId: scope.rootTaskId,
        parentTaskId: scope.rootTaskId, taskId: prepareTaskId, attemptCount: task.attemptCount },
      snapshot, current, tasks: loaded.tasks, structuredResult: envelope.structuredResult,
      referenceVerificationMode: { phase: "persisted_gate" },
      completionGraphRevision: current.revision,
    })
    if (signal.aborted) throw signal.reason ?? new Error("scheduled_prepare_verification_cancelled")
    return result
  })
}

function taskEnvelope(value: unknown): Record<string, unknown> | null {
  const row = parseJsonRecord(value)
  if (!row || row.status !== "completed" || !Object.hasOwn(row, "structuredResult")) return null
  return row
}

function parseJsonRecord(value: unknown): Record<string, unknown> | null {
  const parsed = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown } catch { return null } })() : value
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
  const prototype = Object.getPrototypeOf(parsed)
  return prototype === Object.prototype || prototype === null ? parsed as Record<string, unknown> : null
}

function createPersistedScheduledPipelineBridge(pool: pg.Pool) {
  return createScheduledAutomationPipelineBridge({
    load: scope => withScheduledPipelineRead(pool, scope.userId, async client => {
      const turn = (await client.query<ScheduledAutomationPersistedTurn>(`SELECT "userId", "sessionId", "id" AS "turnId", "rootTaskId", "source", "executionMode", "input", "status", "leaseOwnerId", "leaseVersion", "leaseExpiresAt" FROM "agent_turns" WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3`, [scope.turnId, scope.sessionId, scope.userId])).rows[0]
      const root = (await client.query<ScheduledAutomationPersistedRoot>(`SELECT task."id", session."userId" AS "userId", task."sessionId", task."turnId", task."status", task."attemptCount" FROM "sub_agent_tasks" task JOIN "agent_sessions" session ON session."id" = task."sessionId" WHERE task."id" = $1 AND task."sessionId" = $2 AND task."turnId" = $3 AND task."rootTaskId" = $1 AND task."parentTaskId" IS NULL AND session."userId" = $4`, [scope.rootTaskId, scope.sessionId, scope.turnId, scope.userId])).rows[0]
      if (!turn || !root) throw new Error("scheduled_pipeline_lineage_missing")
      const graph = await loadTaskGraph(client, { userId: scope.userId, sessionId: scope.sessionId, turnId: scope.turnId, rootTaskId: scope.rootTaskId, parentTaskId: scope.rootTaskId }, false)
      if (!graph.snapshot || !graph.state) throw new Error("scheduled_pipeline_graph_missing")
      const tasks = (await client.query<ScheduledAutomationPersistedTask>(`SELECT task."id", session."userId" AS "userId", task."sessionId", task."turnId", task."rootTaskId", task."parentTaskId", task."role", task."taskType", task."status", task."attemptCount", task."failureReason", task."expectedOutputSchema", task."allowedActions", task."result" FROM "sub_agent_tasks" task JOIN "agent_sessions" session ON session."id" = task."sessionId" WHERE task."id" = ANY($1::text[]) AND task."sessionId" = $2 AND task."turnId" = $3 AND task."rootTaskId" = $4 AND task."parentTaskId" = $4 AND session."userId" = $5`, [graph.snapshot.nodes.map(node => node.taskId), scope.sessionId, scope.turnId, scope.rootTaskId, scope.userId])).rows
      return { turn, root, snapshot: graph.snapshot, current: currentTaskGraph(graph), tasks }
    }),
    verifyCompletedNode: input => withScheduledPipelineRead(pool, input.scope.userId, client => verifyCompletedTaskGraphNodeEvidence(client, input)),
  })
}

async function withScheduledPipelineRead<T>(pool: Pick<pg.Pool, "connect">, userId: string, work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  let committed = false
  try {
    await client.query("BEGIN")
    await client.query("SELECT set_config($1, $2, true)", ["app.user_id", userId])
    const value = await work(client)
    await client.query("COMMIT")
    committed = true
    return value
  } catch (error: unknown) {
    if (!committed) await client.query("ROLLBACK").catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}
