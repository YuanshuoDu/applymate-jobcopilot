import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  OBJECTIVE_REVIEWED_FILL_SOURCE_SCHEMA,
  objectiveApplicationApprovedIntentId,
  objectiveReviewedFillHandoffIdempotencyKey,
} from "@jobcopilot/shared"

const calls: string[] = []
const mocks = vi.hoisted(() => ({
  acquireFence: vi.fn(), readAuthority: vi.fn(), verifyFreshness: vi.fn(), assertPreflight: vi.fn(),
  hasReservation: vi.fn(), lockTask: vi.fn(), lockSession: vi.fn(), acceptFacts: vi.fn(),
  createRoot: vi.fn(), findActive: vi.fn(), findExisting: vi.fn(), duplicateResult: vi.fn(), verifyContinuation: vi.fn(),
}))

vi.mock("../../source-material-fence", () => ({ acquireSourceMaterialFence: mocks.acquireFence }))
vi.mock("../../approval/objective-reviewed-fill-authority", () => ({
  readObjectiveReviewedFillAuthority: mocks.readAuthority,
  verifyObjectiveReviewedFillFreshness: mocks.verifyFreshness,
}))
vi.mock("./objective-reviewed-application-fill-continuation", () => ({
  verifyObjectiveReviewedFillContinuation: mocks.verifyContinuation,
}))
vi.mock("./application-fill-preflight", () => ({
  assertApplicationFillPreflight: mocks.assertPreflight,
  hasObjectiveApplicationFillReservation: mocks.hasReservation,
  lockApplicationFillTask: mocks.lockTask,
}))
vi.mock("./transaction", async importOriginal => {
  const actual = await importOriginal<typeof import("./transaction")>()
  return { ...actual, acceptInputFacts: mocks.acceptFacts, createRootTurn: mocks.createRoot,
    findActiveTurn: mocks.findActive, findExistingCommand: mocks.findExisting, lockOpenSession: mocks.lockSession }
})
vi.mock("../../approval/reviewed-fill-handoff", async importOriginal => {
  const actual = await importOriginal<typeof import("../../approval/reviewed-fill-handoff")>()
  return { ...actual, existingFillCommandResult: mocks.duplicateResult }
})

import { acknowledgeExistingObjectiveReviewedFill, startObjectiveReviewedApplicationFill } from "./objective-reviewed-application-fill-command"

const userId = "owner-1", sessionId = "session-1", applicationTaskId = "application-task-1"
const predecessorTurnId = "review-turn-1", jobId = "job-1", resumeId = "resume-1"
const setId = `objective-review-${"a".repeat(40)}`, approvalId = `objective-review:${setId}:1`
const clientMessageId = objectiveReviewedFillHandoffIdempotencyKey(approvalId)!
const materialProofHash = "b".repeat(64)
const intent = { schemaVersion: "agent-harness.v2.objective-reviewed-fill-handoff.v1" as const, userId, sessionId,
  applicationTaskId, approvalId, predecessorTurnId }
const authority = { jobId, resumeId, source: { schemaVersion: OBJECTIVE_REVIEWED_FILL_SOURCE_SCHEMA,
  approvalId, reviewTurnId: predecessorTurnId, materialProofHash }, input: { setId, intentHash: "c".repeat(64),
  sourceTurnId: "source-turn-1", slotOrdinal: 1, member: { userId, sessionId, jobId, resumeWitness: {} } } }
const task = { id: applicationTaskId, jobId, resumeId, status: "waiting_for_user", checkpoint: "materials_ready",
  fillTurnId: null, fillTurnSessionId: null, fillTurnUserId: null, workerTaskId: null, startedAt: null, completedAt: null }

function freshFixture(sessionStatus = "running") {
  calls.length = 0
  mocks.acquireFence.mockImplementation(async () => { calls.push("source-fence") })
  mocks.lockSession.mockImplementation(async () => { calls.push("session-lock") })
  mocks.readAuthority.mockImplementation(async () => { calls.push("set-and-approval"); return authority })
  mocks.lockTask.mockImplementation(async () => { calls.push("task-lock"); return { task } })
  mocks.hasReservation.mockResolvedValue(true)
  mocks.verifyContinuation.mockResolvedValue("first")
  mocks.findActive.mockResolvedValue(null)
  mocks.assertPreflight.mockImplementation(async () => { calls.push("material-preflight") })
  mocks.verifyFreshness.mockImplementation(async () => { calls.push("freshness") })
  mocks.createRoot.mockImplementation(async () => { calls.push("root-turn"); return { id: "fill-turn", source: "user", status: "queued", revision: 0 } })
  mocks.acceptFacts.mockImplementation(async () => { calls.push("accept-facts"); return { inputId: "input-1", turnId: "fill-turn", sequence: "1" } })
  mocks.findExisting.mockResolvedValue(null)
  const tx = {
    $queryRaw: vi.fn(async () => { calls.push("predecessor-lock"); return [{ id: predecessorTurnId, status: "completed" }] }),
    agentSession: {
      findFirst: vi.fn(async () => { calls.push("session-status"); return { id: sessionId, status: sessionStatus } }),
      updateMany: vi.fn(async () => { calls.push("session-resume-cas"); return { count: 1 } }),
    },
    agentTurn: {
      updateMany: vi.fn(async () => { calls.push("turn-binding"); return { count: 1 } }),
      findFirst: vi.fn(async (): Promise<unknown> => null),
    },
    applicationTask: {
      findFirst: vi.fn(async (): Promise<unknown> => ({ ...task })),
      updateMany: vi.fn(async () => { calls.push("task-cas"); return { count: 1 } }),
    },
    applicationTaskEvent: { findMany: vi.fn(async (): Promise<unknown[]> => []) },
  }
  const db = { $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)) }
  return { tx, db }
}

beforeEach(() => {
  vi.clearAllMocks()
  calls.length = 0
})

describe("Objective reviewed fill command", () => {
  it("starts only the exact fresh approved member as a canonical non-submitting Fill Turn", async () => {
    const { tx, db } = freshFixture()
    mocks.hasReservation.mockImplementation(async () => { calls.push("reservation"); return true })
    const now = new Date("2026-11-24T12:00:00.000Z")
    await expect(startObjectiveReviewedApplicationFill(db as never, intent, now)).resolves.toMatchObject({
      inputId: "input-1", turnId: "fill-turn", disposition: "started",
    })
    expect(calls.indexOf("source-fence")).toBeLessThan(calls.indexOf("session-lock"))
    expect(calls.indexOf("session-lock")).toBeLessThan(calls.indexOf("predecessor-lock"))
    expect(calls.indexOf("predecessor-lock")).toBeLessThan(calls.indexOf("set-and-approval"))
    expect(calls.indexOf("session-status")).toBeLessThan(calls.indexOf("set-and-approval"))
    expect(calls.indexOf("set-and-approval")).toBeLessThan(calls.indexOf("task-lock"))
    expect(calls.indexOf("task-lock")).toBeLessThan(calls.indexOf("material-preflight"))
    expect(calls.indexOf("material-preflight")).toBeLessThan(calls.indexOf("freshness"))
    expect(tx.agentTurn.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "fill-turn", userId, sessionId, source: "user", status: "queued", executionMode: null },
      data: { executionMode: "canonical_task_graph", input: {
        clientMessageId, content: [{ type: "text", text: "Fill the server-bound application form for user review. Never submit it." }],
        goal: "Fill the server-bound application form for user review. Never submit it.",
        reviewedApplicationMaterialSource: authority.source,
      } },
    }))
    expect(mocks.acceptFacts).toHaveBeenCalledWith(tx, { userId, sessionId, clientMessageId, source: "user" },
      expect.any(Array), expect.objectContaining({ id: "fill-turn" }), "follow_up", "started", true)
    expect(tx.applicationTask.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: applicationTaskId, status: "waiting_for_user", checkpoint: "materials_ready", fillTurnId: null }),
      data: expect.objectContaining({ fillTurnId: "fill-turn", status: "filling", checkpoint: "taskgraph_fill_queued", startedAt: now }),
    }))
    expect(tx.agentTurn.updateMany).toHaveBeenCalledOnce()
    expect(tx.applicationTask.updateMany).toHaveBeenCalledOnce()
    expect(mocks.verifyContinuation).toHaveBeenCalledWith(tx, {
      userId, sessionId, applicationTaskId, approvalId, setId, slotOrdinal: 1,
      sourceTurnId: "source-turn-1", reviewTurnId: predecessorTurnId,
    })
    expect(tx.agentSession.updateMany).not.toHaveBeenCalled()
  })

  it("returns the persisted exact command replay before rechecking current expiry or material", async () => {
    const { tx, db } = freshFixture("paused")
    const approved = { schemaVersion: "objective-application-review-approved-intent.v1", userId, sessionId,
      reviewTurnId: predecessorTurnId, applicationTaskId, jobId, approvalId, setId, slotOrdinal: 1,
      sourceTurnId: "source-turn-1", materialProofHash }
    const source = { schemaVersion: OBJECTIVE_REVIEWED_FILL_SOURCE_SCHEMA, approvalId,
      reviewTurnId: predecessorTurnId, materialProofHash }
    const priorTask = { ...task, fillTurnId: "fill-turn", fillTurnSessionId: sessionId, fillTurnUserId: userId }
    mocks.findExisting.mockResolvedValue({ id: "accepted-input", targetTurnId: "fill-turn", acceptedSequence: 3n })
    mocks.lockTask.mockResolvedValue({ task: priorTask })
    mocks.duplicateResult.mockResolvedValue({ inputId: "accepted-input", turnId: "fill-turn", disposition: "duplicate",
      originalDisposition: "started", sequence: "3" })
    const fillText = "Fill the server-bound application form for user review. Never submit it."
    tx.agentTurn.findFirst = vi.fn(async () => ({ executionMode: "canonical_task_graph", input: {
      clientMessageId, content: [{ type: "text", text: fillText }], goal: fillText,
      reviewedApplicationMaterialSource: source,
    } }))
    tx.applicationTask.findFirst = vi.fn(async () => priorTask)
    tx.applicationTaskEvent.findMany = vi.fn(async () => [{ id: objectiveApplicationApprovedIntentId(setId, 1),
      taskId: applicationTaskId, type: "objective_application_review_approved", actor: "user", data: approved }])
    await expect(startObjectiveReviewedApplicationFill(db as never, intent)).resolves.toMatchObject({
      turnId: "fill-turn", disposition: "duplicate",
    })
    await expect(acknowledgeExistingObjectiveReviewedFill(db as never, intent)).resolves.toMatchObject({
      kind: "duplicate", result: { turnId: "fill-turn", disposition: "duplicate" },
    })
    expect(tx.agentSession.findFirst).not.toHaveBeenCalled()
    expect(mocks.readAuthority).not.toHaveBeenCalled()
    expect(mocks.verifyFreshness).not.toHaveBeenCalled()
    expect(tx.applicationTask.updateMany).not.toHaveBeenCalled()
    expect(tx.agentTurn.updateMany).not.toHaveBeenCalled()
  })

  it("reopens a waiting Session only after the continuation proof and in the same command transaction", async () => {
    const { tx, db } = freshFixture("waiting_for_user")
    mocks.verifyContinuation.mockResolvedValue("ready")
    const now = new Date("2026-11-24T12:00:00.000Z")
    await expect(startObjectiveReviewedApplicationFill(db as never, intent, now)).resolves.toMatchObject({
      inputId: "input-1", turnId: "fill-turn", disposition: "started",
    })
    expect(mocks.verifyContinuation).toHaveBeenCalledWith(tx, {
      userId, sessionId, applicationTaskId, approvalId, setId, slotOrdinal: 1,
      sourceTurnId: "source-turn-1", reviewTurnId: predecessorTurnId,
    })
    expect(tx.agentSession.updateMany).toHaveBeenCalledWith({
      where: { id: sessionId, userId, status: "waiting_for_user" },
      data: { status: "running", completedAt: null },
    })
    expect(calls.indexOf("session-resume-cas")).toBeLessThan(calls.indexOf("root-turn"))
  })

  it("defers when the prior same-set Fill has not settled", async () => {
    const { tx, db } = freshFixture("waiting_for_user")
    mocks.verifyContinuation.mockResolvedValue("deferred")
    await expect(startObjectiveReviewedApplicationFill(db as never, intent)).rejects.toMatchObject({
      code: "reviewed_fill_handoff_deferred",
    })
    expect(tx.agentSession.updateMany).not.toHaveBeenCalled()
    expect(mocks.createRoot).not.toHaveBeenCalled()
    expect(tx.applicationTask.updateMany).not.toHaveBeenCalled()
  })

  it("does not start a Turn if the waiting Session CAS loses a race", async () => {
    const { tx, db } = freshFixture("waiting_for_user")
    tx.agentSession.updateMany = vi.fn(async () => ({ count: 0 }))
    await expect(startObjectiveReviewedApplicationFill(db as never, intent)).rejects.toMatchObject({
      code: "reviewed_fill_handoff_deferred",
    })
    expect(mocks.verifyContinuation).toHaveBeenCalledOnce()
    expect(mocks.createRoot).not.toHaveBeenCalled()
    expect(tx.applicationTask.updateMany).not.toHaveBeenCalled()
  })
  it("defers a new Fill for a paused Session without writing a Turn or claiming the task", async () => {
    const { tx, db } = freshFixture("paused")
    await expect(startObjectiveReviewedApplicationFill(db as never, intent))
      .rejects.toMatchObject({ code: "reviewed_fill_handoff_deferred" })
    expect(tx.agentSession.findFirst).toHaveBeenCalledWith({
      where: { id: sessionId, userId }, select: { id: true, status: true },
    })
    expect(mocks.verifyContinuation).not.toHaveBeenCalled()
    expect(mocks.readAuthority).not.toHaveBeenCalled()
    expect(mocks.lockTask).not.toHaveBeenCalled()
    expect(mocks.createRoot).not.toHaveBeenCalled()
    expect(mocks.acceptFacts).not.toHaveBeenCalled()
    expect(tx.agentTurn.updateMany).not.toHaveBeenCalled()
    expect(tx.applicationTask.updateMany).not.toHaveBeenCalled()
  })
})
