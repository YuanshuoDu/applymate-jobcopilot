import { describe, expect, it, vi } from "vitest"

import { ContextCompactor } from "./context-compactor.js"
import type { ContextSnapshotCompactionPort, CompactionSnapshotRef } from "./context-snapshot-compaction-seam.js"
import type { CompactionRequest, CompactionSource } from "./context-compaction-types.js"

const source: CompactionSource = {
  state: {
    ownerId: "user-a", sessionId: "session-a", throughSequence: 120n, goal: "Find a role", userConstraints: ["EU"],
    approvals: [{ id: "approval-1", status: "pending" }], answers: [{ id: "answer-1", question: "Permit", answer: "yes" }],
    artifacts: [{ id: "artifact-1", type: "resume", hash: "hash-1" }], openTasks: [{ taskId: "task-1", status: "open", blocker: null }],
    doNotRepeat: ["bad path"], facts: [{ factId: "fact-1", key: "role", source: "user" }],
  },
  items: Array.from({ length: 120 }, (_, index) => ({ id: `item-${index.toString().padStart(3, "0")}`, sessionId: "session-a", turnId: "turn-a", sequence: BigInt(index), type: "agent_message", status: "completed", content: `long narrative item ${index} `.repeat(20) })),
}

function request(overrides: Partial<CompactionRequest> = {}): CompactionRequest {
  return { scope: { userId: "user-a" }, turnId: "turn-a", source, policy: { inputTokenThreshold: 10, itemCountThreshold: 100, compactAtTurnBoundary: true }, atTurnBoundary: false, requested: false, version: 1, ...overrides }
}

function port(overrides: Partial<ContextSnapshotCompactionPort> = {}): ContextSnapshotCompactionPort {
  const ref: CompactionSnapshotRef = { id: "snapshot-1", sessionId: "session-a", throughSequence: 0n, version: 1 }
  return { loadLatest: vi.fn(async () => ref), recordStarted: vi.fn(async () => undefined), publishAtomically: vi.fn(async () => ({ id: "snapshot-2", sessionId: "session-a", throughSequence: 120n, version: 2 })), recordFailed: vi.fn(async () => undefined), ...overrides }
}

describe("ContextCompactor", () => {
  it("compacts 100+ Items with a bounded summary and measured token reduction", async () => {
    const runtime = port()
    let receivedText = ""
    const result = await new ContextCompactor(runtime, async (input) => { receivedText = input.narrativeText; return "condensed narrative" }, () => "compaction-item").compact(request())
    expect(result.status).toBe("compacted")
    expect(result.tokenMeasurement).toMatchObject({ beforeInputTokens: expect.any(Number), afterInputTokens: expect.any(Number), reductionTokens: expect.any(Number) })
    expect(result.tokenMeasurement?.reductionTokens).toBeGreaterThan(0)
    expect(receivedText.length).toBeLessThanOrEqual(24_000)
    expect(result.item).toMatchObject({ type: "context_compaction", status: "completed", id: "compaction-item" })
    expect(runtime.publishAtomically).toHaveBeenCalledOnce()
  })

  it("keeps the old snapshot and emits a visible failed Item when atomic publish fails", async () => {
    const runtime = port({ publishAtomically: vi.fn(async () => { throw new Error("database unavailable") }) })
    const result = await new ContextCompactor(runtime, () => "safe summary", () => "compaction-item").compact(request())
    expect(result.status).toBe("failed")
    expect(result.item).toMatchObject({ status: "failed", data: { previousSnapshotRetained: true, errorCode: "publish_failed" } })
    expect(runtime.recordFailed).toHaveBeenCalledOnce()
    expect(result.item?.body).toContain("previous snapshot retained")
  })

  it("does not claim a snapshot was retained when none existed", async () => {
    const runtime = port({
      loadLatest: vi.fn(async () => null),
      publishAtomically: vi.fn(async () => { throw new Error("database unavailable") }),
    })
    const result = await new ContextCompactor(runtime, () => "safe summary", () => "compaction-item").compact(request())
    expect(result.item).toMatchObject({ status: "failed", data: { previousSnapshotRetained: false } })
    expect(result.item?.body).toContain("no previous snapshot was available")
  })

  it("rejects a summarizer that cannot reduce tokens and reports the failure", async () => {
    const runtime = port()
    const result = await new ContextCompactor(runtime, (input) => "x".repeat(input.maxOutputCharacters), () => "compaction-item").compact(request({ source: { state: source.state, items: [source.items[0]] }, requested: true }))
    expect(result.status).toBe("failed")
    expect(result.errorCode).toBe("no_token_reduction")
    expect(runtime.publishAtomically).not.toHaveBeenCalled()
  })

  it("isolates invariant state from a summarizer mutation", async () => {
    const runtime = port()
    const result = await new ContextCompactor(runtime, (input) => {
      const state = input.state as unknown as { goal: string; answers: Array<{ answer: string }> }
      state.goal = "attacker goal"
      state.answers[0].answer = "attacker answer"
      return "safe summary"
    }, () => "compaction-item").compact(request())
    expect(result.status).toBe("compacted")
    expect(result.snapshot).toMatchObject({ throughSequence: 120n })
    expect(result.invariantReport).toMatchObject({ preserved: true, changedFields: [], missingFields: [] })
    const published = (runtime.publishAtomically as ReturnType<typeof vi.fn>).mock.calls[0][0] as { draft: { state: { goal: string; answers: Array<{ answer: string }> } } }
    expect(published.draft.state.goal).toBe("Find a role")
    expect(published.draft.state.answers[0].answer).toBe("yes")
  })

  it("does not create lifecycle Items when the trigger is not due", async () => {
    const runtime = port()
    const result = await new ContextCompactor(runtime, () => "summary", () => "compaction-item").compact(request({ policy: { inputTokenThreshold: 999_999, itemCountThreshold: 999_999, compactAtTurnBoundary: false } }))
    expect(result).toMatchObject({ status: "skipped", item: null })
    expect(runtime.recordStarted).not.toHaveBeenCalled()
  })
})
