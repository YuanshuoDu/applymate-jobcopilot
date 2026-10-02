import type pg from "pg"
import type { PolicyRole } from "@jobcopilot/agent-protocol"
import type { PolicyEngine } from "@jobcopilot/agent-policy"
import { loadWorkerAiConfig, type AiConfig } from "@jobcopilot/shared/llm"

import { createHarnessModelRuntime, type HarnessModelRuntime } from "./harness-model.js"
import { createPgContextOwnerFence, StepContextBuilder } from "./context/step-context-builder.js"
import { createPgInputClaimStore } from "./context/input-claim-store.js"
import { createWorkerToolRuntime, type ToolLifecycleSink, type ToolRouter } from "./tools/index.js"
import { registerTaskGraphPlanningTool } from "./tools/planning-executors.js"
import type { TaskGraphCommandPort, TaskGraphTaskTemplate } from "./subagents/task-graph-command-port.js"
import type { RuntimeToolDefinition, ToolIdempotency } from "./tools/types.js"
import { createPgTurnEngineStore } from "./turns/turn-engine-store.js"
import { createToolRouterExecutor } from "./turns/turn-engine-helpers.js"
import { TurnEngine } from "./turns/turn-engine.js"
import { PgCoordinationStore } from "./mailbox/store.js"
import { createPgDurableWaitPort } from "./subagents/durable-wait-store.js"
import { capabilities, limits } from "./canonical-turn-config.js"
import type { TurnExecutor, TurnExecutionResult } from "./turns/turn-queue.js"
import type { TurnLease } from "./turns/lease.js"
import type { TurnEngineOptions, TurnEngineStore } from "./turns/turn-engine-types.js"
import { INTERACTIVE_DISCOVERY_INTENT, loadCanonicalTurnState, type CanonicalTurnState, type CanonicalTurnStateLoadOptions } from "./canonical-turn-state.js"
import { isSelectedJobRootTool, loadTaskGraphCurrentObservation, selectedJobSnapshot } from "./canonical-turn-task-graph-context.js"
import { loadSelectedJobPreparation, type SelectedJobPreparation } from "./selected-job-preparation.js"
import { failSelectedJobPreparationUnavailable } from "./selected-job-preparation-gate.js"
import { taskGraphRuntimeForTurn } from "./subagents/task-graph-templates.js"
import { loadSelectedJobArtifactContext, readSelectedJobSourceDigestWithClient } from "./subagents/selected-job-artifact-context.js"
import { AgentTreeManager } from "./subagents/manager.js"
import { PgSubagentTaskStore } from "./subagents/pg-store.js"
import { createPgRootTaskStore, type RootTaskStore } from "./subagents/root-task-store.js"
import { executionOwnerFence, type ExecutionOwner, type ExecutionOwnerFence } from "./execution-owner.js"
import { createCanonicalPolicy } from "./policy/canonical-policy.js"
import { noopCanonicalExecutionProjection, type CanonicalExecutionProjection } from "./canonical-execution-projection.js"
import { noopCanonicalSessionProjection, type CanonicalSessionProjection } from "./canonical-session-projection.js"
import type { ProductionAgentFlags } from "./production-agent-flags.js"
import { assertCanonicalCoordinationSurface, classifyToolCallRecovery, durableLifecycleSink, isResumableRootResult } from "./turns/canonical-runtime-tool-recovery.js"
import { defaultAuthorization, modelWithUsage, type UsageAuthorizer } from "./canonical-turn-runtime-model.js"
import { selectedJobArtifactCompletionGateWithWitness } from "./selected-job-completion-gate.js"
import { selectedJobArtifactFinalizationGuard } from "./selected-job-finalization-guard.js"
import { createAgentArtifactRepository, findCurrentDraftHeadWithClient, findReviewReceiptWithClient, type AgentArtifactDraftHead, type AgentArtifactDraftHeadScope } from "../db/agent-artifact-repo.js"
import { runTurnBoundaryCompactionPreflight, runTurnBoundaryContextCompaction } from "./context/turn-boundary-compaction-preflight.js"
import { createCanonicalRootToolGuards, failInteractiveDiscoveryUnavailable, interactiveDiscoveryCompletionGate, withInteractiveDiscoveryFinalResponse } from "./interactive-discovery-runtime.js"
import { INTERACTIVE_DISCOVERY_TEMPLATES, rootToolNames, rootToolSurface, terminalInteractiveDiscoveryShortlist, type InteractiveDiscoveryShortlistProjection } from "./interactive-discovery-contract.js"
import type { SubagentTaskRecord } from "./subagents/types.js"

export { durableLifecycleSink } from "./turns/canonical-runtime-tool-recovery.js"
export type { UsageAuthorization } from "./canonical-turn-runtime-model.js"
export type CanonicalTurnRuntimeOptions = {
  readonly workerId: string
  /** One server-owned activation contract for production route capabilities. */
  readonly productionFlags?: ProductionAgentFlags
  readonly consumeWaitOutcomes?: boolean
  /** Server-derived production gate; user policy cannot enable coordination. */
  readonly coordinationEnabled?: boolean
  readonly stateLoader?: (pool: Pick<pg.Pool, "connect">, lease: TurnLease, now?: Date, options?: CanonicalTurnStateLoadOptions) => Promise<CanonicalTurnState>
  /** Test seam for the server-owned Turn input selector; production uses the lease-fenced database loader. */
  readonly selectedJobPreparationLoader?: (pool: Pick<pg.Pool, "connect">, lease: TurnLease, now: Date) => Promise<SelectedJobPreparation | undefined>
  /** Test seam for the persisted artifact-head read; production uses the artifact repository. */
  readonly selectedJobArtifactHeadReader?: (scope: AgentArtifactDraftHeadScope) => Promise<AgentArtifactDraftHead | null>
  /** Test seam for reloading the server-selected source digest at Turn completion. */
  readonly selectedJobSourceDigestLoader?: (userId: string, jobId: string) => Promise<string | null>
  /** Test seam for rebuilding the shortlist from persisted owner-scoped child results and observations. */
  readonly interactiveDiscoveryShortlistLoader?: (input: { readonly pool: Pick<pg.Pool, "connect">; readonly lease: TurnLease; readonly root: Pick<SubagentTaskRecord, "id" | "attemptCount"> }) => Promise<InteractiveDiscoveryShortlistProjection | undefined>
  readonly modelRuntimeFactory?: (input: { userId: string; config?: AiConfig; state: CanonicalTurnState }) => Promise<HarnessModelRuntime> | HarnessModelRuntime
  readonly authorizeUsage?: UsageAuthorizer
  /** Server-owned scheduler and trusted template registry; model input never supplies its task/tenant fence. */
  readonly taskGraphCommandPort?: TaskGraphCommandPort
  readonly taskGraphTemplates?: Readonly<Record<string, TaskGraphTaskTemplate>>
  readonly toolRuntimeFactory?: (input: { pool: pg.Pool; policy: PolicyEngine; manager: AgentTreeManager; state: CanonicalTurnState }) => { registry: { list(capabilities?: readonly string[]): readonly unknown[]; resolve(name: string, version: string): { readonly idempotency: ToolIdempotency }; validateArguments(name: string, input: unknown, version?: string): true | string; register?(definition: RuntimeToolDefinition): void }; router: ToolRouter }
  readonly manager?: AgentTreeManager
  readonly rootTaskStore?: RootTaskStore
  readonly turnEngineStoreFactory?: (pool: pg.Pool, terminalGuard?: Parameters<typeof createPgTurnEngineStore>[1]) => TurnEngineStore
  readonly turnBoundaryCompactionRunner?: (input: Parameters<typeof runTurnBoundaryContextCompaction>[0]) => Promise<{ readonly status: string }>
  readonly contextBuilderFactory?: (input: { pool: pg.Pool; scope: { userId: string } }) => TurnEngineOptions["contextBuilder"]
  readonly lifecycleSinkFactory?: (input: { lease: TurnLease; store: TurnEngineStore; owner: ExecutionOwnerFence }) => ToolLifecycleSink
  /** Optional server-owned automation control projection; ordinary sessions are ignored by its SQL scope. */
  readonly executionProjection?: CanonicalExecutionProjection
  /** Optional server-owned automation session projection; ordinary sessions are ignored by its SQL scope. */
  readonly sessionProjection?: CanonicalSessionProjection
  readonly now?: () => Date
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

export async function createCanonicalTurnRuntime(pool: pg.Pool, options: CanonicalTurnRuntimeOptions): Promise<{
  execute: TurnExecutor
  manager: AgentTreeManager
  childExecutionEnabled: boolean
  coordinationEnabled: boolean
  close(): Promise<void>
}> {
  if (!options.workerId.trim()) throw new TypeError("workerId must be non-empty")
  const now = options.now ?? (() => new Date())
  const manager = options.manager ?? new AgentTreeManager(new PgSubagentTaskStore(pool), { now })
  const rootTasks = options.rootTaskStore ?? createPgRootTaskStore(pool)
  const artifactRepository = createAgentArtifactRepository(pool)
  const executionProjection = options.executionProjection ?? noopCanonicalExecutionProjection
  const sessionProjection = options.sessionProjection ?? noopCanonicalSessionProjection
  const reconcileTerminal = options.executionProjection || options.sessionProjection ? rootTasks.reconcileTerminal : undefined
  const productionFlags = options.productionFlags
  const consumeWaitOutcomes = productionFlags?.consumeWaitOutcomes ?? options.consumeWaitOutcomes === true
  const coordinationEnabled = productionFlags?.coordinationEnabled ?? options.coordinationEnabled === true
  const childExecutionEnabled = productionFlags?.childExecutionEnabled ?? coordinationEnabled
  if (coordinationEnabled && !childExecutionEnabled) throw new Error("coordination_requires_child_execution")
  let closed = false
  const execute: TurnExecutor = async ({ lease, signal }): Promise<TurnExecutionResult> => {
    if (closed) throw new Error("canonical_runtime_closed")
    const terminal = await reconcileTerminal?.({ lease, now: now() })
    // A woke Turn may carry a prior waiting result until ensure() rebinds it; only durable terminal results short-circuit.
    if (terminal && !isResumableRootResult(terminal.result)) {
      await executionProjection.finish({
        userId: lease.userId,
        sessionId: lease.sessionId,
        turnId: lease.turnId,
        result: { status: terminal.result.status, errorCode: terminal.result.summary },
      })
      await sessionProjection.finish({
        userId: lease.userId,
        sessionId: lease.sessionId,
        turnId: lease.turnId,
        result: { status: terminal.result.status, errorCode: terminal.result.summary },
      })
      return terminal.result
    }
    let state = await (options.stateLoader?.(pool, lease, now(), { consumeWaitOutcomes }) ?? loadCanonicalTurnState(pool, lease, now(), { consumeWaitOutcomes }))
    const { enabled: taskGraphPlanningEnabled, selectedJobMode, selectedJobPreparation, templates: taskGraphTemplates } = await taskGraphRuntimeForTurn({
      enabled: options.productionFlags?.taskGraphPlanningEnabled === true && coordinationEnabled, pool, lease, now,
      selectedJobPreparationLoader: options.selectedJobPreparationLoader, taskGraphTemplates: options.taskGraphTemplates,
    })
    if (!taskGraphPlanningEnabled && !signal.aborted) {
      const selectedJobPreparation = await (options.selectedJobPreparationLoader ?? loadSelectedJobPreparation)(pool, lease, now())
      // Let TurnEngine preserve interruption if Stop or lease loss arrives during this async read.
      if (!signal.aborted && selectedJobPreparation) {
        return failSelectedJobPreparationUnavailable({ lease, state, rootTasks, executionProjection, sessionProjection, now })
      }
    }
    const interactiveDiscoveryMode = state.intent?.kind === INTERACTIVE_DISCOVERY_INTENT.kind && state.intent.version === INTERACTIVE_DISCOVERY_INTENT.version && !selectedJobMode
    if (interactiveDiscoveryMode && !taskGraphPlanningEnabled && !signal.aborted) return failInteractiveDiscoveryUnavailable({ lease, state, rootTasks, executionProjection, sessionProjection, now })
    const selectedPolicy = createCanonicalPolicy(state.toolPolicySnapshot, coordinationEnabled, taskGraphPlanningEnabled)
    const configuredCapabilities = capabilities(state.toolPolicySnapshot).filter(capability => capability !== "canManageChildren")
    const toolCapabilities = [...new Set([...configuredCapabilities, ...(coordinationEnabled ? ["coordination", "canManageChildren"] : [])])]
    let lifecycleSink: ToolLifecycleSink | null = null; let lifecycleOwner: ExecutionOwner | null = null
    const sinkProxy: ToolLifecycleSink = { append: async (event) => {
      if (!lifecycleSink) throw new Error("root_task_not_bound")
      await lifecycleSink.append(event)
    } }
    const resolveOwner = () => {
      if (!lifecycleOwner) throw new Error("tool_result_owner_unavailable")
      return lifecycleOwner
    }
    const coordination = coordinationEnabled ? {
      manager,
      store: new PgCoordinationStore(pool),
      wait: createPgDurableWaitPort(pool),
    } : undefined
    const toolRuntime = options.toolRuntimeFactory?.({ pool, policy: selectedPolicy, manager, state }) ?? createWorkerToolRuntime(pool, { sink: sinkProxy, resolveOwner }, selectedPolicy, coordination)
    let taskGraphParentAttemptCount: number | null = null
    registerTaskGraphPlanningTool(toolRuntime.registry, taskGraphPlanningEnabled, { commandPort: options.taskGraphCommandPort, templates: interactiveDiscoveryMode ? INTERACTIVE_DISCOVERY_TEMPLATES : taskGraphTemplates, turnLeaseOwner: lease.ownerId, turnLeaseVersion: lease.leaseVersion, parentLeaseOwner: lease.ownerId, parentAttemptCount: () => taskGraphParentAttemptCount })
    if (coordinationEnabled) assertCanonicalCoordinationSurface(toolRuntime.registry, toolCapabilities)
    const rootTools = rootToolSurface(toolRuntime.registry.list(toolCapabilities), selectedJobMode, interactiveDiscoveryMode, isSelectedJobRootTool)
    const allowedActions = rootToolNames(rootTools)
    const root = await rootTasks.ensure({ lease, goal: state.goal, modelProfileSnapshot: state.modelProfileSnapshot, toolPolicySnapshot: state.toolPolicySnapshot, budgetSnapshot: state.budgetSnapshot, allowedActions, now: now() })
    taskGraphParentAttemptCount = root.attemptCount; let acceptedGraphWitness: Extract<Awaited<ReturnType<typeof selectedJobArtifactCompletionGateWithWitness>>, { ok: true }>["witness"] | undefined
    const terminalGuard: Parameters<typeof createPgTurnEngineStore>[1] = selectedJobMode ? client => selectedJobArtifactFinalizationGuard({ client, commandPort: options.taskGraphCommandPort, lease, root, selectedJobId: selectedJobPreparation?.jobId, acceptedGraphWitness,
      readCurrentDraftHead: findCurrentDraftHeadWithClient, readCurrentSourceDigest: (queryClient, scope) => readSelectedJobSourceDigestWithClient(queryClient, scope.userId, scope.jobId), readCurrentReviewReceipt: findReviewReceiptWithClient,
    }) : undefined
    const baseTurnStore = options.turnEngineStoreFactory?.(pool, terminalGuard) ?? createPgTurnEngineStore(pool, terminalGuard)
    let acceptedDiscoveryShortlist: InteractiveDiscoveryShortlistProjection | undefined
    let discoveryFailureCode: "discovery_runtime_unavailable" | "discovery_runtime_failed" = "discovery_runtime_failed"
    const turnStore = interactiveDiscoveryMode ? withInteractiveDiscoveryFinalResponse(baseTurnStore, () => acceptedDiscoveryShortlist) : baseTurnStore
    const initialRootSnapshot = selectedJobMode ? selectedJobSnapshot(state.snapshot) : state.snapshot
    const initialModelSnapshot = taskGraphPlanningEnabled ? await loadTaskGraphCurrentObservation(initialRootSnapshot, options.taskGraphCommandPort, lease, root) : initialRootSnapshot
    const owner = executionOwnerFence({ kind: "turn", taskId: root.id, lease })
    if (owner.kind !== "turn") throw new Error("turn_owner_fence_invalid")
    lifecycleOwner = { kind: "turn", taskId: root.id, lease }
    lifecycleSink = options.lifecycleSinkFactory?.({ lease, store: turnStore, owner }) ?? durableLifecycleSink(turnStore, owner)
    const config = options.modelRuntimeFactory ? undefined : await loadWorkerAiConfig(lease.userId)
    const modelRuntime = await (options.modelRuntimeFactory?.({ userId: lease.userId, config, state }) ?? createHarnessModelRuntime({ primary: config, fallbacks: [], allowEnvironmentFallbacks: false }))
    const authorize = options.authorizeUsage ?? defaultAuthorization
    const model = modelWithUsage(modelRuntime, lease, authorize)
    const preflight = await runTurnBoundaryCompactionPreflight({
      enabled: productionFlags?.turnBoundaryCompactionEnabled === true,
      state,
      signal,
      compact: () => (options.turnBoundaryCompactionRunner ?? runTurnBoundaryContextCompaction)({ pool, scope: state.scope, owner, lease, model, signal }),
      reload: () => options.stateLoader?.(pool, lease, now(), { consumeWaitOutcomes: false })
        ?? loadCanonicalTurnState(pool, lease, now(), { consumeWaitOutcomes: false }),
    })
    state = preflight.state
    const rootSnapshot = selectedJobMode ? selectedJobSnapshot(state.snapshot) : state.snapshot
    const modelSnapshot = preflight.compacted && taskGraphPlanningEnabled
      ? await loadTaskGraphCurrentObservation(rootSnapshot, options.taskGraphCommandPort, lease, root)
      : preflight.compacted ? rootSnapshot : initialModelSnapshot
    const routeTool = createToolRouterExecutor(toolRuntime.router)
    const rootToolGuards = createCanonicalRootToolGuards({ interactiveDiscoveryMode, selectedJobMode, routeTool, validateArguments: (name, args) => toolRuntime.registry.validateArguments(name, args, "1") })
    const inputStore = createPgInputClaimStore(pool, state.scope)
    const baseContextBuilder = options.contextBuilderFactory?.({ pool, scope: state.scope }) ?? new StepContextBuilder(inputStore, createPgContextOwnerFence(pool))
    const contextBuilder: TurnEngineOptions["contextBuilder"] = {
      build: request => baseContextBuilder.build({
        ...request,
        snapshot: selectedJobMode ? selectedJobSnapshot(request.snapshot) : request.snapshot,
        taskId: root.id,
      }),
    }
    const actorRole = (record(state.toolPolicySnapshot).role as PolicyRole | undefined) ?? "orchestrator"
    const engine = new TurnEngine({
      lease, scope: state.scope, goal: state.goal, snapshot: modelSnapshot, contextBuilder,
      store: turnStore, model, tools: rootTools, ...rootToolGuards,
      rootInputId: state.rootInputId, rootTaskId: root.id, taskId: root.id,
      actorRole, capabilities: toolCapabilities,
      signal,
      budget: limits(state.budgetSnapshot), resume: state.resume, now, publishReasoningSummary: false,
      steeringMarkerState: { active: state.steeringMarkers?.active ?? [] }, ...(taskGraphPlanningEnabled ? { refreshTaskGraphAfterReadyWait: (snapshot: TurnEngineOptions["snapshot"]) => loadTaskGraphCurrentObservation(snapshot, options.taskGraphCommandPort, lease, root), refreshTaskGraphAfterPlan: (snapshot: TurnEngineOptions["snapshot"]) => loadTaskGraphCurrentObservation(snapshot, options.taskGraphCommandPort, lease, root) } : {}),
      ...(state.pendingToolCalls?.length ? { toolCallRecovery: classifyToolCallRecovery(state.pendingToolCalls, (name, version) => toolRuntime.registry.resolve(name, version)) } : {}),
      ...(rootTasks.checkCompletion || selectedJobMode || interactiveDiscoveryMode ? { completionGate: async () => {
        acceptedGraphWitness = undefined
        const children = await rootTasks.checkCompletion?.({ lease, rootTaskId: root.id, now: now() })
        if (children && !children.ok) return children
        if (interactiveDiscoveryMode) return interactiveDiscoveryCompletionGate({ pool, lease, root, load: options.interactiveDiscoveryShortlistLoader, accept: shortlist => { acceptedDiscoveryShortlist = shortlist }, markUnavailable: () => { discoveryFailureCode = "discovery_runtime_unavailable" } })
        if (!selectedJobMode) return children ?? { ok: true as const }
        const result = await selectedJobArtifactCompletionGateWithWitness({
          commandPort: options.taskGraphCommandPort, lease, root, selectedJobId: selectedJobPreparation?.jobId,
          readCurrentDraftHead: options.selectedJobArtifactHeadReader ?? (scope => artifactRepository.findCurrentDraftHead(scope)),
          readCurrentReviewReceipt: scope => artifactRepository.findReviewReceipt(scope),
          readCurrentSourceDigest: async () => {
            const jobId = selectedJobPreparation?.jobId
            if (!jobId) return null
            if (options.selectedJobSourceDigestLoader) return options.selectedJobSourceDigestLoader(lease.userId, jobId)
            const currentSources = await loadSelectedJobArtifactContext(pool, lease.userId, jobId)
            return currentSources.preparation.sourceDigest
          },
        })
        if (result.ok) acceptedGraphWitness = result.witness; return result
      } } : {}),
    })
    await executionProjection.start({ userId: lease.userId, sessionId: lease.sessionId, turnId: lease.turnId })
    await sessionProjection.start({ userId: lease.userId, sessionId: lease.sessionId, turnId: lease.turnId })
    const result = await engine.run()
    const discoveryShortlist = interactiveDiscoveryMode ? terminalInteractiveDiscoveryShortlist(result.status, acceptedDiscoveryShortlist, discoveryFailureCode) : undefined
    await rootTasks.finish({ lease, rootTaskId: root.id, result, ...(discoveryShortlist ? { metadata: { interactiveDiscoveryShortlist: discoveryShortlist } } : {}), now: now() })
    // The durable root is finalized first; a projection failure remains surfaced so queue retry can reconcile it.
    await executionProjection.finish({ userId: lease.userId, sessionId: lease.sessionId, turnId: lease.turnId, result })
    await sessionProjection.finish({ userId: lease.userId, sessionId: lease.sessionId, turnId: lease.turnId, result })
    return { status: result.status, summary: result.errorCode, ...(result.waitId ? { waitId: result.waitId } : {}) }
  }
  return { execute, manager, childExecutionEnabled, coordinationEnabled, async close() { closed = true } }
}
