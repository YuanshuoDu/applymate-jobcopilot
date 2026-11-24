import { beforeEach, describe, expect, it, vi } from "vitest"
import { buildObjectiveReviewedFillHandoffOutboxData } from "@jobcopilot/shared"

const calls = vi.hoisted(() => ({
  owners: [] as string[], duplicate: vi.fn(), start: vi.fn(), launch: vi.fn(),
}))

vi.mock("@/lib/db/tenant-store", () => ({
  runWithTenantContext: (userId: string, work: () => Promise<unknown>) => {
    calls.owners.push(userId)
    return work()
  },
}))
vi.mock("../control-plane/commands/objective-reviewed-application-fill-command", () => ({
  acknowledgeExistingObjectiveReviewedFill: calls.duplicate,
  startObjectiveReviewedApplicationFill: calls.start,
}))
vi.mock("./reviewed-fill-admission", () => ({ assertReviewedFillLaunchAllowed: calls.launch }))

import { processObjectiveReviewedFillHandoffOutbox } from "./objective-reviewed-fill-dispatch"
import { ReviewedFillHandoffDeferredError } from "./reviewed-fill-handoff"
import { ReviewedFillSourceBindingError } from "./reviewed-fill-source-binding"

const userId = "owner-1", sessionId = "session-1", applicationTaskId = "application-task-1"
const approvalId = `objective-review:objective-review-${"a".repeat(40)}:2`, predecessorTurnId = "review-turn-1"
const built = buildObjectiveReviewedFillHandoffOutboxData({ userId, sessionId, applicationTaskId, approvalId, predecessorTurnId })!
const row = { id: "outbox-1", ...built }
const intent = row.payload
const db = {} as never

beforeEach(() => {
  vi.clearAllMocks()
  calls.owners.length = 0
  calls.duplicate.mockResolvedValue({ kind: "none" })
  calls.start.mockResolvedValue({ disposition: "started" })
  calls.launch.mockResolvedValue(undefined)
})

describe("Objective reviewed fill dispatcher", () => {
  it("runs the exact owner-bound handoff under tenant context and gates new work", async () => {
    await expect(processObjectiveReviewedFillHandoffOutbox(db, row)).resolves.toBe("queued")
    expect(calls.owners).toEqual([userId])
    expect(calls.duplicate).toHaveBeenCalledWith(db, intent)
    expect(calls.launch).toHaveBeenCalledWith(intent)
    expect(calls.start).toHaveBeenCalledWith(db, intent)
  })

  it("acknowledges a durable duplicate before fresh launch gates", async () => {
    calls.duplicate.mockResolvedValueOnce({ kind: "duplicate", result: { disposition: "duplicate" } })
    await expect(processObjectiveReviewedFillHandoffOutbox(db, row)).resolves.toBe("duplicate")
    expect(calls.owners).toEqual([userId])
    expect(calls.launch).not.toHaveBeenCalled()
    expect(calls.start).not.toHaveBeenCalled()
  })

  it("maps known deferral and proof rejection while preserving unexpected retries", async () => {
    calls.start.mockRejectedValueOnce(new ReviewedFillHandoffDeferredError())
    await expect(processObjectiveReviewedFillHandoffOutbox(db, row)).resolves.toBe("deferred")
    calls.start.mockRejectedValueOnce(new ReviewedFillSourceBindingError())
    await expect(processObjectiveReviewedFillHandoffOutbox(db, row)).resolves.toBe("terminal")
    calls.start.mockRejectedValueOnce(new Error("temporary database failure"))
    await expect(processObjectiveReviewedFillHandoffOutbox(db, row)).rejects.toThrow("temporary database failure")
  })

  it("rejects malformed or foreign rows before opening owner context", async () => {
    const malformed = { ...row, aggregateId: "other-session" }
    await expect(processObjectiveReviewedFillHandoffOutbox(db, malformed as never)).resolves.toBe("terminal")
    expect(calls.owners).toEqual([])
    expect(calls.start).not.toHaveBeenCalled()
  })
})
