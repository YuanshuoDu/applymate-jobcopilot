import type { AiConfig } from "@jobcopilot/shared"

import type { HarnessModelRuntime } from "./harness-model.js"
import { createHarnessModelRuntime } from "./harness-model.js"
import { createTurnEngineExecutor } from "./turns/turn-engine.js"
import type { TurnEngineOptions } from "./turns/turn-engine-types.js"
import type { TurnExecutor } from "./turns/turn-queue.js"

export { createHarnessModelRuntime } from "./harness-model.js"
export type {
  HarnessFetch,
  HarnessModelRuntime,
  HarnessModelRuntimeOptions,
} from "./harness-model.js"

export type HarnessTurnExecutorOptions = Omit<TurnEngineOptions, "lease" | "signal" | "model" | "tools"> & {
  readonly tools: readonly unknown[]
  readonly model?: AiConfig
  readonly fallbackModels?: readonly AiConfig[]
  readonly modelRuntime?: HarnessModelRuntime
}

/** The current Harness phase exposes read-only tools until approval flows land. */
export function assertReadOnlyHarnessTools(tools: readonly unknown[]): void {
  for (const tool of tools) {
    if (!tool || typeof tool !== "object" || Array.isArray(tool)) throw new TypeError("Harness tool definitions must be objects")
    const value = tool as Record<string, unknown>
    if (value.risk !== "read" || value.idempotency !== "read_only") {
      throw new Error(`Harness refuses non-read-only tool: ${String(value.name ?? "unknown")}`)
    }
    if (!Array.isArray(value.capabilities) || !value.capabilities.includes("read")) {
      throw new Error(`Harness read tool must declare read capability: ${String(value.name ?? "unknown")}`)
    }
  }
}

/** Compose the queue-facing executor from the canonical TurnEngine and model runtime. */
export function createHarnessTurnExecutor(options: HarnessTurnExecutorOptions): TurnExecutor {
  assertReadOnlyHarnessTools(options.tools)
  const runtime = options.modelRuntime ?? createHarnessModelRuntime({
    primary: options.model,
    fallbacks: options.fallbackModels,
  })
  return createTurnEngineExecutor({
    ...options,
    model: runtime.adapter,
    publishReasoningSummary: false,
  })
}
