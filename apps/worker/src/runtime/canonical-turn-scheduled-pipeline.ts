import type pg from "pg"
import type { CanonicalTurnState } from "./canonical-turn-state.js"
import type { ExecutionOwnerFence, TurnExecutionOwnerFence } from "./execution-owner.js"
import type { TurnLease } from "./turns/lease.js"
import type { TurnEngineStore } from "./turns/turn-engine-types.js"
import type { TurnEngineCompletionGate } from "./turns/turn-execution-types.js"
import type { TurnQuestionStore } from "./turns/turn-question-contract.js"
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
import { createScheduledAutomationGateContinuation } from "./subagents/scheduled-automation-gate-bridge.js"
import { createScheduledAutomationPrepareContinuation } from "./subagents/scheduled-automation-prepare-bridge.js"
import { projectScheduledAnalyzePrefix } from "./subagents/scheduled-automation-prepare-bridge.js"
import {
  createScheduledPipelineCandidateStore,
  type ScheduledPipelineCandidate,
  type ScheduledPipelineCandidateStore,
} from "./subagents/scheduled-pipeline-candidate-store.js"
import { currentTaskGraph, loadTaskGraph, type GraphTaskRow } from "./subagents/task-graph-pg-state.js"
import { verifyCompletedTaskGraphNodeEvidence } from "./subagents/task-graph-pg-verification.js"
import { verifyScheduledPrepareTaskGraphEvidence, SCHEDULED_PREPARE_PROOF_FACTS_SCHEMA, type ScheduledPrepareVerification } from "./subagents/scheduled-prepare-task-graph-verification.js"
import { loadPersistedScheduledPrepareProof } from "./subagents/scheduled-gate-wait-match.js"
import { readScheduledGateRegistrationReceipt } from "./subagents/scheduled-gate-registration-receipt.js"
import { scheduledGateCheckpointEvidence } from "./subagents/scheduled-gate-contract.js"
import { parseScheduledTaskGraphContinuationReceipt, scheduledSnapshotMatches } from "./subagents/scheduled-taskgraph-continuation-receipt.js"
import { scheduledPrepareGateVerifierStage } from "./subagents/canonical-turn-scheduled-pipeline-context.js"

type ScheduledPipelineBridge = (scope: ScheduledAutomationPipelineBridgeScope) => Promise<ScheduledAutomationPipelineBridgeResult>
type ScheduledPipelineStoreFactory = (input: {
  pool: Pick<pg.Pool, "connect">
  eventStore: Pick<TurnEngineStore, "appendEvent">
}) => ScheduledPipelineCandidateStore
type CandidateCompletionInput = Omit<Parameters<typeof attachScheduledPipelineCompletion>[0], "bridge" | "fetcher" | "stageCandidate">
  & { candidateStore: ScheduledPipelineCandidateStore; recoveredCandidate?: ScheduledPipelineCandidate; waitPort?: DurableWaitPort;
    questionStore?: Pick<TurnQuestionStore, "readScheduledGateChoice">; nativeQuestionWaitEnabled?: boolean }

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
      const { candidateStore, recoveredCandidate, waitPort, questionStore, nativeQuestionWaitEnabled, ...completion } = input
      const continueAfterAnalyze = completion.continueAfterAnalyze ?? (options.commandPort && waitPort
        ? createScheduledAutomationPrepareContinuation({ commandPort: options.commandPort, waitPort,
          verifyReadyPrepare: ({ scope, prepareTaskId, signal }) => verifyPersistedScheduledPrepare(pool, scope, prepareTaskId, signal) }) : undefined)
      const continueAfterGate = completion.continueAfterGate ?? (options.commandPort && waitPort
        ? createScheduledAutomationGateContinuation({ pool, commandPort: options.commandPort, waitPort, questionStore,
          nativeQuestionWaitEnabled: nativeQuestionWaitEnabled === true, ...(options.fetcher ? { fetcher: options.fetcher } : {}) }) : undefined)
      return attachScheduledPipelineCompletion({
        ...completion,
        bridge,
        ...(recoveredCandidate ? { recoveredCandidate } : {}),
        ...(continueAfterAnalyze ? { continueAfterAnalyze } : {}),
        ...(continueAfterGate ? { continueAfterGate } : {}),
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
    const gateStage = scheduledPrepareGateVerifierStage(snapshot.nodes)
    if (gateStage) {
      const result = await verifyPersistedGatePrepare(client, scope, prepareTaskId, task, loaded)
      if (signal.aborted) throw signal.reason ?? new Error("scheduled_prepare_verification_cancelled")
      return result
    }
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

async function verifyPersistedGatePrepare(client: pg.PoolClient, scope: TaskGraphExecutionScope,
  prepareTaskId: string, prepareTask: GraphTaskRow,
  loaded: Awaited<ReturnType<typeof loadTaskGraph>>): Promise<ScheduledPrepareVerification> {
  const snapshot = loaded.snapshot, state = loaded.state
  const facts = parseJsonRecord(parseJsonRecord(prepareTask.result)?.taskGraphScheduledPrepareProofFacts)
  const prepareReceipt = parseScheduledTaskGraphContinuationReceipt(facts?.receipt)
  if (!snapshot || !state || !scheduledPrepareGateVerifierStage(snapshot.nodes)) {
    return { verified: false, reasonCode: "scheduled_prepare_graph_invalid" }
  }
  const lineage = await client.query<{ id: string; rootTaskId: string; parentTaskId: string }>(`SELECT task."id", task."rootTaskId", task."parentTaskId"
    FROM "sub_agent_tasks" AS task JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
    WHERE task."id" = ANY($1::text[]) AND task."sessionId" = $2 AND task."turnId" = $3 AND task."rootTaskId" = $4
      AND task."parentTaskId" = $4 AND session."userId" = $5`,
  [snapshot.nodes.map(node => node.taskId), scope.sessionId, scope.turnId, scope.rootTaskId, scope.userId])
  if (lineage.rows.length !== snapshot.nodes.length) return { verified: false, reasonCode: "scheduled_prepare_graph_invalid" }
  const tasks = snapshot.nodes.flatMap(node => {
    const task = loaded.tasks.get(node.taskId), identity = lineage.rows.find(row => row.id === node.taskId)
    return task && identity && task.taskType && Number.isSafeInteger(task.attemptCount)
      && task.expectedOutputSchema !== undefined && task.allowedActions !== undefined
      ? [{ id: task.id, role: task.role, taskType: task.taskType, status: task.status, attemptCount: task.attemptCount!,
        failureReason: task.failureReason, expectedOutputSchema: task.expectedOutputSchema, allowedActions: task.allowedActions,
        result: task.result, rootTaskId: identity.rootTaskId, parentTaskId: identity.parentTaskId }] : []
  })
  if (tasks.length !== snapshot.nodes.length || !projectScheduledAnalyzePrefix(snapshot, currentTaskGraph(loaded), tasks)) {
    return { verified: false, reasonCode: "scheduled_prepare_graph_invalid" }
  }
  const gate = snapshot.nodes.find(node => node.key === "gate")
  if (!facts || !prepareReceipt || !gate || prepareReceipt.owner.userId !== scope.userId
    || prepareReceipt.owner.sessionId !== scope.sessionId || prepareReceipt.owner.turnId !== scope.turnId
    || prepareReceipt.owner.rootTaskId !== scope.rootTaskId || prepareReceipt.owner.rootAttemptCount !== scope.parentAttemptCount) {
    return { verified: false, reasonCode: "scheduled_prepare_gate_receipt_invalid" }
  }
  const owner = { userId: prepareReceipt.owner.userId, sessionId: prepareReceipt.owner.sessionId, turnId: prepareReceipt.owner.turnId,
    rootTaskId: prepareReceipt.owner.rootTaskId, rootAttemptCount: prepareReceipt.owner.rootAttemptCount,
    executionId: prepareReceipt.owner.executionId, executionAttemptCount: prepareReceipt.owner.executionAttemptCount }
  const receipt = await readScheduledGateRegistrationReceipt(client, { userId: scope.userId, sessionId: scope.sessionId,
    turnId: scope.turnId, owner, gateTaskId: gate.taskId })
  if (!receipt || receipt.continuationKey !== prepareReceipt.continuationKey || receipt.snapshotDigest !== prepareReceipt.snapshotDigest
    || receipt.evidenceDigest !== prepareReceipt.evidenceDigest || receipt.checkpointDigest !== prepareReceipt.checkpointDigest
    || receipt.analyzeGraphRevision !== prepareReceipt.analyzeGraphRevision
    || receipt.prepareScheduleRevision !== prepareReceipt.prepareScheduleRevision) {
    return { verified: false, reasonCode: "scheduled_prepare_gate_receipt_invalid" }
  }
  const execution = await client.query<{ id: string; attemptCount: number; status: string; state: unknown; source: string; executionMode: string; input: unknown }>(`SELECT execution."id", execution."attemptCount", execution."status", execution."state",
      turn."source", turn."executionMode", turn."input"
    FROM "agent_executions" AS execution JOIN "agent_turns" AS turn ON turn."sessionId" = execution."sessionId" AND turn."userId" = execution."userId"
    WHERE execution."id" = $1 AND execution."sessionId" = $2 AND execution."userId" = $3 AND turn."id" = $4`,
  [prepareReceipt.owner.executionId, scope.sessionId, scope.userId, scope.turnId])
  const executionRow = execution.rows[0], evidence = executionRow && scheduledGateCheckpointEvidence(executionRow.state)
  if (execution.rows.length !== 1 || !executionRow || executionRow.attemptCount !== prepareReceipt.owner.executionAttemptCount
    || !["running", "waiting_for_user"].includes(executionRow.status) || !evidence
    || !scheduledSnapshotMatches(executionRow, prepareReceipt.snapshotDigest)) return { verified: false, reasonCode: "scheduled_prepare_gate_receipt_invalid" }
  const proof = await loadPersistedScheduledPrepareProof(client, { userId: scope.userId, sessionId: scope.sessionId,
    turnId: scope.turnId, rootTaskId: scope.rootTaskId }, prepareTaskId, prepareTask.result, receipt.continuationKey, receipt.prepareWaitId)
  if (!proof || !evidence || receipt.prepareWaitId !== proof.completion.wait.waitId
    || receipt.prepareScheduleRevision !== proof.receipt.prepareScheduleRevision
    || receipt.gateAppendRevision <= proof.completion.graphRevision || receipt.gateAppendRevision > state.revision
    || receipt.continuationKey !== evidence.continuationKey || receipt.snapshotDigest !== evidence.snapshotDigest
    || receipt.evidenceDigest !== evidence.evidenceDigest || receipt.checkpointDigest !== evidence.checkpointDigest
    || receipt.analyzeGraphRevision !== evidence.analyzeGraphRevision) {
    return { verified: false, reasonCode: "scheduled_prepare_gate_receipt_invalid" }
  }
  const { wait: _wait, ...completion } = proof.completion
  return { verified: true, facts: { schemaVersion: SCHEDULED_PREPARE_PROOF_FACTS_SCHEMA,
    receipt: proof.receipt, completion, result: proof.result } }
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
