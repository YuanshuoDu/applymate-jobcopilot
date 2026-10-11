import { describe, expect, it } from "vitest"

import { cloneCompactionState, collectCompactionState } from "./context-compaction-collector.js"
import type { CompactionSource, CompactionState } from "./context-compaction-types.js"
import { projectSelectedJobMemory } from "./selected-job-memory.js"

const selectedJobMemories = [projectSelectedJobMemory({
  jobId: "job-a", sourceTurnId: "turn-a", sourceRootTaskId: "root-a", throughSequence: "7",
  graph: { revision: 1, nodes: [{ templateId: "scout", status: "completed", readiness: "terminal" }] },
})!]

const state: CompactionState = {
  ownerId: "user-a", sessionId: "session-a", throughSequence: 7n, goal: "Find a role",
  userConstraints: ["remote", "EU"], approvals: [{ id: "approval-1", status: "pending" }],
  answers: [{ id: "answer-1", question: "Work authorization", answer: "confirmed", answerHash: "answer-hash" }],
  artifacts: [{ id: "artifact-1", type: "resume", hash: "sha256:resume" }],
  openTasks: [{ taskId: "task-1", status: "running", blocker: null }], doNotRepeat: ["retry submit"],
  facts: [{ factId: "fact-1", key: "role", source: "user" }],
  selectedJobMemories,
}

function source(items: CompactionSource["items"], throughSequence = state.throughSequence): CompactionSource { return { state: { ...state, throughSequence }, items } }

describe("deterministic compaction collector", () => {
  it("orders items and state without mutating the source", () => {
    const items = [
      { id: "item-2", sessionId: "session-a", turnId: "turn-a", sequence: 2n, type: "agent_message", status: "completed", content: { z: 1, a: "second" } },
      { id: "item-1", sessionId: "session-a", turnId: "turn-a", sequence: 1n, type: "user_message", status: "completed", content: "first" },
    ] as const
    const collected = collectCompactionState(source(items, 2n))
    expect(collected.sourceItemIds).toEqual(["item-1", "item-2"])
    expect(collected.coveredSourceItemIds).toEqual(["item-1", "item-2"])
    expect(collected.coveredThroughSequence).toBe(2n)
    expect(collected.state.throughSequence).toBe(2n)
    expect(collected.narrativeText.indexOf("first" /* content is intentionally data-only */)).toBeGreaterThanOrEqual(0)
    expect(state.userConstraints).toEqual(["remote", "EU"])
  })

  it("keeps all source IDs for thresholds while bounding the covered whole-item prefix", () => {
    const items = Array.from({ length: 120 }, (_, index) => ({
      id: `item-${index.toString().padStart(3, "0")}`, sessionId: "session-a", turnId: "turn-a", sequence: BigInt(index + 1), type: "agent_message", status: "completed", content: "narrative ".repeat(3),
    }))
    const collected = collectCompactionState(source(items, 120n), 500)
    const coveredCount = collected.coveredSourceItemIds.length
    expect(collected.sourceItemIds).toHaveLength(120)
    expect(coveredCount).toBeGreaterThan(0)
    expect(coveredCount).toBeLessThan(120)
    expect(collected.coveredSourceItemIds).toEqual(items.slice(0, coveredCount).map(({ id }) => id))
    expect(collected.coveredThroughSequence).toBe(BigInt(coveredCount))
    expect(collected.coveredThroughSequence).toBeLessThan(120n)
    expect(collected.state.throughSequence).toBe(collected.coveredThroughSequence)
    expect(collected.coveredInputTokens).toBeGreaterThan(0)
    expect(collected.coveredInputTokens).toBeLessThan(collected.beforeInputTokens)
    expect(collected.narrativeText.length).toBeLessThanOrEqual(500)
    expect(collected.narrativeText).toBe(items.slice(0, coveredCount).map(item => `[${item.sequence.toString()}] ${item.type} ${item.content}`).join("\n"))
    expect(collected.beforeInputTokens).toBeGreaterThan(0)
  })

  it("includes an Item at the exact cap and excludes it whole when one character over", () => {
    const item = { id: "item-8", sessionId: "session-a", turnId: "turn-a", sequence: 8n, type: "agent_message", status: "completed", content: "whole item" }
    const rendered = "[8] agent_message whole item"
    const itemSource = { state: { ...state, throughSequence: 8n }, items: [item] }
    const exact = collectCompactionState(itemSource, rendered.length)
    expect(exact.narrativeText).toBe(rendered)
    expect(exact.coveredThroughSequence).toBe(8n)
    expect(exact.state.throughSequence).toBe(8n)
    expect(exact.coveredSourceItemIds).toEqual(["item-8"])

    const tooSmall = collectCompactionState(itemSource, rendered.length - 1)
    expect(tooSmall.narrativeText).toBe("")
    expect(tooSmall.coveredThroughSequence).toBeNull()
    expect(tooSmall.state).toEqual(collectCompactionState({ state: itemSource.state, items: [] }).state)
    expect(tooSmall.state.throughSequence).toBe(8n)
    expect(tooSmall.coveredSourceItemIds).toEqual([])
    expect(tooSmall.sourceItemIds).toEqual(["item-8"])
  })

  it("preserves the existing cursor for an actually empty source", () => {
    const collected = collectCompactionState(source([]))
    expect(collected.coveredThroughSequence).toBe(state.throughSequence)
    expect(collected.state.throughSequence).toBe(state.throughSequence)
  })

  it("keeps equal-sequence peers together when a cap would fit only part of their group", () => {
    const before = { id: "before", sessionId: "session-a", turnId: "turn-a", sequence: 8n, type: "agent_message", status: "completed", content: "safe prefix" }
    const peerA = { id: "peer-a", sessionId: "session-a", turnId: "turn-a", sequence: 9n, type: "agent_message", status: "completed", content: "peer A" }
    const peerB = { id: "peer-b", sessionId: "session-a", turnId: "turn-a", sequence: 9n, type: "user_input", status: "completed", content: { answer: "peer B" } }
    const beforeText = "[8] agent_message safe prefix"
    const peerAText = "[9] agent_message peer A"
    const sourceWithPeerAnswer = { state: { ...state, throughSequence: 9n, answers: [...state.answers, { id: "peer-b", question: "User input", answer: "peer B" }] }, items: [peerB, before, peerA] }
    const partialGroup = collectCompactionState(sourceWithPeerAnswer, beforeText.length + 1 + peerAText.length)
    expect(partialGroup.narrativeText).toBe(beforeText)
    expect(partialGroup.coveredSourceItemIds).toEqual(["before"])
    expect(partialGroup.coveredThroughSequence).toBe(8n)
    expect(partialGroup.state.throughSequence).toBe(8n)
    expect(partialGroup.state.answers.filter(answer => answer.id === "peer-b")).toEqual([{ id: "peer-b", question: "User input", answer: "peer B" }])

    const completeText = `${beforeText}\n${peerAText}\n[9] user_input {"answer":"peer B"}`
    const completeGroup = collectCompactionState(sourceWithPeerAnswer, completeText.length)
    expect(completeGroup.narrativeText).toBe(completeText)
    expect(completeGroup.coveredSourceItemIds).toEqual(["before", "peer-a", "peer-b"])
    expect(completeGroup.coveredThroughSequence).toBe(9n)
    expect(completeGroup.state.throughSequence).toBe(9n)
    expect(completeGroup.state.answers.filter(answer => answer.id === "peer-b")).toEqual([{ id: "peer-b", question: "User input", answer: "peer B" }])
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
    expect(cloned.selectedJobMemories).toEqual(selectedJobMemories)
    expect(cloned.selectedJobMemories).not.toBe(selectedJobMemories)
  })

  it("normalizes legacy missing memory and fails closed on invalid typed records", () => {
    const collected = collectCompactionState({ state: { ...state, selectedJobMemories: undefined }, items: [] })
    expect(collected.state.selectedJobMemories).toEqual([])
    expect(() => collectCompactionState({ state: { ...state, selectedJobMemories: [{ ...selectedJobMemories[0], jobId: "tampered" }] }, items: [] })).toThrow("selectedJobMemories")
  })
})
