import { beforeEach, describe, expect, it, vi } from "vitest"
import { createTurnScheduledGateChoiceContent, createTurnScheduledGateChoiceResumeAcknowledgement,
  turnScheduledGateChoiceWaitId, type TurnQuestionGateChoiceBinding } from "../turns/turn-question-gate-choice-contract.js"

const mock = vi.hoisted(() => ({ match: vi.fn() }))
vi.mock("./scheduled-gate-wait-match.js", async importOriginal => ({
  ...await importOriginal<typeof import("./scheduled-gate-wait-match.js")>(),
  matchScheduledGateWaitTarget: mock.match,
}))

import { selectScheduledGateResumeWaitAttempt } from "./scheduled-gate-resume-wait.js"

const owner = { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", rootAttemptCount: 2,
  executionId: "execution-1", executionAttemptCount: 3 }
const input = { ...owner, owner, stepId: "current-root-step", gateTaskId: "gate-task-1" }
function binding(gateAttempt: number, overrides: Partial<TurnQuestionGateChoiceBinding> = {}): TurnQuestionGateChoiceBinding {
  return { schemaVersion: "agent-harness.v2.scheduled-gate-choice-wait.v1", owner, continuationKey: `scheduled-taskgraph:sha256:${"a".repeat(64)}`,
    snapshotDigest: `sha256:${"b".repeat(64)}`, evidenceDigest: "c".repeat(64), checkpointDigest: "d".repeat(64),
    analyzeGraphRevision: 5, graphRevision: gateAttempt + 10, gateTaskId: input.gateTaskId, gateAttempt,
    kind: "weak_cover_letter", jobIds: [`job-${gateAttempt}`], allowedChoiceIds: ["continue", "review", "skip"], ...overrides }
}
function item(attempt: number, options: { ack?: boolean; answer?: boolean; overrides?: Record<string, unknown> } = {}) {
  const bound = binding(attempt), waitId = turnScheduledGateChoiceWaitId(bound)!
  const content = createTurnScheduledGateChoiceContent(waitId, bound, "How should I handle this weak cover letter?")!
  const ack = options.ack ? createTurnScheduledGateChoiceResumeAcknowledgement({ binding: bound, gateTaskId: bound.gateTaskId,
    requestAttemptCount: attempt, waitId, itemId: `agent-wait:question:${waitId}`, resumedAttemptCount: attempt + 1 }) : null
  return { id: `agent-wait:question:${waitId}`, stepId: `question-step-${attempt}`, taskId: input.rootTaskId, type: "question",
    status: options.answer ? "completed" : "started", content: { ...content,
      ...(options.answer ? { answer: "skip", answerAvailable: true, answeredAt: "2026-10-23T12:00:00.000Z" } : {}),
      ...(ack ? { scheduledGateChoiceResumeAcknowledgement: ack } : {}), ...options.overrides } }
}
function client(rows: unknown[]) {
  const query = vi.fn(async () => ({ rows }))
  return { query } as unknown as Parameters<typeof selectScheduledGateResumeWaitAttempt>[0] & { query: typeof query }
}

describe("scheduled Gate resume wait selection", () => {
  beforeEach(() => { mock.match.mockReset() })

  it("selects the initial marker when no answered handoff is persisted", async () => {
    const db = client([])
    await expect(selectScheduledGateResumeWaitAttempt(db, input)).resolves.toEqual({ status: "initial" })
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("LIMIT 52"), [input.sessionId, input.turnId, input.rootTaskId, input.gateTaskId])
  })

  it("does not move the marker to an answered question until its exact resume acknowledgement commits", async () => {
    const firstAnswer = client([item(1, { answer: true })])
    await expect(selectScheduledGateResumeWaitAttempt(firstAnswer, input)).resolves.toEqual({ status: "initial" })

    mock.match.mockResolvedValue("matched")
    const secondAnswer = client([item(1, { answer: true, ack: true }), item(2, { answer: true })])
    await expect(selectScheduledGateResumeWaitAttempt(secondAnswer, input)).resolves.toEqual({ status: "resumed", requestAttemptCount: 1 })
    expect(mock.match).toHaveBeenCalledWith(secondAnswer, { ...input, requestAttemptCount: 1 })
  })

  it("selects only an exact acknowledged question and lets lifecycle validation authorize its N", async () => {
    mock.match.mockResolvedValue("pending")
    const db = client([item(2, { answer: true, ack: true })])
    await expect(selectScheduledGateResumeWaitAttempt(db, input)).resolves.toEqual({ status: "resumed", requestAttemptCount: 2 })
    expect(mock.match).toHaveBeenCalledWith(db, { ...input, requestAttemptCount: 2 })
  })

  it("chooses the only acknowledgement that matches the current exact lifecycle chain, not the highest row", async () => {
    mock.match.mockImplementation(async (_client: unknown, scope: { requestAttemptCount: number }) =>
      scope.requestAttemptCount === 3 ? "matched" : null)
    const db = client([item(1, { answer: true, ack: true }), item(3, { answer: true, ack: true })])
    await expect(selectScheduledGateResumeWaitAttempt(db, input)).resolves.toEqual({ status: "resumed", requestAttemptCount: 3 })
  })

  it("fails closed when an acknowledgement has no valid current lifecycle match", async () => {
    mock.match.mockResolvedValue(null)
    const db = client([item(1, { answer: true, ack: true })])
    await expect(selectScheduledGateResumeWaitAttempt(db, input)).resolves.toEqual({ status: "invalid" })
  })

  it("rejects malformed, foreign, duplicate-overflow, or mismatched private history", async () => {
    const malformed = item(1, { answer: true, ack: true, overrides: { scheduledGateChoiceResumeAcknowledgement: { gateTaskId: "other" } } })
    const foreign = item(1, { answer: true, ack: true, overrides: { scheduledGateChoiceBinding: binding(1, { owner: { ...owner, userId: "other" } }) } })
    expect(await selectScheduledGateResumeWaitAttempt(client([malformed]), input)).toEqual({ status: "invalid" })
    expect(await selectScheduledGateResumeWaitAttempt(client([foreign]), input)).toEqual({ status: "invalid" })
    expect(await selectScheduledGateResumeWaitAttempt(client(Array.from({ length: 52 }, () => item(1))), input)).toEqual({ status: "invalid" })
  })
})
