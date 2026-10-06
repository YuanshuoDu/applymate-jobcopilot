import type pg from "pg"
import type { PoolClient } from "pg"
import type { TurnEngineTerminalGuard } from "./turns/turn-engine-terminal-commit.js"
import { createPgNativeVerificationPort } from "./subagents/pg-native-verification-port.js"
import { readNativeVerificationTerminalProofWithClient } from "./subagents/native-verification-pg-readback.js"
import type { NativeVerificationPort, NativeVerificationRootGoalWitness, NativeVerificationTerminalProofReader } from "./subagents/native-verification-port.js"
import type { TaskGraphExecutionScope, TaskGraphReadScope } from "./subagents/task-graph-command-port.js"
import type { DurableWaitPort } from "./tools/coordination-types.js"
import type { TurnEngineCompletionGate, TurnEngineCompletionGateResult } from "./turns/turn-execution-types.js"
import type { StepContextSnapshot } from "./context/step-context-builder.js"
import type { CanonicalTurnState } from "./canonical-turn-state.js"
import { selectedJobSnapshot } from "./canonical-turn-task-graph-context.js"
import { runTurnBoundaryCompactionPreflight } from "./context/turn-boundary-compaction-preflight.js"
import { withNativeVerificationFeedback } from "./canonical-turn-native-verification-snapshot.js"
import type { NativeVerificationRecovery } from "./canonical-turn-native-verification-recovery.js"
import { nativeVerificationCompletionGate } from "./canonical-turn-native-verification.js"
import { waitForNativeVerification } from "./canonical-turn-native-verification-wait.js"
import { readNativeVerificationRecovery } from "./canonical-turn-native-verification-recovery.js"
import { persistedFinalCandidate } from "./turns/turn-execution-final-candidate.js"
import { TASK_GRAPH_VERIFICATION_BLOCKER } from "./turns/turn-execution-completion-gate.js"
import { createAgentArtifactRepository, type AgentArtifactDraftHead, type AgentArtifactDraftHeadScope } from "../db/agent-artifact-repo.js"
import { loadSelectedJobArtifactContext } from "./subagents/selected-job-artifact-context.js"
import { selectedJobArtifactCompletionGateWithWitness, type SelectedJobCompletionGraphWitness, type SelectedJobArtifactCompletionGateWithWitnessResult } from "./selected-job-completion-gate.js"
import type { TaskGraphCommandPort } from "./subagents/task-graph-command-port.js"
import type { TurnLease } from "./turns/lease.js"
import type { SubagentTaskRecord } from "./subagents/types.js"

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

async function hasPendingSteerOrInvalidResult(client: Pick<PoolClient, "query">, scope: TaskGraphReadScope): Promise<boolean> {
  const result = await client.query<{ hasPendingSteer: unknown }>(`SELECT EXISTS (
    SELECT 1 FROM "agent_inputs"
    WHERE "sessionId" = $1 AND "userId" = $2 AND "targetTurnId" = $3
      AND "delivery" = 'steer' AND "status" IN ('accepted', 'queued')
      AND "consumedByStepId" IS NULL AND "consumedAt" IS NULL AND "cancelledAt" IS NULL
  ) AS "hasPendingSteer"`, [scope.sessionId, scope.userId, scope.turnId])
  const rows: unknown = result?.rows
  if (!Array.isArray(rows) || rows.length !== 1) return true
  const row = rows[0]
  if (!row || typeof row !== "object" || Array.isArray(row) || Object.keys(row).length !== 1 || !Object.hasOwn(row, "hasPendingSteer")) return true
  return (row as Record<string, unknown>).hasPendingSteer !== false
}

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
  return async (client, terminal) => {
    const native = await input.nativeVerification.checkTerminal(client, terminal)
    if (native.denial) return native.denial
    if (input.checkRootGraph) {
      const graph = await input.checkRootGraph(client, native.nativeVerificationPassed)
      if (!graph) return { ok: false, blocker: "task_graph_verification_unverified", feedback: "TaskGraph completion verification is unavailable." }
      if (!graph.ok) return graph
    }
    return input.finalizeSelectedJob ? input.finalizeSelectedJob(client) : { ok: true }
  }
}

/** Preserves the native receipt/proof gate ahead of existing root and mode-specific gates. */
export function createCanonicalRootCompletionGate(input: Readonly<{
  enabled: boolean
  nativeVerification: Pick<ReturnType<typeof createCanonicalNativeVerificationRuntime>, "checkCompletion" | "accepted">
  onCandidateStart(): void
  checkChildren(): Promise<TurnEngineCompletionGateResult | undefined> | TurnEngineCompletionGateResult | undefined
  interactiveDiscovery?: () => Promise<TurnEngineCompletionGateResult>
  selectedJobMode: boolean
  selectedJobCompletion?: () => Promise<TurnEngineCompletionGateResult>
}>): TurnEngineCompletionGate | undefined {
  if (!input.enabled) return undefined
  return async ({ stepId, candidateText }) => {
    input.onCandidateStart()
    const native = await input.nativeVerification.checkCompletion(stepId, candidateText)
    if (native) return native
    const children = await input.checkChildren()
    if (children && !children.ok) return children
    if (input.interactiveDiscovery) return input.interactiveDiscovery()
    if (!input.selectedJobMode) return children ?? { ok: true }
    return input.selectedJobCompletion ? input.selectedJobCompletion() : {
      ok: false, blocker: "selected_job_draft_review_required", feedback: "Selected-job completion verification is unavailable.",
    }
  }
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
  recover(): Promise<NativeVerificationRecovery>
  checkCompletion(stepId: string, candidateText: string): Promise<TurnEngineCompletionGateResult | null>
  checkTerminal(client: Pick<PoolClient, "query">, terminal: Readonly<{ finalContent: unknown; response: unknown }>): Promise<NativeVerificationTerminalCheck>
  accepted(): boolean
}> {
  const runtime = input.factory?.(input.pool) ?? {
    port: createPgNativeVerificationPort(input.pool),
    readTerminalProof: readNativeVerificationTerminalProofWithClient,
  }
  let acceptedWitness: NativeVerificationRootGoalWitness | undefined
  let acceptedCandidate: string | undefined
  return {
    port: runtime.port,
    accepted: () => acceptedWitness !== undefined,
    async recover() {
      if (!input.enabled || !await input.coordination.hasNativeTasks()) return {}
      return readNativeVerificationRecovery({ port: runtime.port, scope: input.coordination.readScope() })
    },
    async checkCompletion(stepId, candidateText) {
      acceptedWitness = undefined
      acceptedCandidate = undefined
      return nativeVerificationCompletionGate({
        candidateText,
        scope: () => input.coordination.executionScope(stepId),
        port: runtime.port,
        hasNativeTasks: input.enabled ? input.coordination.hasNativeTasks : async () => false,
        checkReceipt: input.coordination.checkNativeGraphCompletion,
        wait: (scope, targetTaskIds) => waitForNativeVerification({ port: input.durableWaitPort, scope, targetTaskIds }),
        accept: (witness, candidate) => { acceptedWitness = witness; acceptedCandidate = candidate },
      })
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
        scope: input.coordination.readScope(), candidateText, witness: acceptedWitness,
      })
      return nativeVerificationPassed ? { nativeVerificationPassed: true } : {
        nativeVerificationPassed: false,
        denial: { ok: false, blocker: TASK_GRAPH_VERIFICATION_BLOCKER, feedback: "Current native verification proof is stale or unavailable." },
      }
    },
  }
}
