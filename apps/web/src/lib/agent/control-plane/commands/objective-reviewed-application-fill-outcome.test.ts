import { describe, expect, it, vi } from "vitest"
import {
  hashContent, objectiveApplicationApprovedIntentId, objectiveReviewedFillHandoffIdempotencyKey,
  OBJECTIVE_REVIEWED_FILL_SOURCE_SCHEMA, type ObjectiveApplicationApprovedIntent,
} from "@jobcopilot/shared"
import { readObjectiveReviewedApplicationFillOutcome, type ObjectiveReviewedFillOutcomeSelector } from "./objective-reviewed-application-fill-outcome"

const userId = "user-1", sessionId = "session-1", sourceTurnId = "source-1", reviewTurnId = "review-1"
const setId = "objective-review-" + "a".repeat(40), slotOrdinal = 4
const approvalId = `objective-review:${setId}:${slotOrdinal}`, applicationTaskId = "application-task-4", jobId = "job-4"
const fillTurnId = "fill-turn-4", workerTaskId = "worker-task-4", rootTaskId = "root-task-4"
const goal = "Fill the server-bound application form for user review. Never submit it."
const response = "The application site confirmed that the application was submitted."
const finalItemId = `turn:${fillTurnId}:item:final:objective-application-submit-finalize:${fillTurnId}`
const selector: ObjectiveReviewedFillOutcomeSelector = {
  userId, sessionId, sourceTurnId, reviewTurnId, setId, slotOrdinal, approvalId, applicationTaskId, jobId, fillTurnId,
}
const intent: ObjectiveApplicationApprovedIntent = {
  schemaVersion: "objective-application-review-approved-intent.v1", userId, sessionId, reviewTurnId,
  applicationTaskId, jobId, approvalId, setId, slotOrdinal, sourceTurnId, materialProofHash: "b".repeat(64),
}
const final = {
  schemaVersion: "agent-harness.v2.final", goal, completed: true, completedTasks: ["Turn goal"], notCompleted: [],
  blocker: null, next: [], evidenceRefs: ["objective_application_submit_site_confirmation"], response,
  usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 }, stepCount: 1, toolCallCount: 0,
  terminalReason: "goal_satisfied", summary: response,
}
const approvalEvent = () => ({ id: objectiveApplicationApprovedIntentId(setId, slotOrdinal), taskId: applicationTaskId,
  type: "objective_application_review_approved", actor: "user", body: "Objective application review approval recorded.", data: intent,
  task: { id: applicationTaskId, userId, sessionId, jobId, status: "submitted", checkpoint: "submission_verified",
    workerTaskId, fillTurnId, fillTurnSessionId: sessionId, fillTurnUserId: userId, completedAt: new Date() } })
const approvalForFill = `application-fill:${applicationTaskId}:${fillTurnId}`
const resultLinkEventId = "objective-application-submit-result:" + hashContent([applicationTaskId, fillTurnId, approvalForFill]).slice(7)
const finalization = { schemaVersion: "agent-harness.v2.objective-application-submit-finalization-queued.v1", userId, sessionId,
  jobId, applicationTaskId, fillTurnId, approvalId: approvalForFill, constraintHash: "c".repeat(64), workerTaskId,
  executionId: "execution-4", attemptId: "attempt-4", resultLinkEventId, applyResultId: 44 }
const finalizationId = "objective-application-submit-finalization:" +
  hashContent([applicationTaskId, fillTurnId, finalization.executionId, resultLinkEventId]).slice(7)
const turn = () => ({ id: fillTurnId, sessionId, userId, createdAt: new Date(), status: "completed", source: "user",
  executionMode: "canonical_task_graph", input: { clientMessageId: objectiveReviewedFillHandoffIdempotencyKey(approvalId),
    content: [{ type: "text", text: goal }], goal, reviewedApplicationMaterialSource: {
      schemaVersion: OBJECTIVE_REVIEWED_FILL_SOURCE_SCHEMA, approvalId, reviewTurnId, materialProofHash: intent.materialProofHash,
    } }, finalResponse: JSON.stringify(final), error: null, rootTaskId, completedAt: new Date(), leaseOwnerId: null, leaseExpiresAt: null })

function fixture() {
  let approvedRows: unknown[] = [approvalEvent()]
  let finalRows: unknown[] = [{ id: finalizationId, taskId: applicationTaskId, type: "objective_application_submit_finalization_queued",
    actor: "worker", body: "Objective submit finalization queued.", data: finalization }]
  let resultRows: unknown[] = [{ id: resultLinkEventId, taskId: applicationTaskId, type: "objective_application_submit_result_recorded",
    actor: "worker", body: "Objective browser-confirmed result recorded.", data: {
      schemaVersion: "agent-harness.v2.objective-application-submit-result.v1", applicationTaskId, userId, jobId,
      sessionId, fillTurnId, approvalId: approvalForFill, constraintHash: finalization.constraintHash, workerTaskId,
      executionId: finalization.executionId, attemptId: finalization.attemptId, applyResultId: finalization.applyResultId,
    } }]
  let turnRows: unknown[] = [turn()]
  const tx = {
    applicationTaskEvent: { findMany: vi.fn(async (args: { where: { type?: string } }) => {
      if (args.where.type === "objective_application_review_approved") return approvedRows
      if (args.where.type === "objective_application_submit_finalization_queued") return finalRows
      if (args.where.type === "objective_application_submit_result_recorded") return resultRows
      return []
    }) },
    agentTurn: { findMany: vi.fn(async () => turnRows) },
    job: { findFirst: vi.fn(async () => ({ id: jobId, userId, status: "applied", workflowState: "submitted", appliedAt: new Date() })) },
    subAgentTask: { findFirst: vi.fn(async () => ({ id: rootTaskId, status: "completed", leaseOwner: null,
      attemptCount: 1, result: { status: "completed", finalItemId, waitId: null } })) },
    agentItem: { findMany: vi.fn(async () => [{ id: finalItemId, taskId: rootTaskId, type: "agent_message", status: "completed",
      phase: "final_answer", revision: 1, content: { text: response, final } }]) },
    agentEvent: { findMany: vi.fn(async () => [{ id: `turn:${fillTurnId}:event:turn-completed`,
      idempotencyKey: `turn:${fillTurnId}:event:turn-completed`, actor: "orchestrator", type: "turn.completed",
      taskId: rootTaskId, itemId: finalItemId, payload: { turnId: fillTurnId, taskId: rootTaskId, finalItemId, usage: final.usage } }]) },
  }
  return { tx, setApproved: (rows: unknown[]) => { approvedRows = rows }, setFinal: (rows: unknown[]) => { finalRows = rows },
    setResult: (rows: unknown[]) => { resultRows = rows }, setTurns: (rows: unknown[]) => { turnRows = rows } }
}

describe("Objective reviewed Fill outcome", () => {
  it("returns only the owned Fill Turn and final Item links after the full canonical proof", async () => {
    const { tx } = fixture()
    const outcome = await readObjectiveReviewedApplicationFillOutcome(tx as never, selector)
    expect(outcome).toEqual({ status: "confirmed", fillTurnId, finalItemId })
    expect(Object.keys(outcome).sort()).toEqual(["fillTurnId", "finalItemId", "status"])
    expect(tx.applicationTaskEvent.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ taskId: applicationTaskId, actor: "user", type: "objective_application_review_approved",
        data: { path: ["approvalId"], equals: approvalId }, task: { is: { userId, sessionId } } }), take: 2,
    }))
    expect(tx.agentTurn.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: fillTurnId, sessionId, userId } }))
  })

  it("rejects an alternate approval event id that reuses the same task and Fill marker for another slot", async () => {
    const f = fixture(), nextApproval = `objective-review:${setId}:5`
    const alternate = { ...approvalEvent(), data: { ...intent, slotOrdinal: 5, approvalId: nextApproval } }
    f.setApproved([alternate])
    expect(await readObjectiveReviewedApplicationFillOutcome(f.tx as never, {
      ...selector, approvalId: nextApproval, slotOrdinal: 5,
    })).toEqual({ status: "invalid" })
  })

  it("rejects the wrong expected Job and foreign task ownership", async () => {
    const f = fixture()
    expect(await readObjectiveReviewedApplicationFillOutcome(f.tx as never, { ...selector, jobId: "other-job" }))
      .toEqual({ status: "invalid" })
    const foreign = { ...approvalEvent(), task: { ...approvalEvent().task, userId: "other-user" } }
    f.setApproved([foreign])
    expect(await readObjectiveReviewedApplicationFillOutcome(f.tx as never, selector)).toEqual({ status: "invalid" })
  })

  it("rejects ambiguous approval evidence and defers incomplete or mismatched terminal proof", async () => {
    const f = fixture()
    f.setApproved([approvalEvent(), approvalEvent()])
    expect(await readObjectiveReviewedApplicationFillOutcome(f.tx as never, selector)).toEqual({ status: "invalid" })
    f.setApproved([approvalEvent()]); f.setTurns([])
    expect(await readObjectiveReviewedApplicationFillOutcome(f.tx as never, selector)).toEqual({ status: "invalid" })
    f.setTurns([turn()]); f.setFinal([])
    expect(await readObjectiveReviewedApplicationFillOutcome(f.tx as never, selector)).toEqual({ status: "deferred" })
    f.setFinal([{ id: "wrong-finalization", ...finalization }])
    expect(await readObjectiveReviewedApplicationFillOutcome(f.tx as never, selector)).toEqual({ status: "deferred" })
  })
})
