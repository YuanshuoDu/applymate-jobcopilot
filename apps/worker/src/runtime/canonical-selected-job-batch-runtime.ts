import type { PoolClient } from "pg"
import type { VerifiedShortlistSelectionBinding } from "@jobcopilot/agent-protocol"

import { verifyCanonicalSelectedJobBatchCompletion } from "./canonical-selected-job-batch-completion.js"
import { TASK_GRAPH_FINAL_SUMMARY_BINDING } from "./subagents/task-graph-final-summary-binding.js"
import { attachSelectedJobBatchFinalOutcome } from "./subagents/selected-job-batch-final-outcome.js"
import type { TaskGraphCommandPort } from "./subagents/task-graph-command-port.js"
import type { SubagentTaskRecord } from "./subagents/types.js"
import type { RootTaskStore } from "./subagents/root-task-store.js"
import type { SelectedJobBatchCompletionWitness } from "./multi-selected-job-completion-gate.js"
import { TASK_GRAPH_FEEDBACK, TASK_GRAPH_VERIFICATION_BLOCKER } from "./turns/turn-execution-terminal-decision.js"
import type { TurnEngineCompletionGateResult } from "./turns/turn-execution-types.js"
import { transaction } from "./turns/lease-transaction.js"
import type { TurnLease } from "./turns/lease.js"
import type { CanonicalTurnState } from "./canonical-turn-state.js"

type CompletionReader = Readonly<{ checkCompletion: NonNullable<RootTaskStore["checkCompletion"]> }>
type SelectedJobBatchSetup = Readonly<{ binding: VerifiedShortlistSelectionBinding }>
type BatchCompletionInput = Readonly<{
  pool: Parameters<typeof transaction>[0]
  lease: TurnLease
  root: Pick<SubagentTaskRecord, "id" | "attemptCount">
  binding: VerifiedShortlistSelectionBinding
  commandPort: TaskGraphCommandPort | undefined
  rootTasks: CompletionReader
  now: () => Date
}>

/** Keeps the verified batch graph and artifact proof on the same candidate and final-commit clients. */
export function createCanonicalSelectedJobBatchRuntime(input: BatchCompletionInput): Readonly<{
  clear(): void
  checkCandidate(nativeVerificationPassed: boolean): Promise<TurnEngineCompletionGateResult>
  checkTerminal(client: PoolClient, nativeVerificationPassed: boolean): Promise<TurnEngineCompletionGateResult>
}> {
  let acceptedWitness: SelectedJobBatchCompletionWitness | undefined
  return {
    clear() { acceptedWitness = undefined },
    async checkCandidate(nativeVerificationPassed) {
      acceptedWitness = undefined
      const checked = await transaction(input.pool, input.lease.userId,
        client => checkInTransaction(client, nativeVerificationPassed))
      acceptedWitness = checked.witness
      return checked.result
    },
    async checkTerminal(client, nativeVerificationPassed) {
      if (!acceptedWitness) return deny("accepted candidate proof is unavailable")
      return (await checkInTransaction(client, nativeVerificationPassed, acceptedWitness)).result
    },
  }

  async function checkInTransaction(
    client: PoolClient,
    nativeVerificationPassed: boolean,
    expectedWitness?: typeof acceptedWitness,
  ): Promise<Readonly<{ result: TurnEngineCompletionGateResult; witness?: SelectedJobBatchCompletionWitness }>> {
    const graph = await input.rootTasks.checkCompletion({ lease: input.lease, rootTaskId: input.root.id,
      now: input.now(), taskGraphVerification: true, nativeVerificationPassed, client, requireTaskGraph: true })
    if (!graph.ok) return { result: graph }
    const result = await verifyCanonicalSelectedJobBatchCompletion({
      client, lease: input.lease, rootTaskId: input.root.id, binding: input.binding,
      commandPort: input.commandPort, ...(expectedWitness ? { acceptedWitness: expectedWitness } : {}),
    })
    if (result.status !== "ready") return { result: deny(result.status) }
    const binding = graph[TASK_GRAPH_FINAL_SUMMARY_BINDING]
    const enriched = binding && attachSelectedJobBatchFinalOutcome(binding, result.witness)
    if (!enriched) return { result: deny("TaskGraph final summary is unavailable") }
    return { result: { ok: true, [TASK_GRAPH_FINAL_SUMMARY_BINDING]: enriched },
      ...(!expectedWitness ? { witness: result.witness } : {}) }
  }
}

/** Prepares the batch-scoped Root state and its completion verifier as one runtime seam. */
export function prepareCanonicalSelectedJobBatchRuntime(input: Readonly<{
  pool: Parameters<typeof transaction>[0]
  lease: TurnLease
  root: Pick<SubagentTaskRecord, "id" | "attemptCount">
  state: CanonicalTurnState
  selectedJobBatch?: SelectedJobBatchSetup
  commandPort?: TaskGraphCommandPort
  rootTasks: RootTaskStore
  now: () => Date
}>): Readonly<{ state: CanonicalTurnState; runtime?: ReturnType<typeof createCanonicalSelectedJobBatchRuntime> }> {
  if (!input.selectedJobBatch) return { state: input.state }
  const checkCompletion = input.rootTasks.checkCompletion
  if (!checkCompletion) throw new Error("selected_job_batch_completion_unavailable")
  return {
    state: scopeSelectedJobBatchRootState(input.state, input.selectedJobBatch.binding.selectedJobIds),
    runtime: createCanonicalSelectedJobBatchRuntime({ pool: input.pool, lease: input.lease, root: input.root,
      binding: input.selectedJobBatch.binding, commandPort: input.commandPort, rootTasks: { checkCompletion }, now: input.now }),
  }
}

/** Keeps the Root's recovered/fresh business context inside the server-selected Job set. */
export function scopeSelectedJobBatchRootState(state: CanonicalTurnState, selectedJobIds: readonly string[]): CanonicalTurnState {
  const selected = new Set(selectedJobIds)
  return { ...state, snapshot: { ...state.snapshot, businessRefs: state.snapshot.businessRefs.filter(reference =>
    (reference.kind !== "job" && reference.kind !== "jd") || selected.has(reference.id)) } }
}

function deny(reason: string): TurnEngineCompletionGateResult {
  return { ok: false, blocker: TASK_GRAPH_VERIFICATION_BLOCKER, feedback: `${TASK_GRAPH_FEEDBACK} Selected Job batch proof ${reason}.` }
}
