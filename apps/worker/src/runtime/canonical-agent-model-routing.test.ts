import { describe, expect, it, vi } from "vitest"
import type { ModelAdapter } from "@jobcopilot/agent-model"
import type { AiConfig, WorkerAgentAiRoute } from "@jobcopilot/shared/llm"
import type { HarnessModelRuntime, HarnessModelRuntimeOptions } from "./harness-model.js"
import { bindModelProfileSnapshot, bindProductionModelFactories, createCanonicalAgentModelRouting } from "./canonical-agent-model-routing.js"

type ChildOptions = Parameters<typeof import("./subagents/production-child-runtime.js").createOptionalProductionChildExecutor>[0]
type CanonicalFactory = typeof import("./canonical-turn-runtime.js").createCanonicalTurnRuntime
type CanonicalOptions = Parameters<CanonicalFactory>[1]

const agentConfig: AiConfig = { provider: "anthropic", model: "agent-model", apiKey: "fixture-agent-key", credentialSource: "user" }
const autoApplyConfig: AiConfig = { provider: "openai", model: "auto-apply-model", apiKey: "fixture-auto-key", apiBase: "https://openai.fixture/v1", credentialSource: "platform" }

function fixture() {
  const loadAgentRoute = vi.fn(async (): Promise<WorkerAgentAiRoute> => ({ source: "agent", config: agentConfig }))
  const loadAutoApplyRoute = vi.fn(async (): Promise<AiConfig> => autoApplyConfig)
  const createRuntime = vi.fn((options: HarnessModelRuntimeOptions) => {
    const config = options.primary!
    const adapter = { profile: { provider: config.provider, model: config.model } } as unknown as ModelAdapter
    return { adapter, registry: {}, candidates: [] } as unknown as HarnessModelRuntime
  })
  return { routing: createCanonicalAgentModelRouting({ loadAgentRoute, loadAutoApplyRoute, createRuntime }), loadAgentRoute, loadAutoApplyRoute, createRuntime }
}

describe("canonical Agent model routing", () => {
  it("binds the explicit Agent route to the root runtime without fallback candidates", async () => {
    const { routing, loadAgentRoute, createRuntime } = fixture()
    await routing.createRootRuntime({ userId: "user-1", state: { modelProfileSnapshot: {} } })

    expect(loadAgentRoute).toHaveBeenCalledWith("user-1")
    expect(createRuntime).toHaveBeenCalledWith({ primary: agentConfig, fallbacks: [], allowEnvironmentFallbacks: false })
  })

  it("keeps the legacy route when the Agent route resolver reports no override", async () => {
    const legacyConfig: AiConfig = { ...autoApplyConfig, model: "legacy-selected-model" }
    const { routing, loadAgentRoute, createRuntime } = fixture()
    loadAgentRoute.mockResolvedValue({ source: "legacy", config: legacyConfig })

    await routing.createRootRuntime({ userId: "user-1", state: {
      modelProfileSnapshot: { provider: "openai", model: "different-route-snapshot" },
    } })
    expect(createRuntime.mock.calls[0][0].primary).toEqual(legacyConfig)
  })

  it("preserves a same-provider pinned model with its route endpoint and credential", async () => {
    const { routing, createRuntime } = fixture()
    const adapter = await routing.createChildAdapter({ task: {
      userId: "user-1", role: "writer", taskType: "selected_job_writer",
      modelProfileSnapshot: { provider: "anthropic", model: "pinned-agent-model", nativeTools: true },
    } })

    expect(adapter.profile.model).toBe("pinned-agent-model")
    expect(createRuntime.mock.calls[0][0].primary).toEqual({ ...agentConfig, model: "pinned-agent-model" })
    expect(createRuntime.mock.calls[0][0]).toMatchObject({ fallbacks: [], allowEnvironmentFallbacks: false })
  })

  it("keeps scheduled Prepare on its exact AutoApply route", async () => {
    const { routing, loadAgentRoute, loadAutoApplyRoute, createRuntime } = fixture()
    await routing.createChildAdapter({ task: {
      userId: "user-1", role: "prepare", taskType: "scheduled_application_prepare",
      modelProfileSnapshot: { provider: "openai", model: "pinned-auto-model" },
    } })

    expect(loadAgentRoute).not.toHaveBeenCalled()
    expect(loadAutoApplyRoute).toHaveBeenCalledWith("user-1")
    expect(createRuntime.mock.calls[0][0].primary).toEqual({ ...autoApplyConfig, model: "pinned-auto-model" })
  })

  it("uses the Agent route for non-matching Prepare role or task type", async () => {
    const { routing, loadAgentRoute, loadAutoApplyRoute } = fixture()
    for (const identity of [
      { role: "analyst", taskType: "scheduled_application_prepare" },
      { role: "prepare", taskType: "other_prepare" },
    ]) {
      await routing.createChildAdapter({ task: { userId: "user-1", ...identity, modelProfileSnapshot: {} } })
    }
    expect(loadAgentRoute).toHaveBeenCalledTimes(2)
    expect(loadAutoApplyRoute).not.toHaveBeenCalled()
  })

  it("rejects cross-provider or credential-bearing snapshots before runtime construction", async () => {
    const { routing, createRuntime } = fixture()
    await expect(routing.createRootRuntime({ userId: "user-1", state: {
      modelProfileSnapshot: { provider: "openai", model: "other-provider-model" },
    } })).rejects.toThrow("worker_model_profile_provider_mismatch")
    expect(() => bindModelProfileSnapshot(agentConfig, { provider: "anthropic", model: "pinned", apiKey: "fixture-leak" }))
      .toThrow("worker_model_profile_snapshot_invalid")
    expect(createRuntime).not.toHaveBeenCalled()
  })

  it("rejects malformed model snapshots instead of dropping the selected model", () => {
    for (const snapshot of [[], "invalid", { provider: 2 }, { model: "   " }]) {
      expect(() => bindModelProfileSnapshot(agentConfig, snapshot)).toThrow("worker_model_profile_snapshot_invalid")
    }
  })

  it("accepts partial route hints only against the current provider", () => {
    expect(bindModelProfileSnapshot(agentConfig, { model: "model-only-pin" })).toEqual({ ...agentConfig, model: "model-only-pin" })
    expect(bindModelProfileSnapshot(agentConfig, { provider: "anthropic" })).toBe(agentConfig)
    expect(bindModelProfileSnapshot(agentConfig, { nativeTools: true, label: "fixture" })).toBe(agentConfig)
  })

  it("rejects a scheduled Prepare snapshot from another provider", async () => {
    const { routing, createRuntime, loadAgentRoute } = fixture()
    await expect(routing.createChildAdapter({ task: {
      userId: "user-1", role: "prepare", taskType: "scheduled_application_prepare",
      modelProfileSnapshot: { provider: "anthropic", model: "agent-model" },
    } })).rejects.toThrow("worker_model_profile_provider_mismatch")
    expect(loadAgentRoute).not.toHaveBeenCalled()
    expect(createRuntime).not.toHaveBeenCalled()
  })

  it("binds production seams lazily and preserves explicit runtime overrides", async () => {
    let childOptions: ChildOptions | undefined
    let canonicalOptions: CanonicalOptions | undefined
    const childFactory = vi.fn((options: ChildOptions) => { childOptions = options; return undefined })
    const canonicalFactory = vi.fn(async (_pool: Parameters<CanonicalFactory>[0], options: CanonicalOptions) => {
      canonicalOptions = options
      return {} as Awaited<ReturnType<CanonicalFactory>>
    })
    const taskGraphRuntimeOptions = vi.fn(() => ({} as Partial<CanonicalOptions>))
    const dependencies = bindProductionModelFactories(
      { createOptionalProductionChildExecutor: childFactory },
      { createCanonicalTurnRuntime: canonicalFactory },
      taskGraphRuntimeOptions,
    )

    expect(taskGraphRuntimeOptions).not.toHaveBeenCalled()
    dependencies.createOptionalProductionChildExecutor({ pool: {} as ChildOptions["pool"] })
    await dependencies.createCanonicalTurnRuntime({} as Parameters<CanonicalFactory>[0], { workerId: "fixture" })
    expect(typeof childOptions?.modelRuntimeFactory).toBe("function")
    expect(typeof canonicalOptions?.modelRuntimeFactory).toBe("function")
    expect(taskGraphRuntimeOptions).toHaveBeenCalledOnce()

    const explicitChild = vi.fn() as unknown as NonNullable<ChildOptions["modelRuntimeFactory"]>
    const explicitRoot = vi.fn() as unknown as NonNullable<CanonicalOptions["modelRuntimeFactory"]>
    dependencies.createOptionalProductionChildExecutor({ pool: {} as ChildOptions["pool"], modelRuntimeFactory: explicitChild })
    await dependencies.createCanonicalTurnRuntime({} as Parameters<CanonicalFactory>[0], { workerId: "fixture", modelRuntimeFactory: explicitRoot })
    expect(childOptions?.modelRuntimeFactory).toBe(explicitChild)
    expect(canonicalOptions?.modelRuntimeFactory).toBe(explicitRoot)
  })
})
