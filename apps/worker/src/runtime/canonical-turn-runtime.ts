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
import { loadCanonicalTurnState, type CanonicalTurnState } from "./canonical-turn-state.js"
import { loadTaskGraphCurrentObservation } from "./canonical-turn-task-graph-context.js"
import { loadSelectedJobPreparation, type SelectedJobPreparation } from "./selected-job-preparation.js"
import { failSelectedJobPreparationUnavailable } from "./selected-job-preparation-gate.js"
import { taskGraphRuntimeForTurn } from "./subagents/task-graph-templates.js"
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
import { selectedJobArtifactCompletionGate } from "./selected-job-completion-gate.js"

export { durableLifecycleSink } from "./turns/canonical-runtime-tool-recovery.js"
export type { UsageAuthorization } from "./canonical-turn-runtime-model.js"
export type CanonicalTurnRuntimeOptions = {
  readonly workerId: string
  /** One server-owned activation contract for production route capabilities. */
  readonly productionFlags?: ProductionAgentFlags
  readonly consumeWaitOutcomes?: boolean
  /** Server-derived production gate; user policy cannot enable coordination. */
  readonly coordinationEnabled?: boolean
  readonly stateLoader?: (pool: Pick<pg.Pool, "connect">, lease: TurnLease, now?: Date) => Promise<CanonicalTurnState>
  /** Test seam for the server-owned Turn input selector; production uses the lease-fenced database loader. */
  readonly selectedJobPreparationLoader?: (pool: Pick<pg.Pool, "connect">, lease: TurnLease, now: Date) => Promise<SelectedJobPreparation | undefined>
  readonly modelRuntimeFactory?: (input: { userId: string; config?: AiConfig; state: CanonicalTurnState }) => Promise<HarnessModelRuntime> | HarnessModelRuntime
  readonly authorizeUsage?: UsageAuthorizer
  /** Server-owned scheduler and trusted template registry; model input never supplies its task/tenant fence. */
  readonly taskGraphCommandPort?: TaskGraphCommandPort
  readonly taskGraphTemplates?: Readonly<Record<string, TaskGraphTaskTemplate>>
  readonly toolRuntimeFactory?: (input: { pool: pg.Pool; policy: PolicyEngine; manager: AgentTreeManager; state: CanonicalTurnState }) => { registry: { list(capabilities?: readonly string[]): readonly unknown[]; resolve(name: string, version: string): { readonly idempotency: ToolIdempotency }; validateArguments(name: string, input: unknown, version?: string): true | string; register?(definition: RuntimeToolDefinition): void }; router: ToolRouter }
  readonly manager?: AgentTreeManager
  readonly rootTaskStore?: RootTaskStore
  readonly turnEngineStoreFactory?: (pool: pg.Pool) => TurnEngineStore
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

const SELECTED_JOB_ROOT_TOOLS = new Set([
  "agent.plan", "agent.wait", "agent.list", "list_subagents",
])

function isSelectedJobRootTool(definition: unknown): boolean {
  const name = record(definition).name
  return typeof name === "string" && SELECTED_JOB_ROOT_TOOLS.has(name)
}

function selectedJobSnapshot(snapshot: TurnEngineOptions["snapshot"]): TurnEngineOptions["snapshot"] {
  return {
    ...snapshot,
    toolObservations: snapshot.toolObservations.filter(observation => {
      const content = record(observation.content)
      const toolName = content.toolName
      return (typeof toolName === "string" && SELECTED_JOB_ROOT_TOOLS.has(toolName))
        || (observation.id === "task-graph-current" && content.kind === "task_graph_current")
    }),
  }
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
    // A woke Turn may still carry a prior waiting result until ensure() rebinds it.
    // Only durable terminal results may short-circuit execution.
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
    const state = await (options.stateLoader?.(pool, lease, now()) ?? loadCanonicalTurnState(pool, lease, now(), { consumeWaitOutcomes }))
    const { enabled: taskGraphPlanningEnabled, selectedJobMode, templates: taskGraphTemplates } = await taskGraphRuntimeForTurn({
      enabled: options.productionFlags?.taskGraphPlanningEnabled === true && coordinationEnabled, pool, lease, now,
      selectedJobPreparationLoader: options.selectedJobPreparationLoader, taskGraphTemplates: options.taskGraphTemplates,
    })
    if (!taskGraphPlanningEnabled && !signal.aborted) {
      const selectedJobPreparation = await (options.selectedJobPreparationLoader ?? loadSelectedJobPreparation)(pool, lease, now())
      // The selector is asynchronous; Stop or lease loss can arrive while it
      // is reading. Let TurnEngine preserve the canonical interrupted result.
      if (!signal.aborted && selectedJobPreparation) {
        return failSelectedJobPreparationUnavailable({ lease, state, rootTasks, executionProjection, sessionProjection, now })
      }
    }
    const selectedPolicy = createCanonicalPolicy(state.toolPolicySnapshot, coordinationEnabled, taskGraphPlanningEnabled)
    const configuredCapabilities = capabilities(state.toolPolicySnapshot).filter(capability => capability !== "canManageChildren")
    const toolCapabilities = [...new Set([...configuredCapabilities, ...(coordinationEnabled ? ["coordination", "canManageChildren"] : [])])]
    const turnStore = options.turnEngineStoreFactory?.(pool) ?? createPgTurnEngineStore(pool)
    let lifecycleSink: ToolLifecycleSink | null = null
    let lifecycleOwner: ExecutionOwner | null = null
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
    registerTaskGraphPlanningTool(toolRuntime.registry, taskGraphPlanningEnabled, { commandPort: options.taskGraphCommandPort, templates: taskGraphTemplates, turnLeaseOwner: lease.ownerId, turnLeaseVersion: lease.leaseVersion, parentLeaseOwner: lease.ownerId, parentAttemptCount: () => taskGraphParentAttemptCount })
    if (coordinationEnabled) assertCanonicalCoordinationSurface(toolRuntime.registry, toolCapabilities)
    const rootTools = toolRuntime.registry.list(toolCapabilities).filter(definition => !selectedJobMode || isSelectedJobRootTool(definition))
    const allowedActions = rootTools.flatMap((definition) => {
      const name = definition && typeof definition === "object" && "name" in definition ? (definition as { name?: unknown }).name : undefined
      return typeof name === "string" ? [name] : []
    })
    const root = await rootTasks.ensure({ lease, goal: state.goal, modelProfileSnapshot: state.modelProfileSnapshot, toolPolicySnapshot: state.toolPolicySnapshot, budgetSnapshot: state.budgetSnapshot, allowedActions, now: now() })
    taskGraphParentAttemptCount = root.attemptCount
    const rootSnapshot = selectedJobMode ? selectedJobSnapshot(state.snapshot) : state.snapshot
    const modelSnapshot = taskGraphPlanningEnabled ? await loadTaskGraphCurrentObservation(rootSnapshot, options.taskGraphCommandPort, lease, root) : rootSnapshot
    const owner = executionOwnerFence({ kind: "turn", taskId: root.id, lease })
    lifecycleOwner = { kind: "turn", taskId: root.id, lease }
    lifecycleSink = options.lifecycleSinkFactory?.({ lease, store: turnStore, owner }) ?? durableLifecycleSink(turnStore, owner)
    const config = options.modelRuntimeFactory ? undefined : await loadWorkerAiConfig(lease.userId)
    const modelRuntime = await (options.modelRuntimeFactory?.({ userId: lease.userId, config, state }) ?? createHarnessModelRuntime({ primary: config, fallbacks: [], allowEnvironmentFallbacks: false }))
    const authorize = options.authorizeUsage ?? defaultAuthorization
    const model = modelWithUsage(modelRuntime, lease, authorize)
    const routeTool = createToolRouterExecutor(toolRuntime.router)
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
      store: turnStore, model, tools: rootTools,
      executeTool: input => selectedJobMode && !SELECTED_JOB_ROOT_TOOLS.has(input.call.toolName)
        ? Promise.resolve({ id: input.call.id, toolName: input.call.toolName, toolVersion: input.call.toolVersion, status: "failed" as const, errorCode: "selected_job_root_tool_disabled" })
        : routeTool(input),
      rootInputId: state.rootInputId, rootTaskId: root.id, taskId: root.id,
      actorRole, capabilities: toolCapabilities,
      validateToolArguments: (name, input) => selectedJobMode && !SELECTED_JOB_ROOT_TOOLS.has(name)
        ? "selected_job_root_tool_disabled"
        : toolRuntime.registry.validateArguments(name, input, "1"), signal,
      budget: limits(state.budgetSnapshot), resume: state.resume, now, publishReasoningSummary: false,
      steeringMarkerState: { active: state.steeringMarkers?.active ?? [] }, ...(taskGraphPlanningEnabled ? { refreshTaskGraphAfterReadyWait: (snapshot: TurnEngineOptions["snapshot"]) => loadTaskGraphCurrentObservation(snapshot, options.taskGraphCommandPort, lease, root), refreshTaskGraphAfterPlan: (snapshot: TurnEngineOptions["snapshot"]) => loadTaskGraphCurrentObservation(snapshot, options.taskGraphCommandPort, lease, root) } : {}),
      ...(state.pendingToolCalls?.length ? { toolCallRecovery: classifyToolCallRecovery(state.pendingToolCalls, (name, version) => toolRuntime.registry.resolve(name, version)) } : {}),
      ...(rootTasks.checkCompletion || selectedJobMode ? { completionGate: async () => {
        const children = await rootTasks.checkCompletion?.({ lease, rootTaskId: root.id, now: now() })
        if (children && !children.ok) return children
        if (!selectedJobMode) return children ?? { ok: true as const }
        return selectedJobArtifactCompletionGate({ commandPort: options.taskGraphCommandPort, lease, root })
      } } : {}),
    })
    await executionProjection.start({ userId: lease.userId, sessionId: lease.sessionId, turnId: lease.turnId })
    await sessionProjection.start({ userId: lease.userId, sessionId: lease.sessionId, turnId: lease.turnId })
    const result = await engine.run()
    await rootTasks.finish({ lease, rootTaskId: root.id, result, now: now() })
    // The durable root is finalized first; a projection failure remains surfaced so queue retry can reconcile it.
    await executionProjection.finish({ userId: lease.userId, sessionId: lease.sessionId, turnId: lease.turnId, result })
    await sessionProjection.finish({ userId: lease.userId, sessionId: lease.sessionId, turnId: lease.turnId, result })
    return { status: result.status, summary: result.errorCode, ...(result.waitId ? { waitId: result.waitId } : {}) }
  }
  return { execute, manager, childExecutionEnabled, coordinationEnabled, async close() { closed = true } }
}
