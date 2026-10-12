import { describe, expect, it, vi } from "vitest"
import { createTaskGraphDenialProgressTracker, taskGraphDenialProgressFor, taskGraphDenialProgressMatches } from "./task-graph-denial-progress.js"
import { TASK_GRAPH_DENIAL_CHECKPOINT_SCHEMA } from "./task-graph-terminal-assessment.js"

const checkpoint = { schemaVersion: TASK_GRAPH_DENIAL_CHECKPOINT_SCHEMA, taskId: "root-1", graphRevision: 4, verificationDigest: "a".repeat(64) } as const
const context = { taskGraphRevision: 4, inputThroughSequence: 12n, consumedInputIds: ["input-1", "input-2"] }

describe("TaskGraph denial progress", () => {
  it("counts only an identical checkpoint and accepted-input fence as the second denial", () => {
    const first = taskGraphDenialProgressFor(checkpoint, { ...context, consumedInputIds: ["input-1", "input-2"] })
    expect(first?.count).toBe(1)
    const second = taskGraphDenialProgressFor(checkpoint, { ...context, consumedInputIds: [] }, first)
    expect(second?.count).toBe(2)
    expect(taskGraphDenialProgressMatches(second, checkpoint, { ...context, consumedInputIds: [] }, "root-1")).toBe(true)
  })

  it("preserves a prior Step's accepted-input witness when the next same-cursor denial consumes none", () => {
    const firstContext = { ...context, consumedInputIds: ["input-3"] }
    const first = taskGraphDenialProgressFor(checkpoint, firstContext)
    const second = taskGraphDenialProgressFor(checkpoint, { ...context, consumedInputIds: [] }, first)
    expect(second).toMatchObject({ count: 2, inputThroughSequence: 12n, consumedInputIds: ["input-3"] })
    expect(taskGraphDenialProgressMatches(second, checkpoint, { ...context, consumedInputIds: [] }, "root-1")).toBe(true)
    expect(taskGraphDenialProgressMatches(second, checkpoint, firstContext, "root-1")).toBe(false)
  })

  it("rebaselines on any newly consumed Step input and does not carry witnesses across cursor epochs", () => {
    const first = taskGraphDenialProgressFor(checkpoint, { ...context, consumedInputIds: ["input-3"] })
    const repeated = taskGraphDenialProgressFor(checkpoint, { ...context, consumedInputIds: ["input-3"] }, first)
    expect(repeated).toMatchObject({ count: 1, consumedInputIds: ["input-3"] })

    const advanced = taskGraphDenialProgressFor(checkpoint, { ...context, inputThroughSequence: 13n, consumedInputIds: [] }, first)
    expect(advanced).toMatchObject({ count: 1, inputThroughSequence: 13n, consumedInputIds: [] })
    expect(taskGraphDenialProgressFor(checkpoint, { ...context, inputThroughSequence: 13n, consumedInputIds: [] }, advanced)?.count).toBe(2)
  })

  it.each([
    [{ ...checkpoint, verificationDigest: "b".repeat(64) }, context],
    [{ ...checkpoint, graphRevision: 5 }, { ...context, taskGraphRevision: 5 }],
    [checkpoint, { ...context, inputThroughSequence: 13n }],
    [checkpoint, { ...context, consumedInputIds: ["input-1", "input-3"] }],
  ])("restarts the streak after the graph, verifier, or accepted-input checkpoint changes", (next, changedContext) => {
    const first = taskGraphDenialProgressFor(checkpoint, context)
    expect(taskGraphDenialProgressFor(next, changedContext, first)?.count).toBe(1)
  })

  it("does not match an unknown current revision, another root, or a missing fresh read", () => {
    const twice = taskGraphDenialProgressFor(checkpoint, context, taskGraphDenialProgressFor(checkpoint, context))
    expect(taskGraphDenialProgressMatches(twice, checkpoint, { ...context, taskGraphRevision: undefined }, "root-1")).toBe(false)
    expect(taskGraphDenialProgressMatches(twice, { ...checkpoint, taskId: "root-2" }, context, "root-1")).toBe(false)
    expect(taskGraphDenialProgressMatches(twice, null, context, "root-1")).toBe(false)
  })

  it("keeps a first denial until a second denial can be checked against a fresh graph", async () => {
    const tracker = createTaskGraphDenialProgressTracker()
    const read = vi.fn(async () => checkpoint)
    const firstContext = { ...context, consumedInputIds: ["input-3"] }
    const noNewInputs = { ...context, consumedInputIds: [] }
    tracker.record(checkpoint, firstContext, true)

    await expect(tracker.shouldStop(noNewInputs, "root-1", read)).resolves.toBe(false)
    expect(read).not.toHaveBeenCalled()

    tracker.record(checkpoint, noNewInputs, true)
    await expect(tracker.shouldStop(noNewInputs, "root-1", read)).resolves.toBe(true)
    expect(read).toHaveBeenCalledOnce()
  })

  it("drops an exhausted streak when the fresh graph checkpoint differs", async () => {
    const tracker = createTaskGraphDenialProgressTracker()
    const changed = { ...checkpoint, verificationDigest: "b".repeat(64) }
    const read = vi.fn(async () => changed)
    const firstContext = { ...context, consumedInputIds: ["input-3"] }
    const noNewInputs = { ...context, consumedInputIds: [] }
    tracker.record(checkpoint, firstContext, true)
    tracker.record(checkpoint, noNewInputs, true)
    await expect(tracker.shouldStop(noNewInputs, "root-1", read)).resolves.toBe(false)

    tracker.record(checkpoint, context, true)
    await expect(tracker.shouldStop(noNewInputs, "root-1", read)).resolves.toBe(false)
    expect(read).toHaveBeenCalledOnce()
  })
})
