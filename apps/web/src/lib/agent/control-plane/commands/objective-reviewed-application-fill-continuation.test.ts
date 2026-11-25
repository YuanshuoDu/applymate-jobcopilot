import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  buildObjectiveReviewedFillHandoffOutboxData, hashContent, objectiveApplicationApprovedIntentId,
  objectiveReviewedFillHandoffIdempotencyKey, OBJECTIVE_REVIEWED_FILL_SOURCE_SCHEMA, type ObjectiveApplicationApprovedIntent,
} from "@jobcopilot/shared"
import { verifyObjectiveReviewedFillContinuation } from "./objective-reviewed-application-fill-continuation"

const userId = "user-1", sessionId = "session-1", reviewTurnId = "review-turn-1", sourceTurnId = "source-turn-1"
const setId = "objective-review-" + "a".repeat(40)
const approval = (slotOrdinal: number) => "objective-review:" + setId + ":" + slotOrdinal
const fillId = "fill-turn-prior", appTaskId = "app-task-prior", jobId = "job-prior", workerTaskId = "worker-prior"
const fillText = "Fill the server-bound application form for user review. Never submit it."
const response = "The application site confirmed that the application was submitted."
const finalItemId = "turn:" + fillId + ":item:final:objective-application-submit-finalize:" + fillId
type MockTask = { id: string; userId: string; sessionId: string; jobId: string; status: string; checkpoint: string | null;
  workerTaskId: string | null; fillTurnId: string | null; fillTurnSessionId: string | null; fillTurnUserId: string | null; completedAt: Date | null }
type MockApprovedEvent = { id: string; taskId: string; type: string; actor: string; body: string; createdAt: Date;
  data: ObjectiveApplicationApprovedIntent; task: MockTask }
const approvedEvent = (slotOrdinal: number, taskId: string, job: string): MockApprovedEvent => ({
  id: objectiveApplicationApprovedIntentId(setId, slotOrdinal), taskId, type: "objective_application_review_approved",
  actor: "user", body: "Objective application review approval recorded.", createdAt: new Date("2026-11-24T10:00:00Z"),
  data: { schemaVersion: "objective-application-review-approved-intent.v1", userId, sessionId, reviewTurnId,
    applicationTaskId: taskId, jobId: job, approvalId: approval(slotOrdinal), setId, slotOrdinal, sourceTurnId,
    materialProofHash: String(slotOrdinal).padStart(64, "b") } as ObjectiveApplicationApprovedIntent,
  task: { id: taskId, userId, sessionId, jobId: job, status: "submitted", checkpoint: "submission_verified",
    workerTaskId: "worker-" + taskId, fillTurnId: null as string | null, fillTurnSessionId: sessionId,
    fillTurnUserId: userId, completedAt: new Date() },
})
const final = {
  schemaVersion: "agent-harness.v2.final", goal: fillText, completed: true, completedTasks: ["Turn goal"],
  notCompleted: [], blocker: null, next: [], evidenceRefs: ["objective_application_submit_site_confirmation"],
  response, usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 }, stepCount: 1, toolCallCount: 0,
  terminalReason: "goal_satisfied", summary: response,
}
const priorIntent = approvedEvent(4, appTaskId, jobId).data
const finalization = {
  schemaVersion: "agent-harness.v2.objective-application-submit-finalization-queued.v1", userId, sessionId, jobId,
  applicationTaskId: appTaskId, fillTurnId: fillId, approvalId: "application-fill:" + appTaskId + ":" + fillId,
  constraintHash: "c".repeat(64), workerTaskId, executionId: "execution-1", attemptId: "attempt-1",
  resultLinkEventId: "objective-application-submit-result:" + hashContent([appTaskId, fillId, "application-fill:" + appTaskId + ":" + fillId]).slice(7), applyResultId: 41,
}
const finalizationId = "objective-application-submit-finalization:" +
  hashContent([appTaskId, fillId, finalization.executionId, finalization.resultLinkEventId]).slice(7)
const resultReceipt = { schemaVersion: "agent-harness.v2.objective-application-submit-result.v1",
  applicationTaskId: appTaskId, userId, jobId, sessionId, fillTurnId: fillId, approvalId: finalization.approvalId,
  constraintHash: finalization.constraintHash, workerTaskId, executionId: finalization.executionId,
  attemptId: finalization.attemptId, applyResultId: finalization.applyResultId }

function fixture() {
  const prior = approvedEvent(4, appTaskId, jobId)
  prior.task.fillTurnId = fillId
  prior.task.workerTaskId = workerTaskId
  const current = approvedEvent(1, "app-task-current", "job-current")
  current.task.status = "waiting_for_user"
  current.task.checkpoint = "materials_ready"
  current.task.workerTaskId = null
  current.task.fillTurnId = null
  current.task.fillTurnSessionId = null
  current.task.fillTurnUserId = null
  current.task.completedAt = null
  const unbound = approvedEvent(2, "app-task-stale", "job-stale")
  unbound.task.status = "waiting_for_user"
  unbound.task.checkpoint = "materials_ready"
  unbound.task.workerTaskId = null
  unbound.task.fillTurnId = null
  unbound.task.fillTurnSessionId = null
  unbound.task.fillTurnUserId = null
  unbound.task.completedAt = null
  const priorOutbox = buildObjectiveReviewedFillHandoffOutboxData({
    userId, sessionId, applicationTaskId: appTaskId, approvalId: approval(4), predecessorTurnId: reviewTurnId,
  })!
  const currentOutbox = buildObjectiveReviewedFillHandoffOutboxData({
    userId, sessionId, applicationTaskId: "app-task-current", approvalId: approval(1), predecessorTurnId: reviewTurnId,
  })!
  const finalTurnInput = { clientMessageId: objectiveReviewedFillHandoffIdempotencyKey(approval(4)), goal: fillText,
    content: [{ type: "text", text: fillText }], reviewedApplicationMaterialSource: {
      schemaVersion: OBJECTIVE_REVIEWED_FILL_SOURCE_SCHEMA, approvalId: approval(4), reviewTurnId,
      materialProofHash: priorIntent.materialProofHash,
    } }
  const tx = {
    $queryRaw: vi.fn(async () => [{ paused: false }]),
    applicationTaskEvent: { findMany: vi.fn(async (args: { where: { type?: string } }): Promise<unknown[]> => {
      if (args.where.type === "objective_application_review_approved") return [prior, current, unbound]
      if (args.where.type === "objective_application_submit_result_recorded") return [{
        id: finalization.resultLinkEventId, taskId: appTaskId, type: "objective_application_submit_result_recorded",
        actor: "worker", body: "Objective browser-confirmed result recorded.", data: resultReceipt,
      }]
      return [{ id: finalizationId, taskId: appTaskId, type: "objective_application_submit_finalization_queued",
        actor: "worker", body: "Objective submit finalization queued.", data: finalization }]
    }) },
    agentOutbox: { findMany: vi.fn(async () => [
      { id: "outbox-prior", ...priorOutbox, publishedAt: new Date(), lastError: null },
      { id: "outbox-current", ...currentOutbox, publishedAt: null, lastError: null },
    ]) },
    agentTurn: { findMany: vi.fn(async (): Promise<unknown[]> => [{
      id: fillId, createdAt: new Date("2026-11-24T10:01:00Z"), status: "completed", source: "user",
      executionMode: "canonical_task_graph", input: finalTurnInput, finalResponse: JSON.stringify(final), error: null,
      rootTaskId: "root-prior", completedAt: new Date(), leaseOwnerId: null, leaseExpiresAt: null,
    }]) },
    agentInput: { findMany: vi.fn(async () => [{ targetTurnId: fillId,
      clientMessageId: objectiveReviewedFillHandoffIdempotencyKey(approval(4)), acceptedSequence: 5n,
      delivery: "follow_up", cancelledAt: null }]) },
    job: { findFirst: vi.fn(async () => ({ id: jobId, userId, status: "applied", workflowState: "submitted", appliedAt: new Date() })) },
    subAgentTask: { findFirst: vi.fn(async () => ({ id: "root-prior", status: "completed", leaseOwner: null,
      attemptCount: 1, result: { status: "completed", finalItemId, waitId: null } })) },
    agentItem: { findMany: vi.fn(async (args: { select: { taskId?: boolean } }) => [{ id: finalItemId,
      ...(args.select.taskId ? { taskId: "root-prior" } : {}), type: "agent_message", status: "completed",
      phase: "final_answer", revision: 1, content: { text: response, final } }]) },
    agentEvent: { findMany: vi.fn(async (args: { select: Record<string, boolean> }): Promise<unknown[]> => {
      const key = "turn:" + fillId + ":event:turn-completed"
      const event = { id: key, actor: "orchestrator", type: "turn.completed", taskId: "root-prior", itemId: finalItemId,
        idempotencyKey: key, payload: { turnId: fillId, taskId: "root-prior", finalItemId, usage: final.usage } }
      return [Object.fromEntries(Object.keys(args.select).map(field => [field, event[field as keyof typeof event]]))]
    }) },
  }
  return { tx, prior, current, unbound, priorOutbox }
}

describe("Objective reviewed Fill continuation", () => {
  beforeEach(() => vi.clearAllMocks())

  it("accepts the latest bound same-set success and ignores unbound sibling receipts", async () => {
    const { tx } = fixture()
    await expect(verifyObjectiveReviewedFillContinuation(tx as never, {
      userId, sessionId, applicationTaskId: "app-task-current", approvalId: approval(1), setId,
      slotOrdinal: 1, sourceTurnId, reviewTurnId,
    })).resolves.toBe("ready")
    expect(tx.agentOutbox.findMany).toHaveBeenCalledOnce()
    expect(tx.agentItem.findMany).toHaveBeenCalledWith(expect.objectContaining({
      select: expect.objectContaining({ taskId: true }),
    }))
    expect(tx.agentEvent.findMany).toHaveBeenCalledWith(expect.objectContaining({
      select: expect.objectContaining({ actor: true, idempotencyKey: true, taskId: true, itemId: true }),
    }))
    expect(tx.agentInput.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { sessionId, userId, OR: [{ targetTurnId: fillId, clientMessageId: objectiveReviewedFillHandoffIdempotencyKey(approval(4)), delivery: "follow_up" }] },
    }))
  })

  it("reports a first Fill when no same-set Fill is bound", async () => {
    const { tx } = fixture()
    tx.applicationTaskEvent.findMany = vi.fn(async () => {
      const current = approvedEvent(1, "app-task-current", "job-current")
      current.task.status = "waiting_for_user"
      current.task.checkpoint = "materials_ready"
      return [current]
    })
    await expect(verifyObjectiveReviewedFillContinuation(tx as never, {
      userId, sessionId, applicationTaskId: "app-task-current", approvalId: approval(1), setId,
      slotOrdinal: 1, sourceTurnId, reviewTurnId,
    })).resolves.toBe("first")
    expect(tx.agentTurn.findMany).not.toHaveBeenCalled()
  })

  it("defers on a non-successful latest Fill rather than opening a sibling", async () => {
    const { tx } = fixture()
    tx.agentTurn.findMany = vi.fn(async (): Promise<unknown[]> => [{
      id: fillId, createdAt: new Date(), status: "waiting_for_approval", source: "user",
      executionMode: "canonical_task_graph", input: {}, finalResponse: null, error: null, rootTaskId: "root-prior",
      completedAt: null, leaseOwnerId: null, leaseExpiresAt: null,
    }])
    await expect(verifyObjectiveReviewedFillContinuation(tx as never, {
      userId, sessionId, applicationTaskId: "app-task-current", approvalId: approval(1), setId,
      slotOrdinal: 1, sourceTurnId, reviewTurnId,
    })).resolves.toBe("deferred")
    expect(tx.job.findFirst).not.toHaveBeenCalled()
  })

  it("keeps a pause active when a later resume names a different Turn", async () => {
    const { tx } = fixture()
    const controls = [
      { turnId: "active-turn", sequence: 3n, type: "session.pause_requested", actor: "user" },
      { turnId: "different-turn", sequence: 4n, type: "session.resume_requested", actor: "user" },
    ]
    tx.$queryRaw = vi.fn(async (query: unknown) => {
      const sql = (query as unknown as { sql: string }).sql
      expect(sql).toContain('resumed."turnId"=pause."turnId"')
      const paused = controls.some(pause => pause.type === "session.pause_requested" && pause.actor === "user"
        && !controls.some(resume => resume.turnId === pause.turnId && resume.actor === "user"
          && resume.type === "session.resume_requested" && resume.sequence > pause.sequence))
      return [{ paused }]
    })
    await expect(verifyObjectiveReviewedFillContinuation(tx as never, {
      userId, sessionId, applicationTaskId: "app-task-current", approvalId: approval(1), setId,
      slotOrdinal: 1, sourceTurnId, reviewTurnId,
    })).resolves.toBe("deferred")
    expect(tx.$queryRaw).toHaveBeenCalledOnce()
    expect(tx.applicationTaskEvent.findMany).not.toHaveBeenCalled()
  })
  it("rejects malformed same-set approval evidence", async () => {
    const { tx, prior } = fixture()
    prior.data = { ...prior.data, unexpected: true } as unknown as ObjectiveApplicationApprovedIntent
    await expect(verifyObjectiveReviewedFillContinuation(tx as never, {
      userId, sessionId, applicationTaskId: "app-task-current", approvalId: approval(1), setId,
      slotOrdinal: 1, sourceTurnId, reviewTurnId,
    })).resolves.toBe("invalid")
    expect(tx.agentTurn.findMany).not.toHaveBeenCalled()
  })

  it("rejects missing or mismatched finalization receipt", async () => {
    const { tx } = fixture()
    tx.applicationTaskEvent.findMany = vi.fn(async (args: { where: { type?: string } }) => {
      if (args.where.type === "objective_application_review_approved") {
        const prior = approvedEvent(4, appTaskId, jobId)
        prior.task.fillTurnId = fillId
        prior.task.workerTaskId = workerTaskId
        return [prior, approvedEvent(1, "app-task-current", "job-current")]
      }
      return args.where.type === "objective_application_submit_result_recorded" ? [{
        id: finalization.resultLinkEventId, taskId: appTaskId, type: "objective_application_submit_result_recorded",
        actor: "worker", body: "Objective browser-confirmed result recorded.", data: resultReceipt,
      }] : [{ id: "wrong-event-id", taskId: appTaskId, type: "objective_application_submit_finalization_queued",
        actor: "worker", body: "Objective submit finalization queued.", data: finalization }]
    })
    await expect(verifyObjectiveReviewedFillContinuation(tx as never, {
      userId, sessionId, applicationTaskId: "app-task-current", approvalId: approval(1), setId,
      slotOrdinal: 1, sourceTurnId, reviewTurnId,
    })).resolves.toBe("deferred")
  })
})
