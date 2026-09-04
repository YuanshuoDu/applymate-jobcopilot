import type { JsonValue } from "../types.js"
import type { ScriptedClock } from "./clock.js"

export type ScriptedTool = {
  readonly name: string
  readonly response: JsonValue
  readonly latencyMs: number
  readonly invocations: readonly { readonly input: JsonValue; readonly at: string }[]
  execute(input: JsonValue, context: { readonly clock: ScriptedClock; readonly timeoutMs?: number }): Promise<JsonValue>
}

export class ScriptedToolError extends Error {
  constructor(readonly code: "tool_timeout", message: string) {
    super(message)
    this.name = "ScriptedToolError"
  }
}

export function scriptedTool(options: { readonly name: string; readonly response: JsonValue; readonly latencyMs?: number }): ScriptedTool {
  const latencyMs = options.latencyMs ?? 0
  if (!Number.isFinite(latencyMs) || latencyMs < 0) throw new TypeError("tool latency must be non-negative")
  const invocations: Array<{ readonly input: JsonValue; readonly at: string }> = []
  return {
    name: options.name,
    response: options.response,
    latencyMs,
    invocations,
    execute: async (input, context) => {
      invocations.push({ input, at: context.clock.nowIso() })
      context.clock.advance(latencyMs)
      if (context.timeoutMs !== undefined && latencyMs > context.timeoutMs) throw new ScriptedToolError("tool_timeout", `Tool ${options.name} exceeded ${context.timeoutMs}ms`)
      return options.response
    },
  }
}
