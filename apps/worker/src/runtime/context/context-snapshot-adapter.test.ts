import { describe, expect, it, vi } from "vitest"

import { createContextSnapshotAdapter, type ContextSnapshotAdapterStore } from "./context-snapshot-adapter.js"
import type { StepContextSnapshot } from "./step-context-builder.js"

const scope = { userId: "user-1" }
const base: StepContextSnapshot = {
  system: [{ id: "system", content: "keep" }], profile: [{ id: "profile", content: "keep" }], goal: { id: "goal", content: "keep" },
  steerHistory: [{ id: "steer", content: "keep" }], businessRefs: [{ id: "ref", kind: "job", ownerId: "user-1" }], toolObservations: [],
}

function observations(count: number): StepContextSnapshot {
  return { ...base, toolObservations: Array.from({ length: count }, (_, index) => ({ id: `tool-${index}`, content: { text: "x".repeat(500) } })) }
}

function store(overrides: Partial<ContextSnapshotAdapterStore> = {}): ContextSnapshotAdapterStore & { saved: Array<{ snapshotRef: string; scope: typeof scope; sessionId: string; turnId: string; stepId: string; idempotencyKey: string; snapshot: StepContextSnapshot }>; loadedInput?: unknown } {
  const saved: Array<{ snapshotRef: string; scope: typeof scope; sessionId: string; turnId: string; stepId: string; idempotencyKey: string; snapshot: StepContextSnapshot }> = []
  return {
    saved,
    save: async input => { saved.push(input); return { snapshotRef: input.snapshotRef, scope: input.scope, sessionId: input.sessionId, turnId: input.turnId } },
    load: async input => { return { snapshot: base, scope: input.scope, sessionId: input.sessionId, turnId: input.turnId } },
    loadByIdempotencyKey: async input => saved.find(item => item.scope.userId === input.scope.userId && item.sessionId === input.sessionId && item.turnId === input.turnId && item.stepId === input.stepId && item.idempotencyKey === input.idempotencyKey) ?? null,
    ...overrides,
  }
}

function request(snapshot: StepContextSnapshot) {
  return { identity: { kind: "turn" as const, userId: "user-1", sessionId: "session-1", turnId: "turn-1", taskId: "root-1", rootTaskId: "root-1", ownerId: "worker-1", leaseVersion: 1, leaseExpiresAt: new Date("2026-09-12T00:00:00Z") }, scope, sessionId: "session-1", turnId: "turn-1", stepId: "turn:turn-1:step:0", signal: new AbortController().signal, now: new Date("2026-09-12T00:00:00Z"), snapshot, estimatedInputTokens: 0, estimatedBytes: 0, idempotencyKey: "context-compaction:turn:turn-1:step:0" }
}

describe("StepContextSnapshot adapter", () => {
  it("does nothing below the observation threshold and protects fields", async () => {
    const backing = store()
    const adapter = createContextSnapshotAdapter({ store: backing, observationCountThreshold: 4, keepRecentObservations: 1 })
    const value = await adapter.hook(request(observations(2)))
    expect(value).toEqual({ status: "unchanged", snapshot: observations(2) })
    expect(backing.saved).toHaveLength(0)
  })

  it("deterministically reduces observations and saves an opaque ref", async () => {
    const backing = store()
    const summarizer = vi.fn(() => ({ removed: "safe summary" }))
    const adapter = createContextSnapshotAdapter({ store: backing, observationCountThreshold: 3, keepRecentObservations: 1, summarizer })
    const input = request(observations(3))
    const first = await adapter.hook(input)
    const second = await adapter.hook(input)
    expect(first).toEqual(second)
    expect(first).toMatchObject({ status: "compacted", snapshot: { toolObservations: [{ id: "context-summary:turn:turn-1:step:0" }, { id: "tool-2" }] } })
    expect(summarizer).toHaveBeenCalledTimes(1)
    expect(backing.saved).toHaveLength(1)
    expect(backing.saved[0]?.snapshotRef).toMatch(/^[0-9a-f]{64}$/)
    expect(first.snapshot.system).toEqual(base.system)
    expect(first.snapshot.profile).toEqual(base.profile)
    expect(first.snapshot.goal).toEqual(base.goal)
    expect(first.snapshot.steerHistory).toEqual(base.steerHistory)
    expect(first.snapshot.businessRefs).toEqual(base.businessRefs)
    const rebuilt = createContextSnapshotAdapter({ store: backing, observationCountThreshold: 3, keepRecentObservations: 1, summarizer })
    const third = await rebuilt.hook(input)
    expect(third).toMatchObject({ status: "compacted", snapshotRef: first.status === "compacted" ? first.snapshotRef : "" })
    expect(summarizer).toHaveBeenCalledTimes(1)
    expect(backing.saved).toHaveLength(1)
  })

  it("keeps the runtime snapshot ceiling at 256 KiB", async () => {
    expect(() => createContextSnapshotAdapter({ store: store(), observationCountThreshold: 2, keepRecentObservations: 1, maxSnapshotBytes: 256 * 1024 + 1 })).toThrow("bound")
    const oversized = { ...base, toolObservations: Array.from({ length: 600 }, (_, index) => ({ id: `large-${index}`, content: { text: "x".repeat(600) } })) }
    const adapter = createContextSnapshotAdapter({ store: store(), inputTokenThreshold: 1, observationCountThreshold: Number.MAX_SAFE_INTEGER, keepRecentObservations: 1 })
    await expect(adapter.hook(request(oversized))).rejects.toThrow("exceeds its bound")
  })

  it("fails closed on a corrupt persisted idempotency hit instead of compacting again", async () => {
    const summarizer = vi.fn(() => ({ removed: "should not run" }))
    const backing = store({ loadByIdempotencyKey: async input => ({ snapshotRef: "corrupt", scope: input.scope, sessionId: input.sessionId, turnId: input.turnId, stepId: input.stepId, idempotencyKey: input.idempotencyKey, snapshot: observations(3) }) })
    const adapter = createContextSnapshotAdapter({ store: backing, observationCountThreshold: 3, keepRecentObservations: 1, summarizer })
    await expect(adapter.hook(request(observations(3)))).rejects.toThrow("idempotent snapshot")
    expect(summarizer).not.toHaveBeenCalled()
    expect(backing.saved).toHaveLength(0)
  })

  it("fails closed when summarizer or store fails", async () => {
    const summarizer = vi.fn(() => { throw new Error("summary failure") })
    const first = createContextSnapshotAdapter({ store: store(), observationCountThreshold: 2, keepRecentObservations: 1, summarizer })
    await expect(first.hook(request(observations(2)))).rejects.toThrow()
    const failingStore = store({ save: async () => { throw new Error("store failure") } })
    const second = createContextSnapshotAdapter({ store: failingStore, observationCountThreshold: 2, keepRecentObservations: 1 })
    await expect(second.hook(request(observations(2)))).rejects.toThrow()
    const foreignStore = store({ save: async input => ({ snapshotRef: input.snapshotRef, scope: { userId: "foreign" }, sessionId: input.sessionId, turnId: input.turnId }) })
    const third = createContextSnapshotAdapter({ store: foreignStore, observationCountThreshold: 2, keepRecentObservations: 1 })
    await expect(third.hook(request(observations(2)))).rejects.toThrow()
    const invalidSummary = createContextSnapshotAdapter({ store: store(), observationCountThreshold: 2, keepRecentObservations: 1, summarizer: () => new Date() })
    await expect(invalidSummary.hook(request(observations(2)))).rejects.toThrow()
  })

  it("passes scoped loader identity and rejects a foreign response", async () => {
    const backing = store()
    const adapter = createContextSnapshotAdapter({ store: backing, observationCountThreshold: 2, keepRecentObservations: 1 })
    const input = { snapshotRef: "opaque-ref", scope, sessionId: "session-1", turnId: "turn-1" }
    await expect(adapter.loadSnapshot(input)).resolves.toMatchObject({ scope, sessionId: "session-1", turnId: "turn-1" })
    const foreign = createContextSnapshotAdapter({ store: store({ load: async request => ({ snapshot: base, scope: request.scope, sessionId: "foreign", turnId: request.turnId }) }), observationCountThreshold: 2, keepRecentObservations: 1 })
    await expect(foreign.loadSnapshot(input)).resolves.toBeNull()
  })
})
