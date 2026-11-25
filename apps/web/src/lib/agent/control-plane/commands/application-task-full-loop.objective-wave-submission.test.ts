import { describe, expect, it, vi } from "vitest"
import type { ObjectiveWaveSubmissionEvidence } from "./application-task-full-loop.objective-wave-evidence"
import {
  runObjectiveWaveSubmissions,
  type ObjectiveWaveDeferredProof,
  type ObjectiveWaveHandoffProof,
  type ObjectiveWaveScope,
  type ObjectiveWaveStaleSlotProof,
  type ObjectiveWaveSubmissionOps,
  type ObjectiveWaveSubmissionProof,
  type ObjectiveWaveSubmissionSlot,
} from "./application-task-full-loop.objective-wave-submission"

const runId = "0123456789abcdef0123456789abcdef"
const scope: ObjectiveWaveScope = {
  userId: `full-loop-user-${runId}-objective-wave`, sessionId: "session-wave", reviewTurnId: "review-turn-wave",
}
const sha = (suffix: string) => suffix.padStart(64, "0")
const slots: ObjectiveWaveSubmissionSlot[] = [
  { ordinal: 1, routeOrdinal: 5, reviewApprovalId: "review-1", applicationTaskId: "task-1", jobId: "job-1", corrected: false, expectedCoverLetterSha256: sha("1") },
  { ordinal: 2, routeOrdinal: 1, reviewApprovalId: "review-2", applicationTaskId: "task-2", jobId: "job-2", corrected: true, expectedCoverLetterSha256: sha("2") },
  { ordinal: 4, routeOrdinal: 3, reviewApprovalId: "review-4", applicationTaskId: "task-4", jobId: "job-4", corrected: false, expectedCoverLetterSha256: sha("4") },
  { ordinal: 5, routeOrdinal: 8, reviewApprovalId: "review-5", applicationTaskId: "task-5", jobId: "job-5", corrected: false, expectedCoverLetterSha256: sha("5") },
  { ordinal: 7, routeOrdinal: 2, reviewApprovalId: "review-7", applicationTaskId: "task-7", jobId: "job-7", corrected: false, expectedCoverLetterSha256: sha("7") },
]
const stale: ObjectiveWaveSubmissionSlot = {
  ordinal: 6, routeOrdinal: 6, reviewApprovalId: "review-6", applicationTaskId: "task-6", jobId: "job-6",
  corrected: true, expectedCoverLetterSha256: sha("6"),
}

function deferred(slot: ObjectiveWaveSubmissionSlot): ObjectiveWaveDeferredProof {
  return { ...scope, ...slot, outboxId: `outbox-${slot.ordinal}`, outboxTopic: "agent.objective-reviewed-fill.dispatch",
    outboxAggregateId: scope.sessionId, idempotencyKey: `agent-objective-reviewed-fill:${slot.reviewApprovalId}`,
    predecessorTurnId: scope.reviewTurnId, schemaVersion: "agent-harness.v2.objective-reviewed-fill-handoff.v1",
    acknowledgement: "deferred", published: false }
}

function handoff(slot: ObjectiveWaveSubmissionSlot): ObjectiveWaveHandoffProof {
  const fillTurnId = `fill-turn-${slot.ordinal}`
  return { ...scope, ...slot, fillTurnId, outboxId: `outbox-${slot.ordinal}`,
    outboxTopic: "agent.objective-reviewed-fill.dispatch", outboxAggregateId: scope.sessionId,
    idempotencyKey: `agent-objective-reviewed-fill:${slot.reviewApprovalId}`, predecessorTurnId: scope.reviewTurnId,
    schemaVersion: "agent-harness.v2.objective-reviewed-fill-handoff.v1", acknowledgement: "queued", published: true,
    publishAttemptCount: 1, routeGetsBefore: 0, routePostAttemptsBefore: 0,
    routePostValidBefore: 0, routePostMalformedBefore: 0 }
}

function submission(slot: ObjectiveWaveSubmissionSlot, restartCount: 0 | 1 = 0): ObjectiveWaveSubmissionProof {
  const fillTurnId = `fill-turn-${slot.ordinal}`, rootTaskId = `root-${slot.ordinal}`
  const workerTaskId = `worker-${slot.ordinal}`, approvalId = `application-fill:${slot.applicationTaskId}:${fillTurnId}`
  const executionId = `execution-${slot.ordinal}`, attemptId = `attempt-${slot.ordinal}`
  const finalItemId = `final-item-${slot.ordinal}`
  const durable: ObjectiveWaveSubmissionEvidence = { scope, slot, fillTurnId,
    task: { id: slot.applicationTaskId, status: "submitted", checkpoint: "submission_verified", workerTaskId },
    turn: { id: fillTurnId, status: "completed", rootTaskId, sourceApprovalId: slot.reviewApprovalId },
    root: { id: rootTaskId, status: "completed", leaseFree: true, finalItemId },
    job: { id: slot.jobId, status: "applied", workflowState: "submitted" },
    approval: { id: approvalId, status: "consumed", taskId: slot.applicationTaskId, turnId: fillTurnId, jobId: slot.jobId },
    result: { count: 1, eventId: `result-event-${slot.ordinal}`, executionId, attemptId,
      applyResultId: slot.ordinal, status: "submitted", jobId: slot.jobId },
    execution: { startedCount: 1, settledCount: 1, startedEventId: `started-${slot.ordinal}`, settledEventId: `settled-${slot.ordinal}` },
    attempt: { count: 1, id: attemptId, state: "submitted", receiptId: approvalId },
    finalization: { count: 1, eventId: `finalization-${slot.ordinal}`, itemStatus: "completed", finalItemId } }
  return { durable, site: { routeOrdinal: slot.routeOrdinal, getsAfter: 2, postAttemptsAfter: 1,
    postValidAfter: 1, postMalformedAfter: 0, coverLetterSha256: slot.expectedCoverLetterSha256 }, restartCount }
}

function staleProof(): ObjectiveWaveStaleSlotProof {
  return { ...scope, ...stale, approvalStatus: "expired", taskStatus: "waiting_for_user", checkpoint: "materials_ready",
    fillTurnId: null, workerTaskId: null, outboxCount: 0, browserStartCount: 0, routeGets: 0, routePostAttempts: 0 }
}

function ops(events: string[], overrides: Partial<ObjectiveWaveSubmissionOps> = {}): ObjectiveWaveSubmissionOps {
  return {
    assertDeferred: vi.fn(async (selected: readonly ObjectiveWaveSubmissionSlot[]) => {
      events.push("deferred")
      return selected.map(deferred)
    }),
    readStale: vi.fn(async () => { events.push("stale"); return staleProof() }),
    releaseAndQueue: vi.fn(async (slot: ObjectiveWaveSubmissionSlot) => { events.push(`release:${slot.ordinal}`); return handoff(slot) }),
    approveSubmitAndReadProof: vi.fn(async (slot: ObjectiveWaveSubmissionSlot) => { events.push(`submit:${slot.ordinal}`); return submission(slot) }),
    approveSubmitWithCrashRecoveryAndReadProof: vi.fn(async (slot: ObjectiveWaveSubmissionSlot) => {
      events.push(`crash:${slot.ordinal}`)
      return { proof: submission(slot, 1), restart: { projectionBlocked: true, committedResultBeforeCrash: true,
        capturedWorkerKilled: true, workerExitObserved: true, barrierUnblocked: true,
        successorStartedOnce: true, successorReady: true } as const }
    }),
    advanceRateWindow: vi.fn(async (pair: readonly [ObjectiveWaveSubmissionProof, ObjectiveWaveSubmissionProof]) => {
      events.push(`window:${pair[1].durable.slot.ordinal}`)
      return { expired: true, completedApplications: 2, expectedCounter: 4, userCounterPreserved: true } as const
    }),
    ...overrides,
  }
}

describe("Objective five-slot submit sequencer", () => {
  it("releases one exact handoff at a time, crashes once at the first corrected slot, and advances only after pairs", async () => {
    const events: string[] = [], driver = ops(events)
    const proofs = await runObjectiveWaveSubmissions({ scope, slots, stale, ops: driver })
    expect(proofs.map(proof => proof.durable.slot.ordinal)).toEqual([1, 2, 4, 5, 7])
    expect(events).toEqual(["deferred", "stale", "release:1", "submit:1", "release:2", "crash:2",
      "window:2", "release:4", "submit:4", "release:5", "submit:5", "window:5", "release:7", "submit:7", "stale"])
    expect(vi.mocked(driver.approveSubmitWithCrashRecoveryAndReadProof)).toHaveBeenCalledOnce()
    expect(vi.mocked(driver.releaseAndQueue)).toHaveBeenCalledTimes(5)
    expect(vi.mocked(driver.advanceRateWindow)).toHaveBeenCalledTimes(2)
    expect(vi.mocked(driver.releaseAndQueue).mock.calls.some(([slot]) => slot.ordinal === stale.ordinal)).toBe(false)
  })

  it("accepts the exact outbox when the real publisher receives a duplicate acknowledgement", async () => {
    const events: string[] = [], driver = ops(events, {
      releaseAndQueue: vi.fn(async (slot: ObjectiveWaveSubmissionSlot) => ({
        ...handoff(slot), acknowledgement: "duplicate" as const,
      })),
    })
    const proofs = await runObjectiveWaveSubmissions({ scope, slots, stale, ops: driver })
    expect(proofs).toHaveLength(5)
    expect(vi.mocked(driver.approveSubmitAndReadProof)).toHaveBeenCalledTimes(4)
    expect(vi.mocked(driver.approveSubmitWithCrashRecoveryAndReadProof)).toHaveBeenCalledOnce()
  })

  it("rejects terminal acknowledgement before approving a Fill", async () => {
    const events: string[] = [], driver = ops(events, {
      releaseAndQueue: vi.fn(async (slot: ObjectiveWaveSubmissionSlot) => ({
        ...handoff(slot), acknowledgement: "terminal",
      } as unknown as ObjectiveWaveHandoffProof)),
    })
    await expect(runObjectiveWaveSubmissions({ scope, slots, stale, ops: driver }))
      .rejects.toThrow("objective_wave_handoff_proof_invalid")
    expect(vi.mocked(driver.approveSubmitAndReadProof)).not.toHaveBeenCalled()
    expect(vi.mocked(driver.approveSubmitWithCrashRecoveryAndReadProof)).not.toHaveBeenCalled()
  })

  it.each([
    ["duplicate review approval", (list: ObjectiveWaveSubmissionSlot[]) => { list[1] = { ...list[1]!, reviewApprovalId: list[0]!.reviewApprovalId } }],
    ["duplicate physical route", (list: ObjectiveWaveSubmissionSlot[]) => { list[1] = { ...list[1]!, routeOrdinal: list[0]!.routeOrdinal } }],
    ["stale overlaps eligible slot", (list: ObjectiveWaveSubmissionSlot[]) => { list[4] = { ...list[4]!, jobId: stale.jobId } }],
  ])("rejects %s before releasing a slot", async (_name, mutate) => {
    const events: string[] = [], driver = ops(events), altered = [...slots]
    mutate(altered)
    await expect(runObjectiveWaveSubmissions({ scope, slots: altered, stale, ops: driver })).rejects.toThrow()
    expect(vi.mocked(driver.assertDeferred)).not.toHaveBeenCalled()
  })

  it("rejects a stale member in the deferred set before releasing anything", async () => {
    const events: string[] = [], driver = ops(events, { assertDeferred: vi.fn(async (selected: readonly ObjectiveWaveSubmissionSlot[]) => [...selected.map(deferred), deferred(stale)]) })
    await expect(runObjectiveWaveSubmissions({ scope, slots, stale, ops: driver })).rejects.toThrow("objective_wave_deferred_set_invalid")
    expect(vi.mocked(driver.releaseAndQueue)).not.toHaveBeenCalled()
  })

  it("stops before the next approval when route identity or exact letter evidence is mismatched", async () => {
    const events: string[] = [], driver = ops(events, { approveSubmitAndReadProof: vi.fn(async (slot: ObjectiveWaveSubmissionSlot) => ({
      ...submission(slot), site: { ...submission(slot).site, coverLetterSha256: sha("bad") },
    })) })
    await expect(runObjectiveWaveSubmissions({ scope, slots, stale, ops: driver })).rejects.toThrow("objective_wave_submission_proof_mismatch")
    expect(vi.mocked(driver.releaseAndQueue)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(driver.advanceRateWindow)).not.toHaveBeenCalled()
  })

  it("rejects a second crash and a reused durable per-slot identity", async () => {
    const secondCrashEvents: string[] = [], secondCrash = ops(secondCrashEvents, {
      approveSubmitAndReadProof: vi.fn(async (slot: ObjectiveWaveSubmissionSlot) => submission(slot, 1)),
    })
    await expect(runObjectiveWaveSubmissions({ scope, slots, stale, ops: secondCrash })).rejects.toThrow("objective_wave_submission_proof_mismatch")
    expect(vi.mocked(secondCrash.approveSubmitWithCrashRecoveryAndReadProof)).not.toHaveBeenCalled()

    const reusedEvents: string[] = [], reused = ops(reusedEvents, {
      approveSubmitAndReadProof: vi.fn(async (slot: ObjectiveWaveSubmissionSlot) => {
        const proof = submission(slot)
        return { ...proof, durable: { ...proof.durable,
          turn: { ...proof.durable.turn, rootTaskId: "root-shared" },
          root: { ...proof.durable.root, id: "root-shared" } } }
      }),
    })
    await expect(runObjectiveWaveSubmissions({ scope, slots, stale, ops: reused })).rejects.toThrow("objective_wave_submission_identity_reused")
    expect(vi.mocked(reused.releaseAndQueue)).toHaveBeenCalledTimes(3)
  })
})
