import { beforeEach, describe, expect, it, vi } from "vitest"
import { queueLegacyApplicationFill } from "./legacy-application-fill"

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  lock: vi.fn(),
  reservation: vi.fn(),
  claim: vi.fn(),
  rollback: vi.fn(),
  update: vi.fn(),
  event: vi.fn(),
  enqueue: vi.fn(),
}))

const tx = {
  $queryRaw: mocks.lock,
  agentApproval: { findFirst: mocks.reservation },
  applicationTask: { updateMany: mocks.claim },
}

vi.mock("@/lib/db", () => ({
  db: {
    $transaction: mocks.transaction,
    applicationTask: { updateMany: mocks.rollback, update: mocks.update },
    applicationTaskEvent: { create: mocks.event },
  },
}))
vi.mock("@/lib/apply-queue-client", async importOriginal => ({
  ...(await importOriginal<typeof import("@/lib/apply-queue-client")>()),
  enqueueApplyTask: mocks.enqueue,
}))

describe("legacy application fill reservation fence", () => {
  const input = { userId: "user-1", jobId: "job-1", applicationTaskId: "task-1", applyUrl: "https://jobs.lever.co/acme/1" }
  const objectiveApprovalId = `objective-review:objective-review-${"a".repeat(40)}:1`

  beforeEach(() => {
    Object.values(mocks).forEach(mock => mock.mockReset())
    mocks.transaction.mockImplementation(async (callback: (client: typeof tx) => unknown) => callback(tx))
    mocks.lock.mockResolvedValue([{ id: input.applicationTaskId, sessionId: "session-1" }])
    mocks.reservation.mockResolvedValue(null)
    mocks.claim.mockResolvedValue({ count: 1 })
    mocks.enqueue.mockResolvedValue("worker-1")
    mocks.update.mockResolvedValue({})
    mocks.event.mockResolvedValue({})
    mocks.rollback.mockResolvedValue({ count: 1 })
  })

  it("locks and reserves-checks before claiming an ordinary fill, then preserves queue writes", async () => {
    const calls: string[] = []
    mocks.lock.mockImplementation(async () => { calls.push("lock"); return [{ id: input.applicationTaskId, sessionId: "session-1" }] })
    mocks.reservation.mockImplementation(async () => { calls.push("reservation"); return null })
    mocks.claim.mockImplementation(async () => { calls.push("claim"); return { count: 1 } })

    await expect(queueLegacyApplicationFill(input)).resolves.toEqual({ taskId: "worker-1" })

    expect(calls).toEqual(["lock", "reservation", "claim"])
    expect(mocks.reservation).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ taskId: input.applicationTaskId, userId: input.userId,
        sessionId: "session-1", type: "review_application", OR: expect.arrayContaining([
          expect.objectContaining({ id: expect.objectContaining({ startsWith: "objective-review:objective-review-" }) }),
          expect.objectContaining({ payload: expect.objectContaining({ path: ["schema"], equals: "objective-application-approval-set-member.v1" }) }),
        ]) }),
    }))
    expect(mocks.claim).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({
      id: input.applicationTaskId, userId: input.userId, jobId: input.jobId,
      status: "waiting_for_user", checkpoint: "materials_ready",
    }) }))
    expect(mocks.enqueue).toHaveBeenCalledWith(expect.objectContaining({ operation: "fill", applyUrl: input.applyUrl }))
    expect(mocks.update).toHaveBeenCalledWith({ where: { id: input.applicationTaskId }, data: { workerTaskId: "worker-1" } })
    expect(mocks.event).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ type: "form_fill_queued" }) }))
  })

  it("denies an Objective approval reservation before any legacy claim or queue write", async () => {
    mocks.reservation.mockResolvedValue({ id: objectiveApprovalId })

    await expect(queueLegacyApplicationFill(input)).rejects.toThrow("no longer ready")

    expect(mocks.lock).toHaveBeenCalledTimes(1)
    expect(mocks.reservation).toHaveBeenCalledTimes(1)
    expect(mocks.claim).not.toHaveBeenCalled()
    expect(mocks.enqueue).not.toHaveBeenCalled()
    expect(mocks.event).not.toHaveBeenCalled()
  })

  it("rolls back the claim if queueing fails", async () => {
    mocks.enqueue.mockRejectedValue(new Error("queue unavailable"))

    await expect(queueLegacyApplicationFill(input)).rejects.toThrow("queue unavailable")

    expect(mocks.claim).toHaveBeenCalledTimes(1)
    expect(mocks.rollback).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({
      id: input.applicationTaskId, status: "filling", checkpoint: "form_fill_queued",
    }), data: { status: "waiting_for_user", checkpoint: "materials_ready" } }))
  })
})
