import { describe, expect, it, vi } from "vitest"

import { ContextCompactor } from "./context-compactor.js"
import { collectCompactionState } from "./context-compaction-collector.js"
import type { ContextSnapshotCompactionPort, CompactionSnapshotRef } from "./context-snapshot-compaction-seam.js"
import type { CompactionRequest, CompactionSource } from "./context-compaction-types.js"

const source: CompactionSource = {
  state: {
    ownerId: "user-a", sessionId: "session-a", throughSequence: 119n, goal: "Find a role", userConstraints: ["EU"],
    approvals: [{ id: "approval-1", status: "pending" }], answers: [{ id: "answer-1", question: "Permit", answer: "yes" }],
    artifacts: [{ id: "artifact-1", type: "resume", hash: "hash-1" }], openTasks: [{ taskId: "task-1", status: "open", blocker: null }],
    doNotRepeat: ["bad path"], facts: [{ factId: "fact-1", key: "role", source: "user" }],
  },
  items: Array.from({ length: 120 }, (_, index) => ({ id: `item-${index.toString().padStart(3, "0")}`, sessionId: "session-a", turnId: "turn-a", sequence: BigInt(index), type: "agent_message", status: "completed", content: `long narrative item ${index} `.repeat(20) })),
}

function request(overrides: Partial<CompactionRequest> = {}): CompactionRequest {
  return { scope: { userId: "user-a" }, turnId: "turn-a", source, policy: { inputTokenThreshold: 10, itemCountThreshold: 100, compactAtTurnBoundary: true }, atTurnBoundary: false, requested: false, ...overrides }
}

function port(overrides: Partial<ContextSnapshotCompactionPort> = {}): ContextSnapshotCompactionPort {
  const ref: CompactionSnapshotRef = { id: "snapshot-1", sessionId: "session-a", throughSequence: 0n, version: 1 }
  return { loadLatest: vi.fn(async () => ref), recordStarted: vi.fn(async () => undefined), publishAtomically: vi.fn(async (input: Parameters<ContextSnapshotCompactionPort["publishAtomically"]>[0]) => ({ id: "snapshot-2", sessionId: "session-a", throughSequence: input.draft.state.throughSequence, version: 2 })), recordFailed: vi.fn(async () => undefined), ...overrides }
}

describe("ContextCompactor", () => {
  it("publishes only whole covered Items while preserving source-based trigger thresholds", async () => {
    const runtime = port()
    const collection = collectCompactionState(source)
    let receivedText = ""
    let receivedThroughSequence = -1n
    let receivedItemCount = -1
    const result = await new ContextCompactor(runtime, async (input) => {
      receivedText = input.narrativeText
      receivedThroughSequence = input.throughSequence
      receivedItemCount = input.itemCount
      return "condensed narrative"
    }, () => "compaction-item").compact(request({ policy: { inputTokenThreshold: collection.coveredInputTokens + 1, itemCountThreshold: source.items.length + 1, compactAtTurnBoundary: false } }))
    expect(result.status).toBe("compacted")
    expect(result.trigger.reason).toBe("input_tokens")
    expect(result.tokenMeasurement).toMatchObject({ beforeInputTokens: expect.any(Number), afterInputTokens: expect.any(Number), reductionTokens: expect.any(Number) })
    expect(result.tokenMeasurement?.beforeInputTokens).toBe(collection.coveredInputTokens)
    expect(result.tokenMeasurement?.reductionTokens).toBeGreaterThan(0)
    expect(receivedText.length).toBeLessThanOrEqual(24_000)
    const published = (runtime.publishAtomically as ReturnType<typeof vi.fn>).mock.calls[0][0] as { draft: { state: { throughSequence: bigint }; sourceItemIds: readonly string[] }; completedItem: { data: { throughSequence: string } } }
    const coveredCount = published.draft.sourceItemIds.length
    expect(coveredCount).toBeGreaterThan(0)
    expect(coveredCount).toBeLessThan(source.items.length)
    expect(published.draft.sourceItemIds).toEqual(source.items.slice(0, coveredCount).map(({ id }) => id))
    expect(published.draft.state.throughSequence).toBe(source.items[coveredCount - 1]?.sequence)
    expect(result.snapshot?.throughSequence).toBe(published.draft.state.throughSequence)
    expect(published.completedItem.data.throughSequence).toBe(published.draft.state.throughSequence.toString())
    expect(result.item?.data.throughSequence).toBe(published.draft.state.throughSequence.toString())
    expect(receivedThroughSequence).toBe(published.draft.state.throughSequence)
    expect(receivedItemCount).toBe(coveredCount)
    expect(result.item).toMatchObject({ type: "context_compaction", status: "completed", id: "compaction-item" })
    expect(runtime.publishAtomically).toHaveBeenCalledOnce()
  })

  it("retains the prior snapshot without model or publish when the first sequence group exceeds the cap", async () => {
    const runtime = port()
    const summarizer = vi.fn(async () => "must not be called")
    const oversizedSource: CompactionSource = {
      state: { ...source.state, throughSequence: 121n },
      items: [{ id: "oversized-item", sessionId: "session-a", turnId: "turn-a", sequence: 121n, type: "agent_message", status: "completed", content: "x".repeat(24_100) }],
    }
    const result = await new ContextCompactor(runtime, summarizer, () => "compaction-item").compact(request({ source: oversizedSource, requested: true }))
    expect(result.status).toBe("failed")
    expect(result.errorCode).toBe("invalid_source")
    expect(result.item).toMatchObject({ status: "failed", data: { previousSnapshotRetained: true } })
    expect(summarizer).not.toHaveBeenCalled()
    expect(runtime.recordStarted).toHaveBeenCalledOnce()
    expect(runtime.recordFailed).toHaveBeenCalledOnce()
    expect(runtime.publishAtomically).not.toHaveBeenCalled()
  })

  it("fails without publishing when covered history does not advance the prior snapshot cursor", async () => {
    const priorSnapshot: CompactionSnapshotRef = { id: "snapshot-prior", sessionId: "session-a", throughSequence: 100n, version: 4 }
    const runtime = port({ loadLatest: vi.fn(async () => priorSnapshot) })
    const stalePrefixSource: CompactionSource = {
      state: { ...source.state, throughSequence: 110n },
      items: [
        { id: "compaction-at-100", sessionId: "session-a", turnId: "turn-prior", sequence: 100n, type: "context_compaction", status: "completed", content: "Summary through sequence 100" },
        { id: "oversized-fresh-item", sessionId: "session-a", turnId: "turn-a", sequence: 110n, type: "agent_message", status: "completed", content: "x".repeat(24_100) },
      ],
    }
    const collected = collectCompactionState(stalePrefixSource)
    expect(collected.coveredThroughSequence).toBe(100n)
    expect(collected.sourceItemIds).toEqual(["compaction-at-100"])
    const summarizer = vi.fn(async () => "must not be called")
    const result = await new ContextCompactor(runtime, summarizer, () => "compaction-item").compact(request({ source: stalePrefixSource, requested: true }))
    expect(result.status).toBe("failed")
    expect(result.errorCode).toBe("invalid_source")
    expect(result.item).toMatchObject({ status: "failed", data: { previousSnapshotRetained: true } })
    expect(summarizer).not.toHaveBeenCalled()
    expect(runtime.recordFailed).toHaveBeenCalledOnce()
    expect(runtime.publishAtomically).not.toHaveBeenCalled()
  })

  it("preserves structured answers when a related user-input Item is outside the covered prefix", async () => {
    const runtime = port()
    const partialSource: CompactionSource = {
      state: {
        ...source.state,
        throughSequence: 12n,
        answers: [
          { id: "answer-1", question: "Prior", answer: "preserve" },
          { id: "covered-input", question: "Covered", answer: "summarized" },
          { id: "uncovered-input", question: "Uncovered", answer: "not summarized yet" },
        ],
      },
      items: [
        { id: "covered-prefix", sessionId: "session-a", turnId: "turn-a", sequence: 10n, type: "agent_message", status: "completed", content: "covered prefix" },
        { id: "covered-input", sessionId: "session-a", turnId: "turn-a", sequence: 11n, type: "user_input", status: "completed", content: { answer: "summarized" } },
        { id: "covered-peer", sessionId: "session-a", turnId: "turn-a", sequence: 11n, type: "agent_message", status: "completed", content: "covered peer" },
        { id: "uncovered-input", sessionId: "session-a", turnId: "turn-a", sequence: 12n, type: "user_input", status: "completed", content: "x".repeat(24_100) },
      ],
    }
    let receivedAnswers: readonly { id: string }[] = []
    let receivedText = ""
    const result = await new ContextCompactor(runtime, (input) => {
      receivedAnswers = input.state.answers
      receivedText = input.narrativeText
      return "covered summary"
    }, () => "compaction-item").compact(request({ source: partialSource, requested: true }))
    expect(result.status).toBe("compacted")
    expect(result.snapshot?.throughSequence).toBe(11n)
    expect(result.item?.data.throughSequence).toBe("11")
    expect(receivedAnswers.map(({ id }) => id)).toEqual(["answer-1", "covered-input", "uncovered-input"])
    expect(receivedText).not.toContain("not summarized yet")
    const published = (runtime.publishAtomically as ReturnType<typeof vi.fn>).mock.calls[0][0] as { draft: { sourceItemIds: readonly string[]; state: { answers: readonly { id: string }[]; throughSequence: bigint } }; completedItem: { data: { throughSequence: string } } }
    expect(published.draft.sourceItemIds).toEqual(["covered-prefix", "covered-input", "covered-peer"])
    expect(published.draft.state.throughSequence).toBe(11n)
    expect(published.draft.state.answers.map(({ id }) => id)).toEqual(["answer-1", "covered-input", "uncovered-input"])
    expect(published.completedItem.data.throughSequence).toBe("11")
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
    const oneItemSource: CompactionSource = { state: { ...source.state, throughSequence: source.items[1]!.sequence }, items: [source.items[1]!] }
    const result = await new ContextCompactor(runtime, (input) => "x".repeat(input.maxOutputCharacters), () => "compaction-item").compact(request({ source: oneItemSource, requested: true }))
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
    const published = (runtime.publishAtomically as ReturnType<typeof vi.fn>).mock.calls[0][0] as { draft: { state: { goal: string; answers: Array<{ answer: string }>; throughSequence: bigint } }; completedItem: { data: { throughSequence: string } } }
    expect(result.snapshot?.throughSequence).toBe(published.draft.state.throughSequence)
    expect(result.item?.data.throughSequence).toBe(published.draft.state.throughSequence.toString())
    expect(published.completedItem.data.throughSequence).toBe(published.draft.state.throughSequence.toString())
    expect(result.invariantReport).toMatchObject({ preserved: true, changedFields: [], missingFields: [] })
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
