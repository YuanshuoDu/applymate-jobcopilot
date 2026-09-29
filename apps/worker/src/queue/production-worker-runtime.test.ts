import type pg from "pg"
import { describe, expect, it, vi } from "vitest"

import type { CanonicalTurnRuntime } from "./production-bootstrap.js"
import type { CanonicalTurnRuntimeOptions } from "../runtime/canonical-turn-runtime.js"
import type { ProductionAgentFlags } from "../runtime/production-agent-flags.js"
import {
  startProductionWorkerRuntime,
  type ProductionWorkerRuntimeDependencies,
} from "./production-worker-runtime.js"

function dependencies() {
  const pool = {} as pg.Pool
  const childExecutor = vi.fn()
  const runtime = {} as CanonicalTurnRuntime
  const bootstrap = { close: vi.fn(async () => undefined) } as never
  const authorization = vi.fn() as unknown as NonNullable<CanonicalTurnRuntimeOptions["authorizeUsage"]>
  const executionProjection = {} as NonNullable<CanonicalTurnRuntimeOptions["executionProjection"]>
  const sessionProjection = {} as NonNullable<CanonicalTurnRuntimeOptions["sessionProjection"]>
  let registeredOptions: unknown
  const startProductionAgentRuntime = vi.fn(async (options: Parameters<ProductionWorkerRuntimeDependencies["startProductionAgentRuntime"]>[0]) => {
    const createdRuntime = await options.createRuntime()
    registeredOptions = typeof options.bootstrapOptions === "function"
      ? options.bootstrapOptions(createdRuntime)
      : options.bootstrapOptions
    return bootstrap
  })

  const resolvedDependencies: ProductionWorkerRuntimeDependencies = {
    createOptionalProductionChildExecutor: vi.fn(({ enabled }) => enabled ? childExecutor : undefined),
    createCanonicalTurnRuntime: vi.fn(async () => runtime),
    createWorkerUsageAuthorizer: vi.fn(() => authorization),
    createCanonicalExecutionProjection: vi.fn(() => executionProjection),
    createCanonicalSessionProjection: vi.fn(() => sessionProjection),
    startProductionAgentRuntime,
  }

  return {
    pool,
    childExecutor,
    bootstrap,
    authorization,
    executionProjection,
    sessionProjection,
    resolvedDependencies,
    startProductionAgentRuntime,
    get registeredOptions() { return registeredOptions },
  }
}

describe("production Worker runtime composition", () => {
  it("passes canonical runtime inputs and registers enabled child and wait consumers before the run router", async () => {
    const flags: ProductionAgentFlags = {
      childExecutionEnabled: true,
      coordinationEnabled: true,
      consumeWaitOutcomes: true,
      canonicalAutomationEnabled: true,
    }
    const fixture = dependencies()
    const workerId = "worker_fixture"
    const onBootstrapReady = vi.fn()
    const startAgentRunWorker = vi.fn()

    await expect(startProductionWorkerRuntime({
      pool: fixture.pool,
      workerId,
      productionFlags: flags,
      onBootstrapReady,
      startAgentRunWorker,
    }, fixture.resolvedDependencies)).resolves.toBe(fixture.bootstrap)

    expect(fixture.resolvedDependencies.createOptionalProductionChildExecutor).toHaveBeenCalledWith({
      enabled: true,
      pool: fixture.pool,
    })
    expect(fixture.resolvedDependencies.createWorkerUsageAuthorizer).toHaveBeenCalledOnce()
    expect(fixture.resolvedDependencies.createCanonicalExecutionProjection).toHaveBeenCalledWith(fixture.pool)
    expect(fixture.resolvedDependencies.createCanonicalSessionProjection).toHaveBeenCalledWith(fixture.pool)
    expect(fixture.resolvedDependencies.createCanonicalTurnRuntime).toHaveBeenCalledWith(fixture.pool, {
      workerId,
      authorizeUsage: fixture.authorization,
      productionFlags: flags,
      executionProjection: fixture.executionProjection,
      sessionProjection: fixture.sessionProjection,
    })
    expect(fixture.registeredOptions).toEqual({
      subagents: { execute: fixture.childExecutor },
      waitResolver: {},
    })
    const startupOptions = fixture.startProductionAgentRuntime.mock.calls[0]?.[0]
    expect(startupOptions?.onBootstrapReady).toBe(onBootstrapReady)
    expect(startupOptions?.startAgentRunWorker).toBe(startAgentRunWorker)
    expect(onBootstrapReady).not.toHaveBeenCalled()
    expect(startAgentRunWorker).not.toHaveBeenCalled()
  })

  it("omits disabled child and wait consumers while preserving the resolved flags", async () => {
    const flags: ProductionAgentFlags = {
      childExecutionEnabled: false,
      coordinationEnabled: false,
      consumeWaitOutcomes: false,
      canonicalAutomationEnabled: false,
    }
    const fixture = dependencies()

    await startProductionWorkerRuntime({
      pool: fixture.pool,
      workerId: "worker_disabled_fixture",
      productionFlags: flags,
      startAgentRunWorker: vi.fn(),
    }, fixture.resolvedDependencies)

    expect(fixture.registeredOptions).toEqual({})
    expect(fixture.resolvedDependencies.createCanonicalTurnRuntime).toHaveBeenCalledWith(
      fixture.pool,
      expect.objectContaining({ productionFlags: flags }),
    )
  })
})
