import { describe, expect, it, vi } from "vitest"
import type { AtomicTurnNoProgressInput, TurnEngineStore } from "./turn-engine-types.js"
import type { TurnExecutionOptions } from "./turn-execution-types.js"
import { TASK_GRAPH_DENIAL_CHECKPOINT_SCHEMA, type TaskGraphDenialCheckpoint } from "./task-graph-terminal-assessment.js"
import { NoProgressError } from "../progress.js"
import { isTaskGraphTerminalDenial, matchedTaskGraphDenialCheckpoint, sameCheckpoint, terminalEntries, validDenial, withTaskGraphDenialCheckpoint } from "./turn-engine-no-progress-terminal-contract.js"

const owner = { kind: "turn" as const, userId: "user-1", sessionId: "session-1", turnId: "turn-1", taskId: "root-1",
  rootTaskId: "root-1", ownerId: "owner-1", leaseVersion: 2, leaseExpiresAt: new Date("2026-10-20T12:01:00Z") }
const checkpoint: TaskGraphDenialCheckpoint = { schemaVersion: TASK_GRAPH_DENIAL_CHECKPOINT_SCHEMA, taskId: owner.rootTaskId,
  graphRevision: 3, verificationDigest: "a".repeat(64) }
const denial: AtomicTurnNoProgressInput = { stepId: "step-1", finalItemId: "final-1", finalContent: { text: "stop" },
  stepCount: 1, toolCallCount: 0, usage: { inputTokens: 2, outputTokens: 1, estimatedCostUsd: 0 }, inputThroughSequence: 0n,
  consumedInputIds: [], reasonCode: "repeated_signature", signature: "task_graph_terminal_denial", stateFingerprint: "task_graph_terminal_denial" }

describe("no-progress terminal contracts", () => {
  it("captures only the checkpoint associated with a matching terminal denial", async () => {
    const read = vi.fn(async () => checkpoint)
    const shouldStop = vi.fn(async (_context: object, _taskId: string, readCurrent?: () => Promise<TaskGraphDenialCheckpoint | null>) => {
      await readCurrent?.()
      return true
    })
    await expect(matchedTaskGraphDenialCheckpoint(shouldStop, {}, owner.rootTaskId, read)).resolves.toEqual(checkpoint)
    await expect(matchedTaskGraphDenialCheckpoint(async () => false, {}, owner.rootTaskId, read)).resolves.toBeNull()
    expect(read).toHaveBeenCalledOnce()
  })

  it("wraps only no-progress persistence with the captured checkpoint", async () => {
    type RecordInput = Parameters<NonNullable<TurnExecutionOptions["store"]["recordFinalResponse"]>>[0]
    const saved: RecordInput[] = []
    const recordFinalResponse = vi.fn(async (input: RecordInput) => { saved.push(input) })
    const store = { recordFinalResponse } as unknown as TurnEngineStore
    const options = { store } as unknown as TurnExecutionOptions
    const read = async () => checkpoint
    const wrapped = withTaskGraphDenialCheckpoint(options, checkpoint, read)
    const record = wrapped.store.recordFinalResponse
    if (!record) throw new Error("Expected the wrapped terminal persistence method")
    await record.call(wrapped.store, { identity: owner, response: "", now: new Date(), noProgress: denial })
    await record.call(wrapped.store, { identity: owner, response: "ordinary", now: new Date() })
    expect(saved[0]?.noProgress?.taskGraphDenialCheckpoint).toEqual(checkpoint)
    expect(saved[0]?.noProgress?.readTaskGraphDenialCheckpoint).toBe(read)
    expect(saved[1]?.noProgress).toBeUndefined()
    expect(recordFinalResponse).toHaveBeenCalledTimes(2)
  })

  it("rejects malformed denial receipts and builds the canonical root failure event sequence", () => {
    expect(validDenial(denial)).toBe(true)
    expect(validDenial({ ...denial, consumedInputIds: ["same", "same"] })).toBe(false)
    expect(validDenial({ ...denial, stateFingerprint: "other" })).toBe(false)
    expect(isTaskGraphTerminalDenial(new NoProgressError({ signature: "task_graph_terminal_denial", stateFingerprint: "task_graph_terminal_denial" }))).toBe(true)
    expect(isTaskGraphTerminalDenial(new NoProgressError({ signature: "different", stateFingerprint: "different" }))).toBe(false)
    expect(sameCheckpoint(checkpoint, { ...checkpoint })).toBe(true)
    expect(sameCheckpoint(checkpoint, { ...checkpoint, graphRevision: 4 })).toBe(false)

    const entries = terminalEntries(owner, denial, { completed: false })
    expect(entries.map(entry => entry.type)).toEqual(["step.completed", "turn.no_progress", "item.started", "item.completed", "turn.failed"])
    expect(entries.at(-1)?.payload).toMatchObject({ turnId: owner.turnId, taskId: owner.rootTaskId, errorCode: "no_progress" })
  })
})
