import { describe, expect, it, vi } from "vitest"

import { assertCanonicalCoordinationSurface, classifyToolCallRecovery, durableLifecycleSink } from "./canonical-runtime-tool-recovery.js"
import type { PersistedToolCallRecovery } from "./turn-engine-types.js"

const pending: PersistedToolCallRecovery = {
  call: { id: "call-1", name: "jobs.search", arguments: { location: "Dublin" } }, toolVersion: "1", stepId: "step-0", callItem: { id: "item-1", revision: 0 },
}

describe("canonical runtime tool recovery", () => {
  it("replays only server-classified read-only or idempotent tools", () => {
    const resolve = vi.fn((name: string, _version: string) => ({ idempotency: name === "safe" ? "idempotent" as const : "non_repeatable" as const }))
    const result = classifyToolCallRecovery([
      { ...pending, call: { ...pending.call, name: "safe" } },
      { ...pending, call: { ...pending.call, id: "call-2", name: "unsafe" } },
      { ...pending, call: { ...pending.call, id: "call-3", name: "requires-key" } },
      { ...pending, call: { ...pending.call, id: "call-4", name: "unknown" } },
    ], name => {
      if (name === "unknown") throw new Error("not registered")
      return name === "requires-key" ? { idempotency: "requires_key" as const } : resolve(name, "1")
    })
    expect(result.map(item => item.action)).toEqual(["replay", "fail", "fail", "fail"])
    expect(resolve).toHaveBeenCalledWith("safe", "1")
    expect(resolve).toHaveBeenCalledWith("unsafe", "1")
  })

  it("reconciles a durable result without consulting tool replay metadata", () => {
    const resolve = vi.fn(() => { throw new Error("registry unavailable") })
    const result = classifyToolCallRecovery([{ ...pending, durableResult: { id: "call-1", toolName: "jobs.search", toolVersion: "1", status: "completed", output: [], errorCode: null } }], resolve)
    expect(result[0]?.action).toBe("reconcile")
    expect(resolve).not.toHaveBeenCalled()
  })

  it("resolves the persisted server-owned tool version", () => {
    const resolve = vi.fn((_name: string, version: string) => ({ idempotency: version === "2" ? "read_only" as const : "non_repeatable" as const }))
    const result = classifyToolCallRecovery([{ ...pending, toolVersion: "2" }], resolve)
    expect(result[0]?.action).toBe("replay")
    expect(resolve).toHaveBeenCalledWith("jobs.search", "2")
  })

  it("keeps replay ambiguity terminal across a second restart", () => {
    const result = classifyToolCallRecovery([{ ...pending, durableResult: { id: "call-1", toolName: "apply.submit", toolVersion: "1", status: "failed", output: null, errorCode: "tool_result_replay_uncertain" } }], () => ({ idempotency: "read_only" }))
    expect(result[0]?.action).toBe("terminal")
  })

  it("requires every canonical coordination tool when the gate is enabled", () => {
    expect(() => assertCanonicalCoordinationSurface({ list: () => [{ name: "agent.spawn" }] }, [])).toThrow("canonical_coordination_tools_unconfigured")
  })

  it("persists a deterministic durable lifecycle event", async () => {
    const appendEvent = vi.fn(async (input: { id: string }) => ({ id: input.id }))
    const sink = durableLifecycleSink({ appendEvent } as never, { kind: "turn", taskId: "root-1" } as never)
    await sink.append({ phase: "started", eventType: "tool_call.started", item: { toolCallId: "call-1" } as never, payload: { toolCallId: "call-1", toolName: "jobs.search", toolVersion: "1", status: "started" } })
    expect(appendEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "tool_call.started", correlationId: "call-1", idempotencyKey: expect.stringContaining("tool-lifecycle:call-1:started:") }))
  })
})
