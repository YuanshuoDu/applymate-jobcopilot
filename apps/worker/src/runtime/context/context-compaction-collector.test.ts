import { describe, expect, it } from "vitest"

import { cloneCompactionState, collectCompactionState } from "./context-compaction-collector.js"
import type { CompactionSource, CompactionState } from "./context-compaction-types.js"

const state: CompactionState = {
  ownerId: "user-a", sessionId: "session-a", throughSequence: 7n, goal: "Find a role",
  userConstraints: ["remote", "EU"], approvals: [{ id: "approval-1", status: "pending" }],
  answers: [{ id: "answer-1", question: "Work authorization", answer: "confirmed", answerHash: "answer-hash" }],
  artifacts: [{ id: "artifact-1", type: "resume", hash: "sha256:resume" }],
  openTasks: [{ taskId: "task-1", status: "running", blocker: null }], doNotRepeat: ["retry submit"],
  facts: [{ factId: "fact-1", key: "role", source: "user" }],
}

function source(items: CompactionSource["items"]): CompactionSource { return { state, items } }

describe("deterministic compaction collector", () => {
  it("orders items and state without mutating the source", () => {
    const items = [
      { id: "item-2", sessionId: "session-a", turnId: "turn-a", sequence: 2n, type: "agent_message", status: "completed", content: { z: 1, a: "second" } },
      { id: "item-1", sessionId: "session-a", turnId: "turn-a", sequence: 1n, type: "user_message", status: "completed", content: "first" },
    ] as const
    const collected = collectCompactionState(source(items))
    expect(collected.sourceItemIds).toEqual(["item-1", "item-2"])
    expect(collected.narrativeText.indexOf("first" /* content is intentionally data-only */)).toBeGreaterThanOrEqual(0)
    expect(state.userConstraints).toEqual(["remote", "EU"])
  })

  it("keeps all 120 source IDs while bounding summarizer input", () => {
    const items = Array.from({ length: 120 }, (_, index) => ({
      id: `item-${index.toString().padStart(3, "0")}`, sessionId: "session-a", turnId: "turn-a", sequence: BigInt(index), type: "agent_message", status: "completed", content: "narrative ".repeat(50),
    }))
    const collected = collectCompactionState(source(items), 500)
    expect(collected.sourceItemIds).toHaveLength(120)
    expect(collected.narrativeText.length).toBe(500)
    expect(collected.beforeInputTokens).toBeGreaterThan(0)
  })

  it("fails closed for duplicate items and missing invariant fields", () => {
    const item = { id: "item-1", sessionId: "session-a", turnId: "turn-a", sequence: 1n, type: "agent_message", status: "completed", content: "x" }
    expect(() => collectCompactionState(source([item, item]))).toThrow("duplicate ids")
    expect(() => collectCompactionState(source([item]), 1)).not.toThrow()
    expect(() => collectCompactionState({ state: { ...state, answers: undefined } as unknown as CompactionState, items: [item] })).toThrow("answers")
  })

  it("clones the normalized state before it is handed to snapshot persistence", () => {
    const cloned = cloneCompactionState(state)
    expect(cloned).toEqual(state)
    expect(cloned.userConstraints).not.toBe(state.userConstraints)
    expect(cloned.approvals).not.toBe(state.approvals)
    expect(cloned.approvals[0]).not.toBe(state.approvals[0])
    expect(cloned.openTasks).not.toBe(state.openTasks)
  })
})
