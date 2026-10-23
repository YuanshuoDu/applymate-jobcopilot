import { describe, expect, it } from "vitest"
import { taskGraphLifecycleKey } from "./task-graph-snapshot.js"
import { scheduledGateAttemptLineageMatches } from "./scheduled-gate-attempt-lineage.js"

const rootTaskId = "root-1", gateTaskId = "gate-1", maxAttempts = 3
const event = (type: string, attempt: number, expectedRevision: number, extra: Record<string, unknown> = {}) => ({
  type, idempotencyKey: taskGraphLifecycleKey(rootTaskId, "gate", attempt, type), expectedRevision, nodeKey: "gate", ...extra,
})
const started = (attempt: number, revision: number) => event("task.started", attempt, revision)
const retrying = (attempt: number, revision: number) => event("task.retrying", attempt, revision)
const waiting = (attempt: number, revision: number) => event("task.waiting_for_user", attempt, revision)
const resumed = (attempt: number, revision: number) => event("task.gate_choice_resumed", attempt, revision,
  { gateTaskId, requestAttemptCount: attempt, resumedAttemptCount: attempt + 1 })
const input = (overrides: Partial<Parameters<typeof scheduledGateAttemptLineageMatches>[0]> = {}) => ({
  rootTaskId, gateTaskId, maxAttempts, requestAttemptCount: 0, currentAttemptCount: 0, currentStatus: "queued", events: [], ...overrides,
})

describe("scheduled Gate attempt lineage", () => {
  it("accepts an unclaimed initial Gate and exact bounded retry hops", () => {
    expect(scheduledGateAttemptLineageMatches(input())).toBe(true)
    expect(scheduledGateAttemptLineageMatches(input({ currentAttemptCount: 2, currentStatus: "running", events: [
      started(1, 8), retrying(1, 9), started(2, 10),
    ] }))).toBe(true)
    expect(scheduledGateAttemptLineageMatches(input({ currentAttemptCount: 3, currentStatus: "waiting_for_user", events: [
      started(1, 8), retrying(1, 9), started(2, 10), retrying(2, 11), started(3, 12), waiting(3, 13),
    ] }))).toBe(true)
  })

  it("requires the exact answered question transition before the resumed attempt", () => {
    const events = [started(1, 8), waiting(1, 9), resumed(1, 10), started(2, 11), retrying(2, 12), started(3, 13)]
    expect(scheduledGateAttemptLineageMatches(input({ requestAttemptCount: 1, currentAttemptCount: 3,
      currentStatus: "running", events }))).toBe(true)
    expect(scheduledGateAttemptLineageMatches(input({ requestAttemptCount: 1, currentAttemptCount: 1,
      currentStatus: "queued", events: [started(1, 8), waiting(1, 9), resumed(1, 10)] }))).toBe(true)
    expect(scheduledGateAttemptLineageMatches(input({ requestAttemptCount: 1, currentAttemptCount: 2,
      currentStatus: "running", events: [started(1, 8), waiting(1, 9), started(2, 10)] }))).toBe(false)
  })

  it("allows one exact answer-resume after the final configured attempt", () => {
    expect(scheduledGateAttemptLineageMatches(input({ requestAttemptCount: 3, currentAttemptCount: 4,
      currentStatus: "running", events: [started(1, 8), retrying(1, 9), started(2, 10), retrying(2, 11),
        started(3, 12), waiting(3, 13), resumed(3, 14), started(4, 15)] }))).toBe(true)
    expect(scheduledGateAttemptLineageMatches(input({ requestAttemptCount: 3, currentAttemptCount: 5,
      currentStatus: "running", events: [started(1, 8), retrying(1, 9), started(2, 10), retrying(2, 11),
        started(3, 12), waiting(3, 13), resumed(3, 14), started(4, 15), retrying(4, 16), started(5, 17)] }))).toBe(false)
  })

  it("allows later questions only through exact acknowledgements and caps the full decision history at 51", () => {
    const fourQuestions: Record<string, unknown>[] = []
    let revision = 8
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      fourQuestions.push(started(attempt, revision++), waiting(attempt, revision++), resumed(attempt, revision++))
    }
    fourQuestions.push(started(5, revision))
    expect(scheduledGateAttemptLineageMatches(input({ requestAttemptCount: 4, currentAttemptCount: 5,
      currentStatus: "running", events: fourQuestions }))).toBe(true)

    const overLimit: Record<string, unknown>[] = []
    revision = 8
    for (let attempt = 1; attempt <= 52; attempt += 1) {
      overLimit.push(started(attempt, revision++), waiting(attempt, revision++), resumed(attempt, revision++))
    }
    overLimit.push(started(53, revision))
    expect(scheduledGateAttemptLineageMatches(input({ requestAttemptCount: 52, currentAttemptCount: 53,
      currentStatus: "running", events: overLimit }))).toBe(false)
  })

  it("rejects malformed, gapped, over-budget, and intervening choice transitions", () => {
    expect(scheduledGateAttemptLineageMatches(input({ currentAttemptCount: 2, currentStatus: "running", events: [
      started(1, 8), retrying(1, 10), started(2, 11),
    ] }))).toBe(false)
    expect(scheduledGateAttemptLineageMatches(input({ currentAttemptCount: 4, currentStatus: "running", events: [] }))).toBe(false)
    expect(scheduledGateAttemptLineageMatches(input({ requestAttemptCount: 1, currentAttemptCount: 3, currentStatus: "running", events: [
      started(1, 8), waiting(1, 9), resumed(1, 10), started(2, 11), waiting(2, 12), resumed(2, 13), started(3, 14),
    ] }))).toBe(false)
    expect(scheduledGateAttemptLineageMatches(input({ requestAttemptCount: 0, currentAttemptCount: 2, currentStatus: "running", events: [
      started(1, 8), waiting(1, 9), resumed(1, 10), started(2, 11),
    ] }))).toBe(false)
  })
})
