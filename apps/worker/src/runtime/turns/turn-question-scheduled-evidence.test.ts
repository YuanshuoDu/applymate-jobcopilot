import { describe, expect, it } from "vitest"
import { scheduledPipelineContinuationKeyVersion } from "@jobcopilot/agent-protocol"
import { buildTurnQuestionScheduledChoiceBinding, parseTurnQuestionScheduledChoiceBinding,
  scheduledAnalyzeCheckpointEvidence } from "./turn-question-scheduled-evidence.js"

const owner = { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", rootAttemptCount: 2,
  turnLeaseOwnerId: "lease-1", turnLeaseVersion: 4, executionId: "execution-1", executionAttemptCount: 3 }
const v2Key = `scheduled-taskgraph:v2:sha256:${"a".repeat(64)}`

describe("scheduled Turn question evidence", () => {
  it("reconstructs and binds v2 Analyze evidence under the same exact continuation version", () => {
    const state = { nextStage: "prepare", scoutedJobs: [{ id: "job-1", userId: owner.userId }],
      scoredJobs: [{ job: { id: "job-1", userId: owner.userId }, score: 80, matchedKeywords: [], missingKeywords: [], recommendation: "Review" }],
      analysisFailed: 0, scheduledTaskGraphContinuation: { schemaVersion: "agent-harness.v2.scheduled-pipeline-continuation.v1",
        key: v2Key, owner, snapshotDigest: `sha256:${"b".repeat(64)}`, graphRevision: 7, evidenceDigest: "c".repeat(64) } }
    const evidence = scheduledAnalyzeCheckpointEvidence(state)
    expect(evidence).not.toBeNull()
    expect(scheduledPipelineContinuationKeyVersion(evidence?.continuationKey)).toBe("v2")
    const binding = buildTurnQuestionScheduledChoiceBinding({ receipt: { schemaVersion: "agent-harness.v2.scheduled-taskgraph-continuation-receipt.v1",
      owner, continuationKey: evidence!.continuationKey, snapshotDigest: evidence!.snapshotDigest, evidenceDigest: evidence!.evidenceDigest,
      checkpointDigest: evidence!.checkpointDigest, analyzeGraphRevision: evidence!.analyzeGraphRevision,
      prepareScheduleRevision: evidence!.analyzeGraphRevision + 1 }, finalStepId: "final-step", finalStepOrdinal: 9 })
    expect(binding).not.toBeNull()
    expect(scheduledPipelineContinuationKeyVersion(binding?.continuationKey)).toBe("v2")
    expect(parseTurnQuestionScheduledChoiceBinding(binding)).toEqual(binding)
  })

  it.each(["scheduled-taskgraph:v3:sha256:" + "a".repeat(64), `${v2Key}\n`, `${v2Key}\r`, `${v2Key}\u2028`, `${v2Key}\u2029`])(
    "rejects noncanonical v2 continuation keys (%s)", key => {
      expect(scheduledPipelineContinuationKeyVersion(key)).toBeNull()
      expect(parseTurnQuestionScheduledChoiceBinding({ schemaVersion: "agent-harness.v2.scheduled-prepare-choice-wait.v1",
        owner: { userId: owner.userId, sessionId: owner.sessionId, turnId: owner.turnId, rootTaskId: owner.rootTaskId,
          rootAttemptCount: owner.rootAttemptCount, executionId: owner.executionId, executionAttemptCount: owner.executionAttemptCount },
        continuationKey: key, snapshotDigest: `sha256:${"b".repeat(64)}`, evidenceDigest: "c".repeat(64), checkpointDigest: "d".repeat(64),
        analyzeGraphRevision: 7, prepareScheduleRevision: 8, finalStepId: "final-step", finalStepOrdinal: 9, finalStepAttempt: 1 })).toBeNull()
    })
})
