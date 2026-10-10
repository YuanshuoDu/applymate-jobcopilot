import type pg from "pg"
import type { PoolClient } from "pg"
import type { TurnEngineTerminalGuard } from "./turns/turn-engine-terminal-commit.js"
import { createPgNativeVerificationPort } from "./subagents/pg-native-verification-port.js"
import { readNativeVerificationTerminalProofWithClient } from "./subagents/native-verification-pg-readback.js"
import type { NativeVerificationPort, NativeVerificationRootGoalWitness, NativeVerificationTerminalProofReader } from "./subagents/native-verification-port.js"
import type { TaskGraphExecutionScope, TaskGraphReadScope } from "./subagents/task-graph-command-port.js"
import type { DurableWaitPort } from "./tools/coordination-types.js"
import { RESET_NATIVE_SEMANTIC_PROGRESS, type TurnEngineCompletionGate, type TurnEngineCompletionGateResult } from "./turns/turn-execution-types.js"
import type { StepContextSnapshot } from "./context/step-context-builder.js"
import type { CanonicalTurnState } from "./canonical-turn-state.js"
import { selectedJobSnapshot } from "./canonical-turn-task-graph-context.js"
import { runTurnBoundaryCompactionPreflight } from "./context/turn-boundary-compaction-preflight.js"
import { withNativeVerificationFeedback } from "./canonical-turn-native-verification-snapshot.js"
import type { NativeVerificationRecovery } from "./canonical-turn-native-verification-recovery.js"
import { nativeVerificationCompletionGate } from "./canonical-turn-native-verification.js"
import { createNativeSemanticProgressTracker } from "./native-semantic-progress.js"
import { createNativeSemanticRejectionObserver, type NativeSemanticProgressConfiguration } from "./canonical-turn-native-semantic-rejection.js"
import { waitForNativeVerification } from "./canonical-turn-native-verification-wait.js"
import { readNativeVerificationRecovery } from "./canonical-turn-native-verification-recovery.js"
import { persistedFinalCandidate } from "./turns/turn-execution-final-candidate.js"
import { TASK_GRAPH_VERIFICATION_BLOCKER } from "./turns/turn-execution-completion-gate.js"
import { createAgentArtifactRepository, type AgentArtifactDraftHead, type AgentArtifactDraftHeadScope } from "../db/agent-artifact-repo.js"
import { loadSelectedJobArtifactContext } from "./subagents/selected-job-artifact-context.js"
import { selectedJobArtifactCompletionGateWithWitness, type SelectedJobCompletionGraphWitness, type SelectedJobArtifactCompletionGateWithWitnessResult } from "./selected-job-completion-gate.js"
import type { TaskGraphCommandPort } from "./subagents/task-graph-command-port.js"
import { hasPendingSteerOrInvalidResult, hasUnresolvedPlanningSteering } from "./canonical-turn-steering-reconciliation.js"
import { STEERING_RECONCILIATION_BLOCKER, STEERING_RECONCILIATION_FEEDBACK } from "./subagents/steering-reconciliation-contract.js"
import type { TurnLease } from "./turns/lease.js"
import type { SubagentTaskRecord } from "./subagents/types.js"
import { TASK_GRAPH_FINAL_SUMMARY_BINDING } from "./subagents/task-graph-final-summary-binding.js"
import { taskGraphFinalSummaryCopiesMatch } from "./finalizer.js"
import type { AtomicTurnCompletionInput } from "./turns/turn-engine-types.js"

export type NativeVerificationRuntime = Readonly<{
  port: NativeVerificationPort
  readTerminalProof: NativeVerificationTerminalProofReader
}>
type Coordination = Readonly<{
  readScope(): TaskGraphReadScope
  executionScope(stepId: string): TaskGraphExecutionScope
  hasNativeTasks(): Promise<boolean>
  checkNativeGraphCompletion(): Promise<TurnEngineCompletionGateResult | null>
}>
export type NativeVerificationTerminalCheck = Readonly<{
  nativeVerificationPassed: boolean
  denial?: TurnEngineCompletionGateResult
}>

/** Preserves the selected-job artifact gate as a server-owned sibling completion path. */
export function createCanonicalSelectedJobCompletion(input: Readonly<{
  pool: pg.Pool
  commandPort?: TaskGraphCommandPort
  lease: TurnLease
  root: Pick<SubagentTaskRecord, "id" | "attemptCount">
  selectedJobId?: string
  artifactRepository: ReturnType<typeof createAgentArtifactRepository>
  draftHeadReader?: (scope: AgentArtifactDraftHeadScope) => Promise<AgentArtifactDraftHead | null>
  sourceDigestLoader?: (userId: string, jobId: string) => Promise<string | null>
  accept(witness: SelectedJobCompletionGraphWitness): void
}>): () => Promise<SelectedJobArtifactCompletionGateWithWitnessResult> {
  return async () => {
    const result = await selectedJobArtifactCompletionGateWithWitness({
      commandPort: input.commandPort, lease: input.lease, root: input.root, selectedJobId: input.selectedJobId,
      readCurrentDraftHead: input.draftHeadReader ?? (scope => input.artifactRepository.findCurrentDraftHead(scope)),
      readCurrentReviewReceipt: scope => input.artifactRepository.findReviewReceipt(scope),
      readCurrentSourceDigest: async () => {
        const jobId = input.selectedJobId
        if (!jobId) return null
        if (input.sourceDigestLoader) return input.sourceDigestLoader(input.lease.userId, jobId)
        const currentSources = await loadSelectedJobArtifactContext(input.pool, input.lease.userId, jobId)
        return currentSources.preparation.sourceDigest
      },
    })
    if (result.ok) input.accept(result.witness)
    return result
  }
}

/** Composes the native proof with existing root-graph and selected-job terminal guards. */
export function createCanonicalTurnTerminalGuard(input: Readonly<{
  enabled: boolean
  nativeVerification: Pick<ReturnType<typeof createCanonicalNativeVerificationRuntime>, "checkTerminal">
  checkRootGraph?: (client: PoolClient, nativeVerificationPassed: boolean) => Promise<TurnEngineCompletionGateResult | undefined>
  finalizeSelectedJob?: (client: PoolClient) => Promise<TurnEngineCompletionGateResult>
}>): TurnEngineTerminalGuard | undefined {
  if (!input.enabled) return undefined
  return async (client, terminal: AtomicTurnCompletionInput & Readonly<{ response: string }>) => {
    const native = await input.nativeVerification.checkTerminal(client, terminal)
    if (native.denial) return native.denial
    const graph = input.checkRootGraph ? await input.checkRootGraph(client, native.nativeVerificationPassed) : undefined
    if (input.checkRootGraph && !graph) return { ok: false, blocker: TASK_GRAPH_VERIFICATION_BLOCKER, feedback: "TaskGraph completion verification is unavailable." }
    if (graph && !graph.ok) return graph
    if (!taskGraphFinalSummaryCopiesMatch(terminal[TASK_GRAPH_FINAL_SUMMARY_BINDING], graph?.[TASK_GRAPH_FINAL_SUMMARY_BINDING], terminal.finalContent, terminal.response)) return {
      ok: false, blocker: TASK_GRAPH_VERIFICATION_BLOCKER, feedback: "TaskGraph final summary is stale or unavailable. Re-read the current graph before completing.",
    }
    return input.finalizeSelectedJob ? input.finalizeSelectedJob(client) : { ok: true }
  }
}

/** Preserves the native receipt/proof gate ahead of existing root and mode-specific gates. */
export function createCanonicalRootCompletionGate(input: Readonly<{
  enabled: boolean
  nativeVerification: Pick<ReturnType<typeof createCanonicalNativeVerificationRuntime>, "checkCompletion" | "accepted">
    & Partial<Pick<ReturnType<typeof createCanonicalNativeVerificationRuntime>, "resetSemanticProgress">>
  onCandidateStart(): void
  checkChildren(): Promise<TurnEngineCompletionGateResult | undefined> | TurnEngineCompletionGateResult | undefined
  interactiveDiscovery?: () => Promise<TurnEngineCompletionGateResult>
  selectedJobMode: boolean
  selectedJobCompletion?: () => Promise<TurnEngineCompletionGateResult>
}>): TurnEngineCompletionGate | undefined {
  if (!input.enabled) return undefined
  const gate: TurnEngineCompletionGate = async ({ stepId, candidateText }) => {
    input.onCandidateStart()
    const native = await input.nativeVerification.checkCompletion(stepId, candidateText)
    if (native) return native
    const children = await input.checkChildren()
    if (children && !children.ok) return children
    const carryGraphSummary = (result: TurnEngineCompletionGateResult) => result.ok && children?.ok && children[TASK_GRAPH_FINAL_SUMMARY_BINDING]
      ? { ...result, [TASK_GRAPH_FINAL_SUMMARY_BINDING]: children[TASK_GRAPH_FINAL_SUMMARY_BINDING] } : result
    if (input.interactiveDiscovery) return carryGraphSummary(await input.interactiveDiscovery())
    if (!input.selectedJobMode) return children ?? { ok: true }
    return carryGraphSummary(input.selectedJobCompletion ? await input.selectedJobCompletion() : {
      ok: false, blocker: "selected_job_draft_review_required", feedback: "Selected-job completion verification is unavailable.",
    })
  }
  if (input.nativeVerification.resetSemanticProgress) gate[RESET_NATIVE_SEMANTIC_PROGRESS] = input.nativeVerification.resetSemanticProgress
  return gate
}

export async function loadNativeVerificationRootContext(input: Readonly<{
  state: CanonicalTurnState
  selectedJobMode: boolean
  taskGraphPlanningEnabled: boolean
  nativeVerification: Pick<ReturnType<typeof createCanonicalNativeVerificationRuntime>, "recover">
  refreshTaskGraph(snapshot: StepContextSnapshot): Promise<StepContextSnapshot>
}>): Promise<Readonly<{ initialModelSnapshot: StepContextSnapshot; nativeRecovery: NativeVerificationRecovery }>> {
  const initialSnapshot = input.selectedJobMode ? selectedJobSnapshot(input.state.snapshot) : input.state.snapshot
  return {
    initialModelSnapshot: input.taskGraphPlanningEnabled ? await input.refreshTaskGraph(initialSnapshot) : initialSnapshot,
    nativeRecovery: await input.nativeVerification.recover(),
  }
}

/** Applies compaction while retaining graph context and only a server-owned candidate. */
export async function prepareNativeVerificationRootContext(input: Readonly<{
  state: CanonicalTurnState
  selectedJobMode: boolean
  taskGraphPlanningEnabled: boolean
  initialModelSnapshot: StepContextSnapshot
  nativeRecovery: NativeVerificationRecovery
  refreshTaskGraph(snapshot: StepContextSnapshot): Promise<StepContextSnapshot>
  preflight: Omit<Parameters<typeof runTurnBoundaryCompactionPreflight<CanonicalTurnState>>[0], "state">
}>): Promise<Readonly<{ state: CanonicalTurnState; nativeRecovery: NativeVerificationRecovery; modelSnapshot: StepContextSnapshot }>> {
  const selectSnapshot = (state: CanonicalTurnState) => input.selectedJobMode ? selectedJobSnapshot(state.snapshot) : state.snapshot
  const preflight = input.nativeRecovery.candidateText !== undefined ? { state: input.state, compacted: false }
    : await runTurnBoundaryCompactionPreflight<CanonicalTurnState>({ ...input.preflight, state: input.state })
  const rootSnapshot = selectSnapshot(preflight.state)
  const refreshed = preflight.compacted && input.taskGraphPlanningEnabled ? await input.refreshTaskGraph(rootSnapshot)
    : preflight.compacted ? rootSnapshot : input.initialModelSnapshot
  return { state: preflight.state, nativeRecovery: input.nativeRecovery, modelSnapshot: withNativeVerificationFeedback(refreshed, input.nativeRecovery.feedback) }
}

/** Wires the real PG verifier, recovery, candidate gate and same-client terminal proof. */
export function createCanonicalNativeVerificationRuntime(input: Readonly<{
  pool: pg.Pool
  factory?: (pool: pg.Pool) => NativeVerificationRuntime
  coordination: Coordination
  durableWaitPort: DurableWaitPort
  enabled: boolean
}>): Readonly<{
  port: NativeVerificationPort
  configureSemanticProgress(input: NativeSemanticProgressConfiguration): void
  recover(): Promise<NativeVerificationRecovery>
  checkCompletion(stepId: string, candidateText: string): Promise<TurnEngineCompletionGateResult | null>
  resetSemanticProgress(): void
  checkTerminal(client: Pick<PoolClient, "query">, terminal: Readonly<{ stepId?: string; finalContent: unknown; response: unknown }>): Promise<NativeVerificationTerminalCheck>
  accepted(): boolean
}> {
  const runtime = input.factory?.(input.pool) ?? {
    port: createPgNativeVerificationPort(input.pool),
    readTerminalProof: readNativeVerificationTerminalProofWithClient,
  }
  let acceptedWitness: NativeVerificationRootGoalWitness | undefined
  let acceptedCandidate: string | undefined
  const semanticProgress = createNativeSemanticProgressTracker()
  const semanticRejection = createNativeSemanticRejectionObserver({ tracker: semanticProgress, port: runtime.port })
  return {
    port: runtime.port,
    configureSemanticProgress: semanticRejection.configure,
    accepted: () => acceptedWitness !== undefined,
    resetSemanticProgress() { semanticRejection.reset() },
    async recover() {
      if (!input.enabled || !await input.coordination.hasNativeTasks()) return {}
      return readNativeVerificationRecovery({ port: runtime.port, scope: input.coordination.readScope() })
    },
    async checkCompletion(stepId, candidateText) {
      acceptedWitness = undefined
      acceptedCandidate = undefined
      let observedSemanticReject = false
      try {
        if (input.enabled && await hasUnresolvedPlanningSteering(input.pool, input.coordination.executionScope(stepId))) {
          semanticRejection.reset()
          return { ok: false, blocker: STEERING_RECONCILIATION_BLOCKER, feedback: STEERING_RECONCILIATION_FEEDBACK }
        }
        const result = await nativeVerificationCompletionGate({
          candidateText,
          scope: () => input.coordination.executionScope(stepId),
          port: runtime.port,
          hasNativeTasks: input.enabled ? input.coordination.hasNativeTasks : async () => false,
          checkReceipt: input.coordination.checkNativeGraphCompletion,
          wait: (scope, targetTaskIds) => waitForNativeVerification({ port: input.durableWaitPort, scope, targetTaskIds }),
          observeRootSemanticRejection: ({ scope, candidateText, controlTaskId }) => {
            observedSemanticReject = true
            return semanticRejection.observe({ scope, stepId, candidateText, controlTaskId })
          },
          accept: (witness, candidate) => { acceptedWitness = witness; acceptedCandidate = candidate },
        })
        if (!observedSemanticReject) semanticRejection.reset()
        return result
      } catch (error: unknown) {
        semanticRejection.reset()
        throw error
      }
    },
    async checkTerminal(client, terminal) {
      if (!acceptedWitness) return { nativeVerificationPassed: false }
      if (await hasPendingSteerOrInvalidResult(client, input.coordination.readScope())) return {
        nativeVerificationPassed: false,
        denial: { ok: false, blocker: TASK_GRAPH_VERIFICATION_BLOCKER, feedback: "A new steering instruction arrived during verification. Re-read current input and prepare a fresh answer." },
      }
      const candidateText = persistedFinalCandidate(terminal.finalContent, terminal.response)
      if (!candidateText || candidateText !== acceptedCandidate) return {
        nativeVerificationPassed: false,
        denial: { ok: false, blocker: TASK_GRAPH_VERIFICATION_BLOCKER, feedback: "Current native proof does not match the final content being persisted." },
      }
      const nativeVerificationPassed = await runtime.readTerminalProof(client, {
        scope: input.coordination.readScope(), candidateText, witness: acceptedWitness, stepId: terminal.stepId,
      })
      return nativeVerificationPassed ? { nativeVerificationPassed: true } : {
        nativeVerificationPassed: false,
        denial: { ok: false, blocker: TASK_GRAPH_VERIFICATION_BLOCKER, feedback: "Current native verification proof is stale or unavailable." },
      }
    },
  }
}
