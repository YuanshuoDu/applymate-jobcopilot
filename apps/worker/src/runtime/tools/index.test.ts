import { describe, expect, it, vi } from "vitest"

import { createWorkerToolRuntime } from "./index.js"
import { InMemoryToolLifecycleSink } from "./lifecycle.js"
import type { ExecutionOwner } from "../execution-owner.js"
import type { CoordinationStore, DurableWaitPort } from "./coordination-types.js"
import type { TaskGraphCommandPort } from "../subagents/task-graph-command-port.js"

const owner: ExecutionOwner = {
  kind: "turn", taskId: "root-1", lease: {
    turnId: "turn-1", sessionId: "session-1", ownerId: "worker-1", userId: "user-1", leaseVersion: 1,
    leaseStartedAt: new Date("2026-08-31T11:59:00.000Z"), leaseExpiresAt: new Date("2099-01-01T00:00:00.000Z"),
  },
}

describe("worker tool runtime entry point", () => {
  it("exports a factory without opening a database connection at import time", () => {
    expect(createWorkerToolRuntime).toBeTypeOf("function")
  })

  it("adds write tools only when a provider is explicitly supplied", () => {
    const runtime = createWorkerToolRuntime(
      {} as never,
      { sink: new InMemoryToolLifecycleSink() },
      undefined,
      undefined,
      undefined,
      undefined,
      { submit: async () => ({ confirmationId: "mock-confirmation" }) },
    )

    expect(runtime.registry.resolve("application.submit", "1").risk).toBe("external_write")
  })

  it("registers the durable private-result read tool with the runtime owner resolver", () => {
    const runtime = createWorkerToolRuntime(
      {} as never,
      { sink: new InMemoryToolLifecycleSink(), resolveOwner: () => owner },
    )

    expect(runtime.registry.resolve("tool_results.read", "1")).toMatchObject({ risk: "read", domain: "coordination" })
  })

  it("keeps all coordination definitions out of the registry unless the trusted gate supplies them", () => {
    const disabled = createWorkerToolRuntime(
      {} as never,
      { sink: new InMemoryToolLifecycleSink(), resolveOwner: () => owner },
      undefined,
    )
    expect(disabled.registry.list(["canManageChildren"]).some(definition => definition.domain === "coordination" && definition.name !== "tool_results.read")).toBe(false)
    expect(() => disabled.registry.resolve("spawn_subagent", "1")).toThrow("not registered")

    const enabled = createWorkerToolRuntime(
      {} as never,
      { sink: new InMemoryToolLifecycleSink(), resolveOwner: () => owner },
      undefined,
      { manager: {} as never, store: {} as unknown as CoordinationStore, wait: {} as unknown as DurableWaitPort },
    )
    expect(enabled.registry.list(["canManageChildren"]).map(definition => definition.name).filter(name => name.includes("subagent") || name === "agent.followup" || name === "send_message" || name === "wait_subagents" || name === "interrupt_subagent" || name === "close_subagent")).toEqual([
      "spawn_subagent", "agent.followup", "send_message", "wait_subagents", "list_subagents", "interrupt_subagent", "close_subagent",
    ])
  })

  it("passes the supplied durable wait port to the wait tool", async () => {
    const wait = { wait: vi.fn(async () => ({ waitId: "wait-1", status: "ready" as const, deadlineAt: "2026-09-09T12:00:00.000Z", matchedTaskIds: ["child-1"] })) } as unknown as DurableWaitPort
    const store = {
      getTask: vi.fn(async () => ({ id: "child-1", turnId: "turn-1" })),
      appendActivity: vi.fn(async () => undefined),
    } as unknown as CoordinationStore
    const runtime = createWorkerToolRuntime(
      {} as never,
      { sink: new InMemoryToolLifecycleSink(), resolveOwner: () => owner },
      undefined,
      { manager: {} as never, store, wait },
    )
    const definition = runtime.registry.resolve("wait_subagents", "1")
    await definition.execute({ scope: { userId: "user-1" }, sessionId: "session-1", turnId: "turn-1", stepId: "step-1", signal: new AbortController().signal, capabilities: ["canManageChildren"], reportProgress: async () => undefined }, { idempotencyKey: "wait-1", taskIds: ["child-1"], mode: "any", timeoutMs: 1000 })
    expect(wait.wait).toHaveBeenCalledWith(expect.objectContaining({ userId: "user-1", targetTaskIds: ["child-1"], idempotencyKey: "wait-1" }))
  })

  it("forwards the planner-owned native command bridge into registered root spawn tools", async () => {
    const appendNativeCoordination = vi.fn(async (_input: Parameters<NonNullable<TaskGraphCommandPort["appendNativeCoordination"]>>[0]) => ({
      status: "accepted" as const, replay: false, operationId: "operation-1", requestFingerprint: "a".repeat(64),
      graphRevision: 1, nodeKey: "node-1", dispatchDisposition: "pending" as const,
      child: { taskId: "child-1", rootTaskId: "root-1", parentTaskId: "root-1", path: "/root-1/child-1", depth: 1, role: "scout", taskType: "inspect", status: "queued" as const },
    }))
    const commandPort = { appendAndSchedule: vi.fn(), appendNativeCoordination, readCurrent: vi.fn() } as unknown as TaskGraphCommandPort
    const root = { id: "root-1", userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: null, path: "/root-1", depth: 0, role: "orchestrator", taskType: "root", status: "running", goal: "Goal", attemptCount: 1, maxAttempts: 1, leaseOwner: "worker-1", leaseExpiresAt: null, interruptRequestedAt: null }
    const store = { getTask: vi.fn(async () => root), appendActivity: vi.fn(async () => undefined) } as unknown as CoordinationStore
    const runtime = createWorkerToolRuntime(
      {} as never, { sink: new InMemoryToolLifecycleSink(), resolveOwner: () => owner }, undefined,
      { manager: {} as never, store, nativeCoordination: { enabled: true, commandPort, turnLeaseOwner: "worker-1", turnLeaseVersion: 1, parentLeaseOwner: "worker-1", parentAttemptCount: () => 1 } },
    )
    const definition = runtime.registry.resolve("agent.spawn", "1")
    const output = await definition.execute({
      scope: { userId: "user-1" }, sessionId: "session-1", turnId: "turn-1", stepId: "step-1", toolCallId: "call-1",
      taskId: "root-1", rootTaskId: "root-1", actorRole: "orchestrator", signal: new AbortController().signal,
      capabilities: ["canManageChildren"], reportProgress: async () => undefined,
    }, { role: "scout", taskType: "inspect", goal: "Find evidence" })

    expect(appendNativeCoordination).toHaveBeenCalledOnce()
    expect(appendNativeCoordination.mock.calls[0]?.[0]).toMatchObject({ request: { kind: "spawn", idempotencyKey: expect.stringMatching(/^native:/) } })
    expect(output).toMatchObject({ taskId: "child-1", nativeCoordination: { operationId: "operation-1" } })
  })

})
