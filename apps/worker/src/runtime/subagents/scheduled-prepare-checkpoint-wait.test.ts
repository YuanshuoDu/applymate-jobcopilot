import { createHash } from "node:crypto"
import { describe, expect, it, vi } from "vitest"
import { resumedPrepareWaitOwner, scheduledPrepareDependencyWaitKey } from "./scheduled-prepare-checkpoint-wait.js"
import { scheduledPipelineRecoveryStepMarker, SCHEDULED_PIPELINE_RECOVERY_STEP_PROFILE_KEY } from "./scheduled-pipeline-recovery-step.js"

const identity = { userId: "user", sessionId: "session", turnId: "turn", rootTaskId: "root" }
const prior = { ...identity, rootAttemptCount: 1, turnLeaseVersion: 5, turnLeaseOwnerId: "previous-owner",
  executionId: "execution", executionAttemptCount: 1 }
const scope = { ...identity, parentTaskId: identity.rootTaskId, parentAttemptCount: 1,
  turnLeaseVersion: 6, turnLeaseOwner: "current-owner", parentLeaseOwner: "current-owner", stepId: "recovery" }
const input = { scope, waitId: "current-wait", prepareTaskId: "prepare" }
const handoffKey = "analyze-key"
const source = { owner: identity, sourceEventId: "candidate", sourceStepId: "source", sourceStepOrdinal: 1,
  rootAttemptCount: 1, inputThroughSequence: "5" }
const predecessor = scheduledPipelineRecoveryStepMarker({ owner: identity, source, recoveryStepId: "previous",
  recoveryCursor: 1, inputThroughSequence: "5" })
const marker = scheduledPipelineRecoveryStepMarker({ owner: identity, source, recoveryStepId: scope.stepId,
  recoveryCursor: 2, inputThroughSequence: "6", previous: predecessor })
const witness = { profile: { [SCHEDULED_PIPELINE_RECOVERY_STEP_PROFILE_KEY]: marker },
  previousProfile: { [SCHEDULED_PIPELINE_RECOVERY_STEP_PROFILE_KEY]: predecessor },
  ordinal: 3, inputCursor: "6", previousInputCursor: "5",
  previousWaitId: "previous-wait", previousWaitKey: scheduledPrepareDependencyWaitKey(handoffKey, "previous"), previousStepId: "previous",
  previousCompletion: { stepId: "previous", status: "waiting_for_dependency", taskId: "root", waitId: "previous-wait" } }
const sourceRow = { sourceEventId: source.sourceEventId, sourceStepId: source.sourceStepId, sourceStepTaskId: prior.rootTaskId,
  sourceStepOrdinal: source.sourceStepOrdinal, sourceStepAttempt: 1, sourceStepStatus: "waiting_for_tool", sourceFinishReason: "stop",
  sourceProfile: {}, candidatePayload: { schemaVersion: "agent-harness.v2.scheduled-pipeline-candidate.v3", sourceReceipt: null,
    sessionId: prior.sessionId, turnId: prior.turnId, rootTaskId: prior.rootTaskId, rootAttemptCount: prior.rootAttemptCount,
    finalStepId: source.sourceStepId, finalStepOrdinal: source.sourceStepOrdinal, candidateText: "Candidate.",
    stepAttempt: 1, finishReason: "stop", usage: null } }

describe("Prepare checkpoint wait lineage", () => {
  it("requires the live lease and matches the current and consumed waits to the same Prepare task", async () => {
    const query = vi.fn(async (sql: string) => ({ rows: sql.includes("AS \"sourceEventId\"") ? [sourceRow] : [witness] }))
    await expect(resumedPrepareWaitOwner({ query } as never, prior, input, handoffKey))
      .resolves.toEqual({ ...prior, turnLeaseOwnerId: scope.turnLeaseOwner, turnLeaseVersion: scope.turnLeaseVersion })
    const key = createHash("sha256").update(`${handoffKey}\0${scope.stepId}`).digest("hex")
    expect(query).toHaveBeenCalledWith(expect.stringContaining('older."consumedAt">=GREATEST(older."suspendedAt",older."resolvedAt")'),
      ["session", "user", "turn", "root", 6, "current-owner", 1, "recovery", "current-wait", "prepare", `scheduled-prepare-dependency:${key}`])
  })

  it("binds the first resumed Step to the original candidate's registered Prepare wait", async () => {
    const firstResume = scheduledPipelineRecoveryStepMarker({ owner: identity, source, recoveryStepId: scope.stepId,
      recoveryCursor: 1, inputThroughSequence: "6" })
    const priorWait = { ...witness, profile: { [SCHEDULED_PIPELINE_RECOVERY_STEP_PROFILE_KEY]: firstResume },
      previousProfile: {}, previousStepId: source.sourceStepId,
      previousWaitKey: scheduledPrepareDependencyWaitKey(handoffKey, source.sourceStepId),
      previousCompletion: { stepId: source.sourceStepId, status: "waiting_for_dependency", taskId: "root" } }
    const query = vi.fn(async (sql: string) => ({ rows: sql.includes("AS \"sourceEventId\"") ? [sourceRow] : [priorWait] }))
    await expect(resumedPrepareWaitOwner({ query } as never, prior, input, handoffKey))
      .resolves.toMatchObject({ turnLeaseOwnerId: "current-owner", turnLeaseVersion: 6 })
  })

  it.each([[], [witness, witness], [{ ...witness, previousWaitKey: "another-key" }],
    [{ ...witness, previousCompletion: { ...witness.previousCompletion, waitId: "wrong-wait" } }],
    [{ ...witness, profile: { [SCHEDULED_PIPELINE_RECOVERY_STEP_PROFILE_KEY]: { ...marker, sourceEventId: "another-candidate" } } }],
  ].map(rows => ({ rows })))("rejects missing, ambiguous or mismatched lineage %#", async ({ rows }) => {
    const query = vi.fn(async () => ({ rows }))
    await expect(resumedPrepareWaitOwner({ query } as never, prior, input, handoffKey)).resolves.toBeNull()
  })

  it("rejects a different attempt or a lease that did not advance", async () => {
    const query = vi.fn()
    for (const altered of [{ ...scope, parentAttemptCount: 2 }, { ...scope, turnLeaseVersion: prior.turnLeaseVersion }]) {
      await expect(resumedPrepareWaitOwner({ query } as never, prior, { ...input, scope: altered }, handoffKey)).resolves.toBeNull()
    }
    expect(query).not.toHaveBeenCalled()
  })
})
