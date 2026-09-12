import { describe, expect, it, vi } from "vitest"

import { runContextCompaction } from "./context-compaction-runtime.js"
import type { ContextCompactionHook } from "./context-snapshot-compaction-seam.js"
import type { StepContextSnapshot } from "./step-context-builder.js"
import type { ExecutionOwnerFence } from "../execution-owner.js"

const owner: ExecutionOwnerFence = {
  kind: "turn", userId: "user-1", sessionId: "session-1", turnId: "turn-1", taskId: "root-1", rootTaskId: "root-1",
  ownerId: "worker-1", leaseVersion: 1, leaseExpiresAt: new Date("2026-09-12T00:00:00Z"),
}
const snapshot: StepContextSnapshot = { system: [], profile: [], steerHistory: [], businessRefs: [], toolObservations: [] }

function input(hook?: ContextCompactionHook, current = snapshot, loadSnapshot?: Parameters<typeof runContextCompaction>[0]["loadSnapshot"]): { events: unknown[]; value: Parameters<typeof runContextCompaction>[0] } {
  const events: unknown[] = []
  return { events, value: { hook, loadSnapshot, identity: owner, scope: { userId: owner.userId }, sessionId: owner.sessionId, turnId: owner.turnId, stepId: "step:0", signal: new AbortController().signal, now: new Date("2026-09-12T00:00:00Z"), snapshot: current, append: async (payload: unknown) => { events.push(payload) } } }
}

describe("context compaction runtime seam", () => {
  it("keeps the legacy snapshot unchanged when no hook is configured", async () => {
    const value = input()
    await expect(runContextCompaction(value.value)).resolves.toEqual({ snapshot })
    expect(value.events).toEqual([])
  })

  it("records a bounded unchanged projection and passes controlled estimates", async () => {
    const hook = vi.fn(async (request: Parameters<ContextCompactionHook>[0]) => ({ status: "unchanged" as const, snapshot: request.snapshot }))
    const value = input(hook)
    const result = await runContextCompaction(value.value)
    expect(result.snapshot.toolObservations[0]?.content).toMatchObject({ kind: "context_compacted", status: "unchanged", stepId: "step:0" })
    expect(hook).toHaveBeenCalledWith(expect.objectContaining({ estimatedInputTokens: expect.any(Number), estimatedBytes: expect.any(Number), idempotencyKey: "context-compaction:step:0" }))
    expect(value.events).toHaveLength(1)
  })

  it("accepts a compacted replacement without persisting sensitive context", async () => {
    const original: StepContextSnapshot = { ...snapshot, toolObservations: [{ id: "secret", content: { apiKey: "do-not-persist" } }] }
    const hook = vi.fn(async (request: Parameters<ContextCompactionHook>[0]) => ({ status: "compacted" as const, snapshot: { ...request.snapshot, toolObservations: [] }, snapshotRef: "snapshot-compact-1" }))
    const value = input(hook, original)
    const result = await runContextCompaction(value.value)
    expect(result.snapshot.toolObservations).toHaveLength(1)
    expect(JSON.stringify(value.events)).not.toContain("do-not-persist")
  })

  it("fails closed on hook errors and emits only a diagnostic projection", async () => {
    const hook: ContextCompactionHook = () => { throw new Error("raw secret should not escape") }
    const value = input(hook)
    await expect(runContextCompaction(value.value)).rejects.toMatchObject({ code: "invalid_output" })
    expect(value.events[0]).toMatchObject({ kind: "context_compacted", status: "failed", errorCode: "context_compaction_failed" })
    expect(JSON.stringify(value.events)).not.toContain("raw secret")
  })

  it("replays a persisted projection without invoking the hook again", async () => {
    const current: StepContextSnapshot = { ...snapshot, toolObservations: [{ id: "context-compacted:step:0", content: {
      kind: "context_compacted", status: "compacted", stepId: "step:0", idempotencyKey: "context-compaction:step:0",
      beforeInputTokens: 1, afterInputTokens: 1, beforeBytes: 1, afterBytes: 1, snapshotRef: "snapshot-compact-1",
    } }] }
    const hook = vi.fn()
    const value = input(hook, current, async request => {
      expect(request).toMatchObject({ snapshotRef: "snapshot-compact-1", scope: { userId: "user-1" }, sessionId: "session-1", turnId: "turn-1" })
      return { snapshot: { ...snapshot, toolObservations: [{ id: "new", content: { compacted: true } }] }, scope: request.scope, sessionId: request.sessionId, turnId: request.turnId }
    })
    const result = await runContextCompaction(value.value)
    expect(result.snapshot.toolObservations.map(item => item.id)).toEqual(expect.arrayContaining(["new", "context-compacted:step:0"]))
    expect(hook).not.toHaveBeenCalled()
    expect(value.events).toEqual([])
  })

  it("replays an unchanged projection without requiring a snapshot loader", async () => {
    const current: StepContextSnapshot = { ...snapshot, toolObservations: [{ id: "context-compacted:step:0", content: {
      kind: "context_compacted", status: "unchanged", stepId: "step:0", idempotencyKey: "context-compaction:step:0",
      beforeInputTokens: 1, afterInputTokens: 1, beforeBytes: 1, afterBytes: 1,
    } }] }
    const value = input(undefined, current)
    await expect(runContextCompaction(value.value)).resolves.toEqual({ snapshot: current })
    expect(value.events).toEqual([])
  })

  it("rejects a hook that changes protected snapshot invariants", async () => {
    const hook = vi.fn(async (request: Parameters<ContextCompactionHook>[0]) => ({ status: "compacted" as const, snapshot: { ...request.snapshot, system: [{ id: "changed", content: "no" }] }, snapshotRef: "snapshot-compact-2" }))
    const value = input(hook)
    await expect(runContextCompaction(value.value)).rejects.toMatchObject({ code: "invalid_output" })
    expect(value.events[0]).toMatchObject({ kind: "context_compacted", status: "failed", errorCode: "context_compaction_failed" })
  })

  it("rejects a loader response from another session", async () => {
    const current: StepContextSnapshot = { ...snapshot, toolObservations: [{ id: "context-compacted:step:0", content: {
      kind: "context_compacted", status: "compacted", stepId: "step:0", idempotencyKey: "context-compaction:step:0",
      beforeInputTokens: 1, afterInputTokens: 0, beforeBytes: 1, afterBytes: 0, snapshotRef: "snapshot-compact-1",
    } }] }
    const value = input(undefined, current, async request => ({ snapshot, scope: request.scope, sessionId: "foreign-session", turnId: request.turnId }))
    await expect(runContextCompaction(value.value)).rejects.toMatchObject({ code: "invalid_output" })
  })

  it("fails closed for a malformed loader response", async () => {
    const current: StepContextSnapshot = { ...snapshot, toolObservations: [{ id: "context-compacted:step:0", content: {
      kind: "context_compacted", status: "compacted", stepId: "step:0", idempotencyKey: "context-compaction:step:0",
      beforeInputTokens: 1, afterInputTokens: 0, beforeBytes: 1, afterBytes: 0, snapshotRef: "snapshot-compact-1",
    } }] }
    const value = input(undefined, current, async () => ({ scope: null } as never))
    await expect(runContextCompaction(value.value)).rejects.toMatchObject({ code: "invalid_output" })
  })

  it("sanitizes loader exceptions during replay", async () => {
    const current: StepContextSnapshot = { ...snapshot, toolObservations: [{ id: "context-compacted:step:0", content: {
      kind: "context_compacted", status: "compacted", stepId: "step:0", idempotencyKey: "context-compaction:step:0",
      beforeInputTokens: 1, afterInputTokens: 0, beforeBytes: 1, afterBytes: 0, snapshotRef: "snapshot-compact-1",
    } }] }
    const value = input(undefined, current, async () => { throw new Error("sensitive loader details") })
    const error = await runContextCompaction(value.value).catch(value => value as Error) as unknown as Error
    expect(error).toMatchObject({ code: "invalid_output", message: "Compacted snapshot replay failed closed" })
    expect(error.message).not.toContain("sensitive loader details")
  })
})
