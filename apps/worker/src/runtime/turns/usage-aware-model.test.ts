import { describe, expect, it, vi } from "vitest"
import type { HarnessModelRequest, ModelAdapter, ModelStreamEvent } from "@jobcopilot/agent-model"

import { createUsageAwareModelAdapter } from "./usage-aware-model.js"
import type { ExecutionOwnerFence } from "../execution-owner.js"
import type { TreeBudgetReservation, TreeBudgetReservationStore } from "../subagents/tree-budget-types.js"

const profile = {
  provider: "fixture", model: "fixture-model", nativeTools: true, structuredOutput: true, streaming: true, continuationCursor: false,
  supportsParallelTools: false, supportsStreamingToolArgs: true, supportsReasoningSummary: true, supportsResponseContinuation: false,
  supportsProviderConversation: false, supportsBackgroundResponse: false, maxContextTokens: null, maxOutputTokens: null, costClass: "low" as const,
}
const owner: ExecutionOwnerFence = {
  kind: "task", userId: "user-1", sessionId: "session-1", turnId: "turn-1", taskId: "child-1", rootTaskId: "root-1", ownerId: "worker-1",
  attemptCount: 2, leaseExpiresAt: new Date("2026-09-09T12:00:00.000Z"),
}
const request: HarnessModelRequest = {
  schemaVersion: "agent-harness.v2", provider: profile.provider, model: profile.model, messages: [], tools: [],
  capabilities: { nativeTools: true, structuredOutput: true, streaming: true, continuationCursor: false }, signal: new AbortController().signal,
  metadata: { sessionId: owner.sessionId, turnId: owner.turnId, stepId: "step-1", taskId: owner.taskId, userId: owner.userId },
}

function reservation(status: TreeBudgetReservation["status"] = "reserved"): TreeBudgetReservation {
  const now = new Date("2026-09-09T00:00:00.000Z")
  return { id: "reservation-1", userId: owner.userId, sessionId: owner.sessionId, turnId: owner.turnId, rootTaskId: owner.rootTaskId,
  taskId: owner.taskId, stepId: "step-1", attempt: 2, units: 1, status, idempotencyKey: "key-1", createdAt: now, updatedAt: now, settledAt: null }
}

function store(behavior: (status: "consumed" | "released") => Promise<void> = async () => undefined): { store: TreeBudgetReservationStore; statuses: string[] } {
  const statuses: string[] = []
  return {
    statuses,
    store: {
      reserve: vi.fn(async () => reservation()),
      settle: vi.fn(async input => { statuses.push(input.status); await behavior(input.status) ; return reservation(input.status) }),
    },
  }
}

function adapter(events: readonly ModelStreamEvent[] = [{ type: "usage", inputTokens: 2, outputTokens: 3 }, { type: "completed", finishReason: "stop" }]): ModelAdapter {
  return { id: "fixture", profile, async *stream(_input) { yield* events } }
}

describe("usage-aware model owner seam", () => {
  it("sends a child owner envelope and consumes one shared tree step", async () => {
    const fixture = store()
    const authorize = vi.fn(async () => ({ settle: vi.fn(async () => undefined) }))
    const events: ModelStreamEvent[] = []
    for await (const event of createUsageAwareModelAdapter(adapter(), { owner, authorize, treeBudget: fixture.store }).stream(request)) events.push(event)
    expect(events).toHaveLength(2)
    expect(authorize).toHaveBeenCalledWith(expect.objectContaining({
      executionOwner: { kind: "task", taskId: "child-1", rootTaskId: "root-1", ownerId: "worker-1", attemptCount: 2 },
      attemptId: "child-1:2",
    }))
    expect(fixture.statuses).toEqual(["consumed"])
  })

  it("releases a tree reservation when account admission is denied", async () => {
    const fixture = store()
    const model = createUsageAwareModelAdapter(adapter(), { owner, treeBudget: fixture.store, authorize: vi.fn(async () => { throw new Error("usage_denied") }) })
    await expect((async () => { for await (const _event of model.stream(request)) return undefined })()).rejects.toThrow("usage_denied")
    expect(fixture.statuses).toEqual(["released"])
  })

  it("keeps the reservation active when tree settlement itself fails", async () => {
    const fixture = store(async status => { if (status === "consumed") throw new Error("tree_store_unavailable") })
    const model = createUsageAwareModelAdapter(adapter(), { owner, treeBudget: fixture.store, authorize: vi.fn(async () => ({ settle: vi.fn(async () => undefined) })) })
    await expect((async () => { for await (const _event of model.stream(request)) return undefined })()).rejects.toThrow("tree_store_unavailable")
    expect(fixture.statuses).toEqual(["consumed"])
  })

  it("keeps the reservation active when account settlement is unknown", async () => {
    const fixture = store()
    const model = createUsageAwareModelAdapter(adapter(), {
      owner, treeBudget: fixture.store,
      authorize: vi.fn(async () => ({ settle: vi.fn(async () => { throw new Error("account_settlement_unknown") }) })),
    })
    await expect((async () => { for await (const _event of model.stream(request)) return undefined })()).rejects.toThrow("account_settlement_unknown")
    expect(fixture.statuses).toEqual([])
  })
})
