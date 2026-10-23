import { describe, expect, it } from "vitest"
import { createTurnScheduledGateChoiceContent, createTurnScheduledGateChoiceResumeAcknowledgement, parseTurnQuestionGateChoiceBinding,
  parseTurnScheduledGateChoiceItem, parseTurnScheduledGateChoiceItemState,
  turnScheduledGateChoiceWaitId, TURN_SCHEDULED_GATE_CHOICE_SCHEMA, type TurnQuestionGateChoiceBinding } from "./turn-question-gate-choice-contract.js"

const binding: TurnQuestionGateChoiceBinding = {
  schemaVersion: TURN_SCHEDULED_GATE_CHOICE_SCHEMA,
  owner: { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", rootAttemptCount: 2,
    executionId: "execution-1", executionAttemptCount: 3 },
  continuationKey: `scheduled-taskgraph:sha256:${"a".repeat(64)}`, snapshotDigest: `sha256:${"b".repeat(64)}`,
  evidenceDigest: "c".repeat(64), checkpointDigest: "d".repeat(64), analyzeGraphRevision: 8, graphRevision: 9, gateTaskId: "gate-1", gateAttempt: 2,
  kind: "borderline_match", jobIds: ["job-1", "job-2"], allowedChoiceIds: ["add_to_pending", "skip", "lower_threshold"],
}

describe("scheduled Gate fixed-choice contract", () => {
  it("strictly parses the exact binding and scopes the wait id to Gate attempt and question", () => {
    expect(parseTurnQuestionGateChoiceBinding(binding)).toEqual(binding)
    expect(turnScheduledGateChoiceWaitId(binding)).toMatch(/^agent-question:turn-1:gate:[a-f0-9]{64}$/)
    const reordered = { ...binding, jobIds: [...binding.jobIds].reverse() }
    expect(parseTurnQuestionGateChoiceBinding(reordered)?.jobIds).toEqual([...binding.jobIds].sort())
    expect(turnScheduledGateChoiceWaitId(reordered)).toBe(turnScheduledGateChoiceWaitId(binding))
    expect(turnScheduledGateChoiceWaitId({ ...binding, gateAttempt: 3 })).not.toBe(turnScheduledGateChoiceWaitId(binding))
    expect(turnScheduledGateChoiceWaitId({ ...binding, graphRevision: 10 })).not.toBe(turnScheduledGateChoiceWaitId(binding))
    expect(turnScheduledGateChoiceWaitId({ ...binding, analyzeGraphRevision: 10 })).not.toBe(turnScheduledGateChoiceWaitId(binding))
    expect(turnScheduledGateChoiceWaitId({ ...binding, jobIds: ["job-1"] })).not.toBe(turnScheduledGateChoiceWaitId(binding))
  })

  it("rejects malformed lineage, duplicate subjects, extra keys, and incomplete choice sets", () => {
    expect(parseTurnQuestionGateChoiceBinding({ ...binding, extra: "untrusted" })).toBeNull()
    expect(parseTurnQuestionGateChoiceBinding({ ...binding, owner: { ...binding.owner, rootAttemptCount: 0 } })).toBeNull()
    expect(parseTurnQuestionGateChoiceBinding({ ...binding, gateAttempt: 0 })).toBeNull()
    expect(parseTurnQuestionGateChoiceBinding({ ...binding, analyzeGraphRevision: 0 })).toBeNull()
    expect(parseTurnQuestionGateChoiceBinding({ ...binding, jobIds: ["job-1", "job-1"] })).toBeNull()
    expect(parseTurnQuestionGateChoiceBinding({ ...binding, allowedChoiceIds: ["add_to_pending", "skip"] })).toBeNull()
    expect(parseTurnQuestionGateChoiceBinding({ ...binding, allowedChoiceIds: ["add_to_pending", "skip", "review"] })).toBeNull()
  })

  it("accepts only the exact single-job weak-letter choice contract", () => {
    const weak = { ...binding, kind: "weak_cover_letter", jobIds: ["job-weak"],
      allowedChoiceIds: ["continue", "review", "skip"] }
    expect(parseTurnQuestionGateChoiceBinding(weak)).toMatchObject({ kind: "weak_cover_letter", jobIds: ["job-weak"] })
    expect(parseTurnQuestionGateChoiceBinding({ ...weak, jobIds: ["job-weak", "job-other"] })).toBeNull()
    expect(parseTurnQuestionGateChoiceBinding({ ...weak, allowedChoiceIds: ["continue", "skip", "lower_threshold"] })).toBeNull()
  })

  it("builds a fixed-choice wait and parses only a completed allowed answer", () => {
    const waitId = turnScheduledGateChoiceWaitId(binding)!
    const content = createTurnScheduledGateChoiceContent(waitId, binding, "Include these borderline jobs?")!
    expect(createTurnScheduledGateChoiceContent(waitId, binding, "x".repeat(2_001))).toBeNull()
    expect(content).toMatchObject({ stage: "scheduled_gate", questionId: waitId, toolCallId: null, question: "Include these borderline jobs?", answer: null, answerAvailable: false,
      scheduledGateChoiceBinding: binding })
    expect(parseTurnScheduledGateChoiceItem(content, "started", binding)).toBeNull()
    expect(parseTurnScheduledGateChoiceItem({ ...content, answer: "skip", answerAvailable: true }, "started", binding)).toBeUndefined()
    expect(parseTurnScheduledGateChoiceItem({ ...content, answer: "review", answerAvailable: true, answeredAt: "2026-10-23T12:00:00.000Z" }, "completed", binding)).toBeUndefined()
    expect(parseTurnScheduledGateChoiceItem({ ...content, answer: "lower_threshold", answerAvailable: true, answeredAt: "2026-10-23T12:00:00.000Z" }, "completed", binding)).toBe("lower_threshold")
    expect(parseTurnScheduledGateChoiceItem({ ...content, questionId: "other", answer: "skip", answerAvailable: true, answeredAt: "2026-10-23T12:00:00.000Z" }, "completed", binding)).toBeUndefined()
  })

  it("parses PostgreSQL JSONB rows with reordered nested object keys", () => {
    const waitId = turnScheduledGateChoiceWaitId(binding)!
    const content = createTurnScheduledGateChoiceContent(waitId, binding, "Include these borderline jobs?")!
    const persisted = {
      ...content,
      options: content.options.map(option => ({ value: option.value, label: option.label })),
      scheduledGateChoiceBinding: {
        allowedChoiceIds: [...binding.allowedChoiceIds], kind: binding.kind, jobIds: [...binding.jobIds], gateAttempt: binding.gateAttempt,
        gateTaskId: binding.gateTaskId, graphRevision: binding.graphRevision, analyzeGraphRevision: binding.analyzeGraphRevision,
        checkpointDigest: binding.checkpointDigest, evidenceDigest: binding.evidenceDigest, snapshotDigest: binding.snapshotDigest,
        continuationKey: binding.continuationKey, owner: { executionAttemptCount: binding.owner.executionAttemptCount,
          executionId: binding.owner.executionId, rootAttemptCount: binding.owner.rootAttemptCount, rootTaskId: binding.owner.rootTaskId,
          turnId: binding.owner.turnId, sessionId: binding.owner.sessionId, userId: binding.owner.userId }, schemaVersion: binding.schemaVersion,
      },
    }
    expect(parseTurnScheduledGateChoiceItemState(persisted, "started", binding)).toEqual({ answer: null, resumeAcknowledgement: null })
  })

  it("binds the one-shot requeue acknowledgement to this answered item and exactly the next attempt", () => {
    const waitId = turnScheduledGateChoiceWaitId(binding)!, itemId = `agent-wait:question:${waitId}`
    const ack = createTurnScheduledGateChoiceResumeAcknowledgement({ binding, gateTaskId: binding.gateTaskId,
      requestAttemptCount: binding.gateAttempt, waitId, itemId, resumedAttemptCount: binding.gateAttempt + 1 })!
    expect(ack).toEqual({ gateTaskId: "gate-1", requestAttemptCount: 2, waitId, itemId, resumedAttemptCount: 3 })
    const started = createTurnScheduledGateChoiceContent(waitId, binding, "Include these borderline jobs?")!
    const answered = { ...started,
      answer: "skip", answerAvailable: true, answeredAt: "2026-10-23T12:00:00.000Z", scheduledGateChoiceResumeAcknowledgement: ack }
    expect(parseTurnScheduledGateChoiceItemState(answered, "completed", binding)).toEqual({ answer: "skip", resumeAcknowledgement: ack })
    expect(createTurnScheduledGateChoiceResumeAcknowledgement({ binding, gateTaskId: "other", requestAttemptCount: 2,
      waitId, itemId, resumedAttemptCount: 3 })).toBeNull()
    expect(createTurnScheduledGateChoiceResumeAcknowledgement({ binding, gateTaskId: "gate-1", requestAttemptCount: 2,
      waitId, itemId, resumedAttemptCount: 4 })).toBeNull()
    expect(parseTurnScheduledGateChoiceItemState({ ...answered, scheduledGateChoiceResumeAcknowledgement: { ...ack, itemId: "other" } }, "completed", binding)).toBeUndefined()
    expect(parseTurnScheduledGateChoiceItemState({ ...answered, scheduledGateChoiceResumeAcknowledgement: { ...ack, resumedAttemptCount: 4 } }, "completed", binding)).toBeUndefined()
    expect(parseTurnScheduledGateChoiceItemState({ ...answered, scheduledGateChoiceResumeAcknowledgement: { ...ack, extra: true } }, "completed", binding)).toBeUndefined()
    expect(parseTurnScheduledGateChoiceItemState({ ...started, scheduledGateChoiceResumeAcknowledgement: ack }, "started", binding)).toBeUndefined()
  })
})
