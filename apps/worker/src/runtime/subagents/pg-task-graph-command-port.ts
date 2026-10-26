import type { PoolClient } from "pg"
import { TaskGraphCommandError, type TaskGraphCommandPort, type TaskGraphScheduleInput, type TaskGraphScheduledPrepareInput, type TaskGraphScheduledPrepareReceipt, type TaskGraphScheduleReceipt, type TaskGraphReadScope, type TaskGraphExecutionScope, type TaskGraphCurrentState, type TaskGraphPlanningCurrentState, type TaskGraphNativeCommandInput, type TaskGraphNativeCommandReceipt } from "./task-graph-command-port.js"
import type { PgSubagentPool } from "./types.js"
import { transaction, type Queryable } from "./pg-store-persistence.js"
import { lockTaskGraphScope, loadTaskGraph, currentTaskGraph } from "./task-graph-pg-state.js"
import { buildTaskGraphPlanningFacts } from "./task-graph-planning-facts.js"
import { taskGraphItemId } from "./task-graph-snapshot.js"
import { normalizeNativeCommand } from "./task-graph-native-request.js"
import { appendNativeGraphCommand, findNativeCommandReplay } from "./task-graph-native-pg.js"
import { replaceUnstartedNativeFollowup } from "./task-graph-native-pending-replacement.js"
import { prepareSteeringReconciliation, writeSteeringReconciliationReceipt } from "./steering-reconciliation-ledger.js"
import type { TaskGraphResultPageRequest } from "./task-graph-result-page-contract.js"
import type { TaskGraphHistoricalDiscoveryPageRequest } from "./task-graph-historical-discovery-page-contract.js"
import type { TaskGraphDiscoveryRecoveryPageRequest } from "./task-graph-discovery-recovery-page-contract.js"
import { projectTaskGraphDiscoveryRecoveryPage } from "./task-graph-discovery-recovery-page.js"
import { projectTaskGraphResultPage } from "./task-graph-result-page.js"
import { createPgRootTaskHistoryResultPageStore } from "../context/root-task-history-result-page-store.js"
import { requireRootPlanCriteriaReadback } from "./root-plan-criteria.js"
import { appendScheduledPrepare as appendScheduledPrepareCommand } from "./pg-scheduled-task-graph-prepare-command.js"
import { appendScheduledGate as appendScheduledGateCommand } from "./pg-scheduled-task-graph-gate-command.js"
import { resumeScheduledGateChoice as resumeScheduledGateChoiceCommand } from "./pg-scheduled-task-graph-gate-resume.js"
import { appendScheduledAudit as appendScheduledAuditCommand,
  verifyScheduledAuditCompletion as verifyScheduledAuditCompletionCommand,
  readScheduledAuditInvocationProof as readScheduledAuditInvocationProofCommand,
  verifyScheduledGateCompletionWithAuditReplay as verifyScheduledGateCompletionCommand } from "./pg-scheduled-task-graph-audit-command.js"
import { readScheduledAuditResumeContext as readScheduledAuditResumeContextCommand } from "./scheduled-audit-resume.js"
import { hasPersistedPlanReceipt, scheduleTaskGraph } from "./pg-task-graph-command-port-schedule.js"
type Row = Record<string, unknown>
type LoadedCurrentGraph = Awaited<ReturnType<typeof loadTaskGraph>> & Readonly<{ rootSuccessCriteria?: readonly string[] }>
export function createPgTaskGraphCommandPort(pool: PgSubagentPool): TaskGraphCommandPort {
  const historicalDiscoveryPageStore = createPgRootTaskHistoryResultPageStore(pool)
  return {
    async appendAndSchedule(input: TaskGraphScheduleInput): Promise<TaskGraphScheduleReceipt> {
      return transaction(pool, client => scheduleTaskGraph(client, input))
    },
    async appendScheduledPrepare(input: TaskGraphScheduledPrepareInput): Promise<TaskGraphScheduledPrepareReceipt> {
      return transaction(pool, client => appendScheduledPrepareCommand(client, input))
    },
    async appendScheduledGate(input) {
      return transaction(pool, client => appendScheduledGateCommand(client, input))
    },
    async resumeScheduledGateChoice(input) {
      return transaction(pool, client => resumeScheduledGateChoiceCommand(client, input))
    },
    async verifyScheduledGateCompletion(input) {
      return transaction(pool, client => verifyScheduledGateCompletionCommand(client, input))
    },
    async appendScheduledAudit(input) {
      return transaction(pool, client => appendScheduledAuditCommand(client, input))
    },
    async verifyScheduledAuditCompletion(input) {
      return transaction(pool, client => verifyScheduledAuditCompletionCommand(client, input))
    },
    async readScheduledAuditInvocationProof(input) {
      return transaction(pool, client => readScheduledAuditInvocationProofCommand(client, input))
    },
    async readScheduledAuditResumeContext(input) {
      return transaction(pool, client => readScheduledAuditResumeContextCommand(client, input))
    },
    async appendAndScheduleWithReconciliation(input, operation) {
      return transaction(pool, client => scheduleTaskGraph(client, input, operation))
    },
    async reconcileSteering(operation) {
      if (operation.decision !== "keep") throw new TaskGraphCommandError("steering_reconciliation_operation_invalid", "Keep reconciliation scope is invalid")
      return transaction(pool, async client => {
        await client.query(`SELECT set_config('app.user_id', $1, true)`, [operation.scope.userId])
        await lockTaskGraphScope(client, operation.scope, true)
        const prepared = await prepareSteeringReconciliation(client, operation)
        if (prepared) await writeSteeringReconciliationReceipt(client, prepared, operation.expectedRevision)
        return { decision: "keep", revision: operation.expectedRevision, reconciledInputCount: prepared?.steerInputIds.length ?? 0 }
      })
    },
    async appendNativeCoordination(input: TaskGraphNativeCommandInput): Promise<TaskGraphNativeCommandReceipt> {
      const command = normalizeNativeCommand(input)
      return transaction(pool, async client => {
        await client.query(`SELECT set_config('app.user_id', $1, true)`, [input.scope.userId])
        const parent = await lockTaskGraphScope(client, input.scope, true)
        if (await hasPersistedPlanReceipt(client, input.scope) && !await hasCurrentGraphItem(client, input.scope)) {
          throw new TaskGraphCommandError("task_graph_state_missing", "Persisted TaskGraph state is unavailable")
        }
        const replay = await findNativeCommandReplay(client, input, command)
        if (replay) return replay
        const loaded = await loadTaskGraph(client, input.scope)
        if (!loaded.item && await hasPersistedPlanReceipt(client, input.scope)) {
          throw new TaskGraphCommandError("task_graph_state_missing", "Persisted TaskGraph state is unavailable")
        }
        currentTaskGraph(loaded)
        const preservingLoadedPin = loaded.snapshot?.rootSuccessCriteria && loaded.state ? { ...loaded, state: { ...loaded.state, rootSuccessCriteria: loaded.snapshot.rootSuccessCriteria } } : loaded
        if (command.request.kind === "followup" && "mode" in command.request && command.request.mode === "replace_unstarted") {
          return replaceUnstartedNativeFollowup(client, input, command, parent, preservingLoadedPin)
        }
        return appendNativeGraphCommand(client, input, command, parent, preservingLoadedPin)
      })
    },
    async readCurrent(scope: TaskGraphReadScope): Promise<TaskGraphCurrentState> {
      return transaction(pool, client => readCurrentWithClient(client, scope))
    },
    async readCurrentForPlanning(scope: TaskGraphReadScope): Promise<TaskGraphPlanningCurrentState> {
      return transaction(pool, client => readCurrentForPlanningWithClient(client, scope))
    },
    async readCurrentResultPage(scope, request) {
      return transaction(pool, client => readCurrentResultPageWithClient(client, scope, request))
    },
    async readHistoricalDiscoveryPage(scope: TaskGraphExecutionScope, request: TaskGraphHistoricalDiscoveryPageRequest) {
      return historicalDiscoveryPageStore.read(scope, request)
    },
    async readCurrentDiscoveryRecoveryPage(scope, request) {
      return transaction(pool, client => readCurrentDiscoveryRecoveryPageWithClient(client, scope, request))
    },
    readCurrentWithClient(client, scope) { return readCurrentWithClient(client, scope) },
    readCurrentForPlanningWithClient(client, scope) { return readCurrentForPlanningWithClient(client, scope) },
  }
}
async function readCurrentWithClient(client: Pick<PoolClient, "query">, scope: TaskGraphReadScope): Promise<TaskGraphCurrentState> {
  const loaded = await loadCurrentWithClient(client, scope)
  const current = currentTaskGraph(loaded)
  const planningFacts = buildTaskGraphPlanningFacts(loaded)
  return { ...current, ...(loaded.rootSuccessCriteria ? { rootSuccessCriteria: loaded.rootSuccessCriteria } : {}), ...(planningFacts ? { planningFacts } : {}) }
}
async function readCurrentForPlanningWithClient(
  client: Pick<PoolClient, "query">, scope: TaskGraphReadScope,
): Promise<TaskGraphPlanningCurrentState> {
  const loaded = await loadCurrentWithClient(client, scope, true)
  const current = currentTaskGraph(loaded), planningFacts = buildTaskGraphPlanningFacts(loaded)
  const sourceIntent = current.nodes.map(node => ({ nodeKey: node.key, goal: node.goal, successCriteria: node.successCriteria,
    inputRelation: loaded.sourceInputRelationByNodeKey?.get(node.key) ?? "unknown" as const }))
  return {
    current: { ...current, ...(loaded.rootSuccessCriteria ? { rootSuccessCriteria: loaded.rootSuccessCriteria } : {}), ...(planningFacts ? { planningFacts } : {}), sourceIntent },
    currentInputCheckpoint: loaded.currentInputCheckpoint ?? null,
  }
}
async function readCurrentResultPageWithClient(client: Pick<PoolClient, "query">, scope: TaskGraphReadScope, request: TaskGraphResultPageRequest) {
  const loaded = await loadCurrentWithClient(client, scope)
  currentTaskGraph(loaded)
  return projectTaskGraphResultPage(loaded, request)
}

async function readCurrentDiscoveryRecoveryPageWithClient(
  client: Pick<PoolClient, "query">,
  scope: TaskGraphReadScope,
  request: TaskGraphDiscoveryRecoveryPageRequest,
) {
  const loaded = await loadCurrentWithClient(client, scope)
  currentTaskGraph(loaded)
  return projectTaskGraphDiscoveryRecoveryPage(loaded, request)
}

async function loadCurrentWithClient(client: Pick<PoolClient, "query">, scope: TaskGraphReadScope, includeSourceProvenance = false): Promise<LoadedCurrentGraph> {
  await client.query(`SELECT set_config('app.user_id', $1, true)`, [scope.userId])
  const parent = await lockTaskGraphScope(client, scope)
  const loaded = await loadTaskGraph(client, scope, false, includeSourceProvenance
    ? { includeSourceProvenance: true, discoverCurrentStep: true } : {})
  if (!loaded.item && await hasPersistedPlanReceipt(client, scope)) {
    throw new TaskGraphCommandError("task_graph_state_missing", "Persisted TaskGraph state is unavailable")
  }
  currentTaskGraph(loaded)
  const criteria = requireRootPlanCriteriaReadback(parent.goal, parent.successCriteria, loaded.snapshot?.rootSuccessCriteria)
  return criteria ? { ...loaded, rootSuccessCriteria: criteria } : loaded
}
async function hasCurrentGraphItem(client: Queryable, scope: TaskGraphReadScope): Promise<boolean> {
  const result = await client.query(`SELECT EXISTS (
    SELECT 1 FROM "agent_items" AS item
    JOIN "agent_turns" AS turn ON turn."id" = item."turnId" AND turn."sessionId" = item."sessionId"
    JOIN "agent_sessions" AS session ON session."id" = item."sessionId"
    WHERE item."id" = $1 AND item."sessionId" = $2 AND item."turnId" = $3 AND item."taskId" = $4
      AND item."type" = 'task_graph' AND turn."userId" = $5 AND session."userId" = $5
  ) AS "exists"`, [taskGraphItemId(scope.parentTaskId), scope.sessionId, scope.turnId, scope.parentTaskId, scope.userId])
  return (result.rows[0] as Row | undefined)?.exists === true
}
