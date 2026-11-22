import type { ModelAdapter } from "@jobcopilot/agent-model"
import { loadWorkerAgentAiRoute, loadWorkerAiConfig, type AiConfig, type WorkerAgentAiRoute } from "@jobcopilot/shared/llm"
import { createHarnessModelRuntime, type HarnessModelRuntime, type HarnessModelRuntimeOptions } from "./harness-model.js"
import type { SubagentTaskRecord } from "./subagents/types.js"

type Dependencies = Readonly<{
  loadAgentRoute: (userId: string) => Promise<WorkerAgentAiRoute>
  loadAutoApplyRoute: (userId: string) => Promise<AiConfig>
  createRuntime: (options: HarnessModelRuntimeOptions) => HarnessModelRuntime
}>

type ChildRuntimeModule = Pick<typeof import("./subagents/production-child-runtime.js"), "createOptionalProductionChildExecutor">
type CanonicalRuntimeModule = Pick<typeof import("./canonical-turn-runtime.js"), "createCanonicalTurnRuntime">
type CanonicalRuntimeOptions = Parameters<CanonicalRuntimeModule["createCanonicalTurnRuntime"]>[1]

type SnapshotOwner = Pick<SubagentTaskRecord, "userId" | "role" | "taskType" | "modelProfileSnapshot">

const SCHEDULED_PREPARE_ROLE = "prepare"
const SCHEDULED_PREPARE_TASK_TYPE = "scheduled_application_prepare"

/** Bind a persisted model choice to the loaded route without carrying credentials across providers. */
export function bindModelProfileSnapshot(config: AiConfig, snapshot: unknown): AiConfig {
  if (snapshot === undefined || snapshot === null) return config
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new Error("worker_model_profile_snapshot_invalid")
  }
  const value = snapshot as Record<string, unknown>
  if (Object.prototype.hasOwnProperty.call(value, "apiKey") || Object.prototype.hasOwnProperty.call(value, "apiBase")) {
    throw new Error("worker_model_profile_snapshot_invalid")
  }
  const hasProvider = Object.prototype.hasOwnProperty.call(value, "provider")
  const hasModel = Object.prototype.hasOwnProperty.call(value, "model")
  if (!hasProvider && !hasModel) return config
  if (hasProvider && typeof value.provider !== "string") {
    throw new Error("worker_model_profile_snapshot_invalid")
  }
  if (hasModel && (typeof value.model !== "string" || !value.model.trim())) {
    throw new Error("worker_model_profile_snapshot_invalid")
  }
  if (hasProvider && value.provider !== config.provider) throw new Error("worker_model_profile_provider_mismatch")
  return hasModel ? { ...config, model: value.model as string } : config
}

export function createCanonicalAgentModelRouting(dependencies: Dependencies = {
  loadAgentRoute: loadWorkerAgentAiRoute,
  loadAutoApplyRoute: loadWorkerAiConfig,
  createRuntime: createHarnessModelRuntime,
}) {
  const runtime = (config: AiConfig) => dependencies.createRuntime({
    primary: config, fallbacks: [], allowEnvironmentFallbacks: false,
  })

  return {
    async createRootRuntime(input: { userId: string; state: { modelProfileSnapshot: unknown } }): Promise<HarnessModelRuntime> {
      const route = await dependencies.loadAgentRoute(input.userId)
      const config = route.source === "agent"
        ? bindModelProfileSnapshot(route.config, input.state.modelProfileSnapshot)
        : route.config
      return runtime(config)
    },

    async createChildAdapter(input: { task: SnapshotOwner }): Promise<ModelAdapter> {
      const { task } = input
      const isScheduledPrepare = task.role === SCHEDULED_PREPARE_ROLE && task.taskType === SCHEDULED_PREPARE_TASK_TYPE
      const config = isScheduledPrepare
        ? await dependencies.loadAutoApplyRoute(task.userId)
        : (await dependencies.loadAgentRoute(task.userId)).config
      return runtime(bindModelProfileSnapshot(config, task.modelProfileSnapshot)).adapter
    },
  }
}

/** Bind the route through the existing production seams while retaining caller overrides. */
export function bindProductionModelFactories(
  childRuntime: ChildRuntimeModule,
  canonicalRuntime: CanonicalRuntimeModule,
  taskGraphRuntimeOptions: () => Partial<CanonicalRuntimeOptions>,
) {
  const routing = createCanonicalAgentModelRouting()
  return {
    createOptionalProductionChildExecutor(options: Parameters<ChildRuntimeModule["createOptionalProductionChildExecutor"]>[0]) {
      return childRuntime.createOptionalProductionChildExecutor({
        ...options,
        modelRuntimeFactory: options.modelRuntimeFactory ?? (input => routing.createChildAdapter({ task: input.task })),
      })
    },
    createCanonicalTurnRuntime(
      runtimePool: Parameters<CanonicalRuntimeModule["createCanonicalTurnRuntime"]>[0],
      options: CanonicalRuntimeOptions,
    ) {
      return canonicalRuntime.createCanonicalTurnRuntime(runtimePool, {
        ...options,
        ...taskGraphRuntimeOptions(),
        modelRuntimeFactory: options.modelRuntimeFactory ?? (input => routing.createRootRuntime({
          userId: input.userId, state: { modelProfileSnapshot: input.state.modelProfileSnapshot },
        })),
      })
    },
  }
}
