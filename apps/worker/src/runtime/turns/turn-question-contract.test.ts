import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"

import { buildTurnQuestionScheduledChoiceBinding, buildTurnQuestionScheduledChoiceBindingFromAnalyzeEvidence, createTurnScheduledPrepareChoiceContent,
  parseTurnQuestionArguments, parseTurnQuestionIntentEnvelope, scheduledAnalyzeCheckpointEvidence,
  parseTurnQuestionScheduledChoiceBinding, parseTurnScheduledPrepareChoiceItem, scheduledPrepareChoiceWaitId,
  turnScheduledPrepareChoiceWaitId, TURN_QUESTION_INTENT_SCHEMA } from "./turn-question-contract.js"
import { scheduledTaskGraphStableContinuationKey } from "../subagents/scheduled-taskgraph-continuation-receipt.js"

const scheduledReceipt = {
  schemaVersion: "agent-harness.v2.scheduled-taskgraph-continuation-receipt.v1",
  owner: { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", rootAttemptCount: 2,
    turnLeaseOwnerId: "lease-1", turnLeaseVersion: 4, executionId: "execution-1", executionAttemptCount: 3 },
  continuationKey: `scheduled-taskgraph:sha256:${"a".repeat(64)}`, snapshotDigest: `sha256:${"b".repeat(64)}`,
  evidenceDigest: "c".repeat(64), checkpointDigest: "d".repeat(64), analyzeGraphRevision: 7, prepareScheduleRevision: 8,
}

function reverseObjectKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseObjectKeysDeep)
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(Object.entries(value).reverse().map(([key, nested]) => [key, reverseObjectKeysDeep(nested)]))
}

describe("native user question contract", () => {
  it("normalizes one question and maps choices into canonical options", () => {
    expect(parseTurnQuestionArguments({ question: "  Which location?  ", choices: [{ label: " Berlin ", value: " de-ber " }] })).toEqual({
      schemaVersion: TURN_QUESTION_INTENT_SCHEMA, kind: "user_question", stage: "user_input",
      question: "Which location?", options: [{ label: "Berlin", value: "de-ber" }],
    })
    expect(parseTurnQuestionArguments({ question: "Your preferred date?" })?.options).toEqual([])
  })

  it("enforces byte bounds, unique choices, and exact model keys", () => {
    expect(parseTurnQuestionArguments({ question: "x".repeat(2_001) })).toBeNull()
    expect(parseTurnQuestionArguments({ question: "é".repeat(1_001) })).toBeNull()
    expect(parseTurnQuestionArguments({ question: "x", extra: "owner" })).toBeNull()
    expect(parseTurnQuestionArguments({ question: "x", choices: [{ label: "a", value: "same" }, { label: "b", value: "same" }] })).toBeNull()
    expect(parseTurnQuestionArguments({ question: "x", choices: Array.from({ length: 7 }, (_, index) => ({ label: `L${index}`, value: `V${index}` })) })).toBeNull()
    expect(parseTurnQuestionArguments({ question: "x", choices: [{ label: "a".repeat(201), value: "yes" }] })).toBeNull()
  })

  it("accepts only the exact bounded server intent envelope for durable recovery", () => {
    const envelope = parseTurnQuestionArguments({ question: "Which region?", choices: [{ label: "North", value: "north" }] })!
    expect(parseTurnQuestionIntentEnvelope(envelope)).toEqual(envelope)
    expect(parseTurnQuestionIntentEnvelope({ ...envelope, toolCallId: "model-owned" })).toBeNull()
    expect(parseTurnQuestionIntentEnvelope({ ...envelope, stage: "approval" })).toBeNull()
    expect(parseTurnQuestionIntentEnvelope({ ...envelope, options: [{ label: "North", value: "north", secret: "x" }] })).toBeNull()
    expect(parseTurnQuestionIntentEnvelope({ ...envelope, question: " x ".repeat(1000) })).toBeNull()
  })

  it("binds a scheduled fixed choice to immutable continuation and original final-step identity", () => {
    const binding = buildTurnQuestionScheduledChoiceBinding({ receipt: scheduledReceipt, finalStepId: "step-final-9", finalStepOrdinal: 9 })
    expect(parseTurnQuestionScheduledChoiceBinding(binding)).toEqual(binding)
    expect(binding).toMatchObject({ owner: { userId: "user-1", rootAttemptCount: 2, executionId: "execution-1", executionAttemptCount: 3 },
      continuationKey: scheduledReceipt.continuationKey, finalStepId: "step-final-9", finalStepOrdinal: 9, finalStepAttempt: 1 })
    expect(binding?.owner).not.toHaveProperty("turnLeaseOwnerId")
    expect(turnScheduledPrepareChoiceWaitId(binding)).toMatch(/^agent-question:turn-1:canonical:[a-f0-9]{64}$/)
    expect(scheduledPrepareChoiceWaitId({ receipt: scheduledReceipt, finalStepId: "step-final-9", finalStepOrdinal: 9 }))
      .toBe(turnScheduledPrepareChoiceWaitId(binding))
    expect(scheduledPrepareChoiceWaitId({ receipt: { ...scheduledReceipt, unexpected: true }, finalStepId: "step-final-9", finalStepOrdinal: 9 })).toBeNull()
  })

  it("keeps the wait ID across lease rotation and changes it for another attempt or final candidate", () => {
    const first = buildTurnQuestionScheduledChoiceBinding({ receipt: scheduledReceipt, finalStepId: "step-final-9", finalStepOrdinal: 9 })!
    const rotatedReceipt = { ...scheduledReceipt, owner: { ...scheduledReceipt.owner, turnLeaseOwnerId: "lease-2", turnLeaseVersion: 5 } }
    const rotated = buildTurnQuestionScheduledChoiceBinding({ receipt: rotatedReceipt, finalStepId: "step-final-9", finalStepOrdinal: 9 })!
    const newAttempt = buildTurnQuestionScheduledChoiceBinding({ receipt: { ...scheduledReceipt,
      owner: { ...scheduledReceipt.owner, executionAttemptCount: 4 } }, finalStepId: "step-final-9", finalStepOrdinal: 9 })!
    const nextFinal = buildTurnQuestionScheduledChoiceBinding({ receipt: scheduledReceipt, finalStepId: "step-final-10", finalStepOrdinal: 10 })!
    expect(turnScheduledPrepareChoiceWaitId(rotated)).toBe(turnScheduledPrepareChoiceWaitId(first))
    expect(turnScheduledPrepareChoiceWaitId(newAttempt)).not.toBe(turnScheduledPrepareChoiceWaitId(first))
    expect(turnScheduledPrepareChoiceWaitId(nextFinal)).not.toBe(turnScheduledPrepareChoiceWaitId(first))
  })

  it("reconstructs a stable wait binding from persisted Analyze evidence without a Prepare receipt", () => {
    const state = { nextStage: "prepare", scoutedJobs: [{ id: "job-1", userId: "user-1" }],
      scoredJobs: [{ job: { id: "job-1", userId: "user-1" }, score: 80, matchedKeywords: ["TypeScript"], missingKeywords: [],
        recommendation: "Apply after tailoring.", analysisFenceAt: "2026-10-06T10:00:00.000Z" }], analysisFailed: 0,
      scheduledTaskGraphContinuation: { schemaVersion: "agent-harness.v2.scheduled-pipeline-continuation.v1",
        key: scheduledReceipt.continuationKey, owner: scheduledReceipt.owner, snapshotDigest: scheduledReceipt.snapshotDigest,
        graphRevision: scheduledReceipt.analyzeGraphRevision, evidenceDigest: scheduledReceipt.evidenceDigest } }
    const evidence = scheduledAnalyzeCheckpointEvidence(state)!
    const stableKey = scheduledTaskGraphStableContinuationKey({ owner: scheduledReceipt.owner,
      continuationKey: scheduledReceipt.continuationKey, snapshotDigest: scheduledReceipt.snapshotDigest,
      evidenceDigest: scheduledReceipt.evidenceDigest, checkpointDigest: evidence.checkpointDigest,
      analyzeGraphRevision: scheduledReceipt.analyzeGraphRevision, prepareScheduleRevision: scheduledReceipt.prepareScheduleRevision })
    expect(evidence.continuationKey).toBe(stableKey)
    expect(evidence.continuationKey).not.toBe(state.scheduledTaskGraphContinuation.key)
    const binding = buildTurnQuestionScheduledChoiceBindingFromAnalyzeEvidence({ ...evidence,
      finalStepId: "step-final-9", finalStepOrdinal: 9 })!
    const rotated = { ...state, scheduledTaskGraphContinuation: { ...state.scheduledTaskGraphContinuation,
      owner: { ...scheduledReceipt.owner, turnLeaseOwnerId: "lease-2", turnLeaseVersion: 5 } } }
    const rotatedEvidence = scheduledAnalyzeCheckpointEvidence(rotated)!
    const rotatedBinding = buildTurnQuestionScheduledChoiceBindingFromAnalyzeEvidence({ ...rotatedEvidence,
      finalStepId: "step-final-9", finalStepOrdinal: 9 })
    const projection = { owner: ["user-1", "session-1", "turn-1", "root-1", 2, "execution-1", 3],
      snapshotDigest: scheduledReceipt.snapshotDigest, evidenceDigest: scheduledReceipt.evidenceDigest, analyzeGraphRevision: 7,
      analysisFailed: 0, scoredJobs: [{ jobId: "job-1", score: 80, matchedKeywords: ["TypeScript"], missingKeywords: [],
        recommendation: "Apply after tailoring.", analysisFenceAt: "2026-10-06T10:00:00.000Z" }] }
    expect(evidence.checkpointDigest).toBe(createHash("sha256").update(JSON.stringify(projection), "utf8").digest("hex"))
    expect(rotatedEvidence.checkpointDigest).toBe(evidence.checkpointDigest)
    expect(turnScheduledPrepareChoiceWaitId(rotatedBinding)).toBe(turnScheduledPrepareChoiceWaitId(binding))
    expect(scheduledAnalyzeCheckpointEvidence({ ...state, analysisFailed: 1 })).toBeNull()
  })

  it("rejects malformed private receipts and extra or stale binding fields", () => {
    expect(buildTurnQuestionScheduledChoiceBinding({ receipt: { ...scheduledReceipt, unexpected: true }, finalStepId: "step-1", finalStepOrdinal: 1 })).toBeNull()
    const binding = buildTurnQuestionScheduledChoiceBinding({ receipt: scheduledReceipt, finalStepId: "step-1", finalStepOrdinal: 1 })!
    expect(parseTurnQuestionScheduledChoiceBinding({ ...binding, unexpected: true })).toBeNull()
    expect(parseTurnQuestionScheduledChoiceBinding({ ...binding, owner: { ...binding.owner, executionAttemptCount: -1 } })).toBeNull()
    expect(turnScheduledPrepareChoiceWaitId({ ...binding, finalStepAttempt: 2 })).toBeNull()
  })

  it("defines a non-user-input fixed-choice item and accepts only its exact private answer", () => {
    const binding = buildTurnQuestionScheduledChoiceBinding({ receipt: scheduledReceipt, finalStepId: "final-step", finalStepOrdinal: 11 })!
    const waitId = turnScheduledPrepareChoiceWaitId(binding)!
    const content = createTurnScheduledPrepareChoiceContent(waitId, binding)
    expect(content).toMatchObject({ waitKind: "question", questionId: waitId, toolCallId: null, stage: "scheduled_prepare",
      options: [{ value: "apply_ai_changes" }, { value: "keep_resume" }], answer: null, answerAvailable: false })
    expect(parseTurnScheduledPrepareChoiceItem(content, "started", binding)).toBeNull()
    expect(parseTurnScheduledPrepareChoiceItem({ ...content, answer: "apply_ai_changes", answerAvailable: true }, "completed", binding)).toBe("apply_ai_changes")
    expect(parseTurnScheduledPrepareChoiceItem({ ...content, answer: "keep_resume", answerAvailable: true }, "completed", binding)).toBe("keep_resume")
    expect(parseTurnScheduledPrepareChoiceItem({ ...content, toolCallId: "ask_user" }, "started", binding)).toBeUndefined()
    expect(parseTurnScheduledPrepareChoiceItem({ ...content, stage: "user_input" }, "started", binding)).toBeUndefined()
    expect(parseTurnScheduledPrepareChoiceItem({ ...content, answer: "maybe", answerAvailable: true }, "completed", binding)).toBeUndefined()
    expect(parseTurnScheduledPrepareChoiceItem({ ...content, questionId: "foreign" }, "started", binding)).toBeUndefined()
    expect(parseTurnScheduledPrepareChoiceItem({ ...content, extra: true }, "started", binding)).toBeUndefined()
  })

  it("compares nested JSON objects independent of key order while preserving array order", () => {
    const binding = buildTurnQuestionScheduledChoiceBinding({ receipt: scheduledReceipt, finalStepId: "final-step", finalStepOrdinal: 11 })!
    const waitId = turnScheduledPrepareChoiceWaitId(binding)!
    const content = createTurnScheduledPrepareChoiceContent(waitId, binding)
    const reorderedBinding = reverseObjectKeysDeep(content.scheduledPrepareChoiceBinding)

    expect(parseTurnScheduledPrepareChoiceItem({ ...content, scheduledPrepareChoiceBinding: reorderedBinding }, "started", binding)).toBeNull()
    expect(parseTurnScheduledPrepareChoiceItem({ ...content, options: [...content.options].reverse() }, "started", binding)).toBeUndefined()
  })
})
