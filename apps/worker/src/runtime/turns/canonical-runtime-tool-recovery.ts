import { createHash } from "node:crypto"
import type { ToolIdempotency } from "../tools/types.js"
import type { ToolLifecycleEvent, ToolLifecycleSink } from "../tools/index.js"
import type { ExecutionOwnerFence } from "../execution-owner.js"
import type { TurnExecutionResult } from "./turn-queue.js"
import type { TurnEngineStore, PersistedToolCallRecovery, ToolCallRecovery } from "./turn-engine-types.js"
import { toRepositoryJson } from "./turn-engine-types.js"

const COORDINATION_TOOLS = ["agent.spawn", "agent.send", "agent.followup", "agent.wait", "agent.list", "agent.interrupt", "agent.close"] as const

export function isResumableRootResult(result: Pick<TurnExecutionResult, "status">): boolean {
  return result.status === "waiting_for_dependency" || result.status === "waiting_for_approval" || result.status === "waiting_for_user"
}

export function durableLifecycleSink(store: TurnEngineStore, owner: ExecutionOwnerFence): ToolLifecycleSink {
  return {
    async append(event: ToolLifecycleEvent): Promise<void> {
      const digest = createHash("sha256").update(JSON.stringify(event.payload)).digest("hex").slice(0, 24)
      await store.appendEvent({
        owner, id: `tool-lifecycle:${event.item.toolCallId}:${event.phase}:${digest}`, itemId: null, type: event.eventType,
        correlationId: event.item.toolCallId, causationId: null,
        idempotencyKey: `${owner.kind}:${owner.taskId}:tool-lifecycle:${event.item.toolCallId}:${event.phase}:${digest}`,
        payload: toRepositoryJson(event.payload),
      })
    },
  }
}

export function assertCanonicalCoordinationSurface(registry: { readonly list: (capabilities?: readonly string[]) => readonly unknown[] }, capabilities: readonly string[]): void {
  try {
    const names = new Set(registry.list(capabilities).map(item => item && typeof item === "object" ? (item as { name?: unknown }).name : undefined).filter((name): name is string => typeof name === "string"))
    if (COORDINATION_TOOLS.some(name => !names.has(name))) throw new Error("missing canonical coordination tool")
  } catch { throw new Error("canonical_coordination_tools_unconfigured") }
}

export function classifyToolCallRecovery(
  pending: readonly PersistedToolCallRecovery[],
  resolve: (name: string, version: string) => { readonly idempotency: ToolIdempotency },
): readonly ToolCallRecovery[] {
  return pending.map(call => {
    if (call.durableResult?.errorCode === "tool_result_replay_uncertain") return { ...call, action: "terminal" }
    if (call.durableResult) return { ...call, action: "reconcile" }
    try {
      const idempotency = resolve(call.call.name, call.toolVersion).idempotency
      return { ...call, action: idempotency === "read_only" || idempotency === "idempotent" ? "replay" : "fail" }
    } catch { return { ...call, action: "fail" } }
  })
}
