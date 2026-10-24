import type pg from "pg"
import type { RuntimePolicyDecision } from "@jobcopilot/agent-policy"
import type { TurnLease } from "./turns/lease.js"
import type { TurnEngineStore } from "./turns/turn-engine-types.js"
import type { TurnExecutionResult } from "./turns/turn-queue.js"
import type { ToolLifecycleSink } from "./tools/index.js"
import type { ExecutionOwner } from "./execution-owner.js"
import type { CanonicalTurnRuntimeOptions } from "./canonical-turn-runtime.js"
import { INTERACTIVE_DISCOVERY_INTENT, loadCanonicalTurnState, type CanonicalTurnState } from "./canonical-turn-state.js"
import { capabilities } from "./canonical-turn-config.js"
import { createCanonicalTurnCoordination } from "./canonical-turn-coordination.js"
import { createCanonicalPolicy } from "./policy/canonical-policy.js"
import { resolveRootTaskVerificationRequirements } from "./context/root-task-objective.js"
import { failSelectedJobPreparationUnavailable } from "./selected-job-preparation-gate.js"
import { loadSelectedJobPreparation } from "./selected-job-preparation.js"
import { TASK_GRAPH_TEMPLATES, taskGraphRuntimeForTurn } from "./subagents/task-graph-templates.js"
import { AgentTreeManager } from "./subagents/manager.js"
import { PgCoordinationStore } from "./mailbox/store.js"
import { createPgDurableWaitPort } from "./subagents/durable-wait-store.js"
import type { RootTaskStore } from "./subagents/root-task-store.js"
import { createWorkerToolRuntime } from "./tools/index.js"
import { registerTaskGraphPlanningTool } from "./tools/planning-executors.js"
import { assertCanonicalCoordinationSurface, assertCanonicalQuestionSurface, isNativeQuestionWaitEnabled } from "./turns/canonical-runtime-tool-recovery.js"
import { failInteractiveDiscoveryUnavailable } from "./interactive-discovery-runtime.js"
import { INTERACTIVE_DISCOVERY_TEMPLATES, rootTaskAllowedActions, rootToolSurface } from "./interactive-discovery-contract.js"
import { isSelectedJobRootTool } from "./canonical-turn-task-graph-context.js"
import { toolSafeDurableWaitPort } from "./tools/coordination-executor-support.js"
import type { CanonicalExecutionProjection } from "./canonical-execution-projection.js"
import type { CanonicalSessionProjection } from "./canonical-session-projection.js"
import type { SubagentTaskRecord } from "./subagents/types.js"
import { taskGraphDenialCheckpointFromDecision } from "./turns/task-graph-terminal-assessment.js"
import type { TurnEngineQueryClient } from "./turns/turn-engine-owner-sql.js"
import type { DiscoveryShortlistResult } from "./subagents/discovery-shortlist.js"
import { withInteractiveDiscoveryFinalResponse } from "./interactive-discovery-runtime.js"

type TaskGraphRuntimeResult = Awaited<ReturnType<typeof taskGraphRuntimeForTurn>>
type RuntimeTool = ReturnType<NonNullable<CanonicalTurnRuntimeOptions["toolRuntimeFactory"]>>
type RootTask = Awaited<ReturnType<RootTaskStore["ensure"]>>

export type CanonicalTurnSetup = {
  readonly state: CanonicalTurnState
  readonly interactiveDiscoveryMode: boolean
  readonly taskGraphPlanningEnabled: boolean
  readonly selectedJobMode: boolean
  readonly scheduledDraftMode: boolean
  readonly selectedJobPreparation: TaskGraphRuntimeResult["selectedJobPreparation"]
  readonly turnCoordination: ReturnType<typeof createCanonicalTurnCoordination>
  readonly nativeQuestionWaitEnabled: boolean
  readonly toolCapabilities: string[]
  readonly durableWaitPort: ReturnType<typeof createPgDurableWaitPort>
  readonly lifecycle: { sink: ToolLifecycleSink | null; owner: ExecutionOwner | null; taskGraphParentAttemptCount: number | null; policyDecisionRecorder: ((decision: RuntimePolicyDecision) => Promise<void>) | null }
  readonly toolRuntime: RuntimeTool
  readonly rootTools: readonly unknown[]
  readonly root: RootTask
}

export type CanonicalTurnSetupResult = { readonly earlyResult: TurnExecutionResult } | CanonicalTurnSetup

export async function prepareCanonicalTurnSetup(input: {
  readonly pool: pg.Pool
  readonly lease: TurnLease
  readonly signal: AbortSignal
  readonly now: () => Date
  readonly options: CanonicalTurnRuntimeOptions
  readonly manager: AgentTreeManager
  readonly rootTasks: RootTaskStore
  readonly executionProjection: CanonicalExecutionProjection
  readonly sessionProjection: CanonicalSessionProjection
  readonly coordinationEnabled: boolean
  readonly childExecutionEnabled: boolean
  readonly consumeWaitOutcomes: boolean
}): Promise<CanonicalTurnSetupResult> {
  const { pool, lease, signal, now, options, manager, rootTasks, executionProjection, sessionProjection } = input
  const durableWaitPort = createPgDurableWaitPort(pool)
  const state = await (options.stateLoader?.(pool, lease, now(), { consumeWaitOutcomes: input.consumeWaitOutcomes, durableWaitControlReader: durableWaitPort })
    ?? loadCanonicalTurnState(pool, lease, now(), { consumeWaitOutcomes: input.consumeWaitOutcomes, durableWaitControlReader: durableWaitPort }))
  const graph = await taskGraphRuntimeForTurn({
    enabled: options.productionFlags?.taskGraphPlanningEnabled === true && input.coordinationEnabled,
    pool, lease, now, turnSource: state.source, automationRunMode: state.automationRunMode, turnInput: state.turnInput,
    selectedJobPreparationLoader: options.selectedJobPreparationLoader,
    applicationFillPreparationLoader: options.applicationFillPreparationLoader,
    taskGraphTemplates: options.taskGraphTemplates,
  })
  if (state.source === "automation" && state.automationRunMode === "scheduled"
    && (!graph.enabled || !input.childExecutionEnabled || !input.coordinationEnabled || !input.consumeWaitOutcomes) && !signal.aborted) {
    const result = { status: "failed" as const, errorCode: "scheduled_task_graph_unavailable", stepCount: 0, toolCallCount: 0 }
    const root = await rootTasks.ensure({ lease, goal: state.goal, modelProfileSnapshot: state.modelProfileSnapshot, toolPolicySnapshot: state.toolPolicySnapshot, budgetSnapshot: state.budgetSnapshot, allowedActions: [], now: now() })
    await rootTasks.finish({ lease, rootTaskId: root.id, result, now: now() })
    await executionProjection.finish({ userId: lease.userId, sessionId: lease.sessionId, turnId: lease.turnId, result })
    await sessionProjection.finish({ userId: lease.userId, sessionId: lease.sessionId, turnId: lease.turnId, result })
    return { earlyResult: { status: "failed", summary: result.errorCode } }
  }
  if (!graph.enabled && !signal.aborted) {
    const selectedJobPreparation = await (options.selectedJobPreparationLoader ?? loadSelectedJobPreparation)(pool, lease, now())
    if (!signal.aborted && selectedJobPreparation) {
      return { earlyResult: await failSelectedJobPreparationUnavailable({ lease, state, rootTasks, executionProjection, sessionProjection, now }) }
    }
  }
  const interactiveDiscoveryMode = state.intent?.kind === INTERACTIVE_DISCOVERY_INTENT.kind
    && state.intent.version === INTERACTIVE_DISCOVERY_INTENT.version && !graph.selectedJobMode
  const turnTaskGraphTemplates = interactiveDiscoveryMode ? INTERACTIVE_DISCOVERY_TEMPLATES : graph.templates
  if (interactiveDiscoveryMode && !graph.enabled && !signal.aborted) {
    return { earlyResult: await failInteractiveDiscoveryUnavailable({ lease, state, rootTasks, executionProjection, sessionProjection, now }) }
  }
  const turnCoordination = createCanonicalTurnCoordination({ enabled: graph.enabled, commandPort: options.taskGraphCommandPort, lease })
  const nativeQuestionWaitEnabled = isNativeQuestionWaitEnabled({
    coordination: input.coordinationEnabled, nativeRoot: turnCoordination.nativeOptions.enabled,
    requested: options.nativeQuestionWaitEnabled, customAdapters: !!options.turnEngineStoreFactory || !!options.toolRuntimeFactory,
  })
  const selectedPolicy = createCanonicalPolicy(state.toolPolicySnapshot, input.coordinationEnabled, graph.enabled)
  const configuredCapabilities = capabilities(state.toolPolicySnapshot).filter(capability => capability !== "canManageChildren")
  const toolCapabilities = [...new Set([...configuredCapabilities, ...(input.coordinationEnabled ? ["coordination", "canManageChildren"] : [])])]
  const lifecycle = { sink: null as ToolLifecycleSink | null, owner: null as ExecutionOwner | null, taskGraphParentAttemptCount: null as number | null, policyDecisionRecorder: null as ((decision: RuntimePolicyDecision) => Promise<void>) | null }
  const verificationRequirements = resolveRootTaskVerificationRequirements(state.turnInput)
  const sinkProxy: ToolLifecycleSink = { append: async event => {
    if (!lifecycle.sink) throw new Error("root_task_not_bound")
    await lifecycle.sink.append(event)
  } }
  const resolveOwner = () => {
    if (!lifecycle.owner) throw new Error("tool_result_owner_unavailable")
    return lifecycle.owner
  }
  const recordPolicyDecision = async (decision: RuntimePolicyDecision) => {
    if (!lifecycle.policyDecisionRecorder) throw new Error("policy_decision_store_not_bound")
    await lifecycle.policyDecisionRecorder(decision)
  }
  const coordination = input.coordinationEnabled ? {
    manager, store: new PgCoordinationStore(pool), wait: toolSafeDurableWaitPort(durableWaitPort),
    nativeCoordination: turnCoordination.nativeOptions, verificationRequirements, askUserEnabled: nativeQuestionWaitEnabled,
  } : undefined
  const toolRuntime = options.toolRuntimeFactory?.({ pool, policy: selectedPolicy, manager, state })
    ?? createWorkerToolRuntime(pool, { sink: sinkProxy, resolveOwner }, selectedPolicy, coordination,
      undefined, undefined, undefined, undefined, undefined, recordPolicyDecision)
  registerTaskGraphPlanningTool(toolRuntime.registry, graph.enabled, {
    commandPort: options.taskGraphCommandPort, templates: turnTaskGraphTemplates, verificationRequirements,
    turnLeaseOwner: lease.ownerId, turnLeaseVersion: lease.leaseVersion, parentLeaseOwner: lease.ownerId,
    parentAttemptCount: () => lifecycle.taskGraphParentAttemptCount, rootInputId: state.rootInputId ?? null,
  })
  if (input.coordinationEnabled) assertCanonicalCoordinationSurface(toolRuntime.registry, toolCapabilities)
  if (nativeQuestionWaitEnabled) assertCanonicalQuestionSurface(toolRuntime.registry, toolCapabilities)
  const rootTools = rootToolSurface(toolRuntime.registry.list(toolCapabilities), graph.selectedJobMode, interactiveDiscoveryMode, isSelectedJobRootTool)
    .filter(value => verificationRequirements.status !== "valid" || !["agent.spawn", "spawn_subagent", "agent.followup"].includes(String(record(value).name ?? "")))
  const allowedActions = addScheduledPrepareActions(rootTaskAllowedActions(rootTools, turnTaskGraphTemplates, graph.enabled), state, graph.enabled)
  const root = await rootTasks.ensure({ lease, goal: state.goal, modelProfileSnapshot: state.modelProfileSnapshot,
    toolPolicySnapshot: state.toolPolicySnapshot, budgetSnapshot: state.budgetSnapshot, allowedActions, now: now() })
  lifecycle.taskGraphParentAttemptCount = root.attemptCount
  turnCoordination.bindRoot(root)
  return {
    state, interactiveDiscoveryMode, taskGraphPlanningEnabled: graph.enabled, selectedJobMode: graph.selectedJobMode, scheduledDraftMode: graph.scheduledDraftMode,
    selectedJobPreparation: graph.selectedJobPreparation, turnCoordination, nativeQuestionWaitEnabled, toolCapabilities,
    durableWaitPort, lifecycle, toolRuntime, rootTools, root,
  }
}

export function turnStoreForInteractiveDiscovery(
  baseStore: TurnEngineStore,
  enabled: boolean,
  getShortlist: () => DiscoveryShortlistResult | undefined,
): TurnEngineStore {
  if (!enabled) return baseStore
  const guardedStore = withInteractiveDiscoveryFinalResponse(baseStore, getShortlist)
  return {
    ...guardedStore,
    recordFinalResponse: input => input.noProgress && !input.terminal
      ? baseStore.recordFinalResponse(input)
      : guardedStore.recordFinalResponse(input),
  }
}

export function addScheduledPrepareActions(
  allowedActions: string[],
  state: Pick<CanonicalTurnState, "source" | "automationRunMode">,
  graphEnabled: boolean,
): string[] {
  if (state.source === "automation" && state.automationRunMode === "scheduled" && graphEnabled) {
    allowedActions.push(...TASK_GRAPH_TEMPLATES.prepare.allowedActions.filter(action => !allowedActions.includes(action)))
  }
  return allowedActions
}

export function taskGraphDenialCheckpointReader(input: {
  readonly enabled: boolean; readonly rootTasks: RootTaskStore; readonly lease: TurnLease; readonly rootTaskId: string; readonly now: () => Date
}) {
  if (!input.enabled || !input.rootTasks.checkCompletion) return undefined
  return async (client?: TurnEngineQueryClient) => {
    const current = await input.rootTasks.checkCompletion?.({ lease: input.lease, rootTaskId: input.rootTaskId, now: input.now(),
      taskGraphVerification: true, nativeVerificationPassed: false, ...(client ? { client: client as pg.PoolClient } : {}) })
    return taskGraphDenialCheckpointFromDecision(current, input.rootTaskId)
  }
}

export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
