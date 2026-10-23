import { describe, expect, it } from "vitest"
import {
  createTurnScheduledGateChoiceContent,
  createTurnScheduledGateChoiceResumeAcknowledgement,
  turnScheduledGateChoiceWaitId,
  type TurnQuestionGateChoiceAnswer,
} from "../turns/turn-question-gate-choice-contract.js"
import {
  parseScheduledGateChoiceHistory,
  type ScheduledGateChoiceProofScope,
} from "./pg-scheduled-task-graph-gate-choices.js"

const owner = {
  userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", rootAttemptCount: 1,
  executionId: "execution-1", executionAttemptCount: 4,
}
const lineage = {
  schemaVersion: "agent-harness.v2.scheduled-gate-choice-wait.v1" as const,
  owner,
  continuationKey: `scheduled-taskgraph:sha256:${"a".repeat(64)}`,
  snapshotDigest: `sha256:${"b".repeat(64)}`,
  evidenceDigest: "c".repeat(64), checkpointDigest: "d".repeat(64), analyzeGraphRevision: 3,
}
const choices = {
  borderline_match: ["add_to_pending", "skip", "lower_threshold"],
  weak_cover_letter: ["continue", "review", "skip"],
} as const

function scope(attemptCount: number, gateStartRevisions: ReadonlyMap<number, number>): ScheduledGateChoiceProofScope {
  return { ...owner, gateTaskId: "gate-task-1", attemptCount, ...lineage, gateStartRevisions }
}

function answeredRow(input: Readonly<{
  attempt: number
  graphRevision: number
  kind: "borderline_match" | "weak_cover_letter"
  jobIds: readonly string[]
  answer: TurnQuestionGateChoiceAnswer
}>): Record<string, unknown> {
  const binding = {
    ...lineage,
    graphRevision: input.graphRevision,
    gateTaskId: "gate-task-1",
    gateAttempt: input.attempt,
    kind: input.kind,
    jobIds: [...input.jobIds],
    allowedChoiceIds: [...choices[input.kind]],
  }
  const waitId = turnScheduledGateChoiceWaitId(binding)!
  const itemId = `agent-wait:question:${waitId}`
  const base = createTurnScheduledGateChoiceContent(waitId, binding, "Choose what to do with this job.")!
  const acknowledgement = createTurnScheduledGateChoiceResumeAcknowledgement({
    binding, gateTaskId: "gate-task-1", requestAttemptCount: input.attempt, waitId, itemId,
    resumedAttemptCount: input.attempt + 1,
  })!
  return {
    id: itemId, stepId: `step-${input.attempt}`, taskId: "root-1", type: "question", status: "completed",
    stepStatus: "waiting_for_user",
    content: { ...base, answer: input.answer, answerAvailable: true, answeredAt: "2026-10-23T21:00:00.000Z",
      scheduledGateChoiceResumeAcknowledgement: acknowledgement },
  }
}

describe("scheduled Gate private choice history", () => {
  it("restores ordered prior decisions and the exact answer authorizing the current attempt", () => {
    const revisions = new Map([[1, 5], [2, 8], [3, 11]])
    const rows = [
      answeredRow({ attempt: 1, graphRevision: 5, kind: "weak_cover_letter", jobIds: ["job-a"], answer: "skip" }),
      answeredRow({ attempt: 2, graphRevision: 8, kind: "weak_cover_letter", jobIds: ["job-b"], answer: "continue" }),
      answeredRow({ attempt: 3, graphRevision: 11, kind: "borderline_match", jobIds: ["job-a", "job-c"], answer: "add_to_pending" }),
    ]

    expect(parseScheduledGateChoiceHistory(rows, scope(4, revisions))).toEqual({
      validatedChoice: { kind: "borderline_match", jobIds: ["job-a", "job-c"], choiceId: "add_to_pending" },
      priorChoices: [
        { kind: "weak_cover_letter", jobIds: ["job-a"], choiceId: "skip" },
        { kind: "weak_cover_letter", jobIds: ["job-b"], choiceId: "continue" },
      ],
    })
  })

  it("rejects conflicting prior answers for one immutable job subject", () => {
    const rows = [
      answeredRow({ attempt: 1, graphRevision: 5, kind: "weak_cover_letter", jobIds: ["job-a"], answer: "skip" }),
      answeredRow({ attempt: 2, graphRevision: 8, kind: "weak_cover_letter", jobIds: ["job-a"], answer: "continue" }),
    ]
    expect(parseScheduledGateChoiceHistory(rows, scope(3, new Map([[1, 5], [2, 8]])))).toBeNull()
  })

  it("rejects a repeated decision subject even when both immutable answers are identical", () => {
    const rows = [
      answeredRow({ attempt: 1, graphRevision: 5, kind: "weak_cover_letter", jobIds: ["job-a"], answer: "skip" }),
      answeredRow({ attempt: 2, graphRevision: 8, kind: "weak_cover_letter", jobIds: ["job-a"], answer: "skip" }),
    ]
    expect(parseScheduledGateChoiceHistory(rows, scope(3, new Map([[1, 5], [2, 8]])))).toBeNull()
  })

  it("rejects a stale or forged Analyze/Gate revision, unanswered item, and unbounded history", () => {
    const row = answeredRow({ attempt: 1, graphRevision: 5, kind: "weak_cover_letter", jobIds: ["job-a"], answer: "review" })
    expect(parseScheduledGateChoiceHistory([row], { ...scope(2, new Map([[1, 6]])) })).toBeNull()
    expect(parseScheduledGateChoiceHistory([row], { ...scope(2, new Map([[1, 5]])), analyzeGraphRevision: 4 })).toBeNull()
    expect(parseScheduledGateChoiceHistory([{ ...row, content: { ...row.content as object, answer: null, answerAvailable: false } }],
      scope(2, new Map([[1, 5]])))).toBeNull()
    expect(parseScheduledGateChoiceHistory(Array(52).fill(row), scope(2, new Map([[1, 5]])))).toBeNull()
  })
})
