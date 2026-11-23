import type { Pool } from "pg"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  mark: vi.fn(), record: vi.fn(), inspect: vi.fn(), readTurn: vi.fn(), readLegacyTurn: vi.fn(), reviewed: vi.fn(), audit: vi.fn(),
}))
vi.mock("../../db/application-task-state.js", () => ({ markSubmissionRequestStarted: mocks.mark }))
vi.mock("../../db/application-submission-stop-state.js", () => ({
  recordApplicationSubmissionStopStage: mocks.record, inspectApplicationSubmissionStopState: mocks.inspect,
}))
vi.mock("../../db/reviewed-application-submit-request-fence.js", () => ({
  readSubmissionTurnState: mocks.readLegacyTurn, readSubmissionTurnStopState: mocks.readTurn,
  withReviewedApplicationSubmitRequestFence: mocks.reviewed,
}))
vi.mock("../../queue/application-submit-fence.js", () => ({ appendFencedSubmitAudit: mocks.audit }))

import {
  acquireApplicationSubmissionStartFenceWithStopProtocol,
  isApplicationSubmissionStoppedWithStopProtocol,
} from "./application-submission-start-gate.js"
import { startApplicationSubmissionStopProbe } from "./application-submission-probe.js"

const scope = {
  userId: "user-1", sessionId: "session-1", turnId: "fill-turn-1", fillTurnId: "fill-turn-1",
  applicationTaskId: "application-1", jobId: "job-1", approvalId: "approval-1", constraintHash: "a".repeat(64),
  workerTaskId: "worker-1", executionId: "execution-1",
}
type StopState = {
  sessionStatus: string; turnStatus: string; leaseOwnerId: string | null; leaseStartedAt: Date | null
  leaseExpiresAt: Date | null; leaseVersion: number; interruptionEvidence: boolean
}
function completedTurn(overrides: Partial<StopState> = {}): StopState {
  return { sessionStatus: "completed", turnStatus: "completed", leaseOwnerId: null, leaseStartedAt: null,
    leaseExpiresAt: null, leaseVersion: 0, interruptionEvidence: false, ...overrides }
}
function activeTurn(overrides: Partial<StopState> = {}): StopState {
  const now = Date.now()
  return { sessionStatus: "running", turnStatus: "in_progress", leaseOwnerId: "worker-1",
    leaseStartedAt: new Date(now - 1_000), leaseExpiresAt: new Date(now + 60_000), leaseVersion: 1,
    interruptionEvidence: false, ...overrides }
}

function harness(options: { failedCommit?: number; checkpoint?: string } = {}) {
  const clients: Array<{ query: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> }> = []
  const connect = vi.fn(async () => {
    const index = clients.length
    const query = vi.fn(async (sql: string) => {
      if (sql === "COMMIT" && options.failedCommit === index) throw new Error("ambiguous commit")
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql) || sql.includes("set_config")) return { rows: [], rowCount: 1 }
      if (sql.includes('FROM "application_tasks"')) return { rows: [{ checkpoint: options.checkpoint ?? "submission_request_started" }], rowCount: 1 }
      throw new Error(`Unexpected SQL in start gate test: ${sql}`)
    })
    const client = { query, release: vi.fn() }
    clients.push(client)
    return client
  })
  return { pool: { connect } as unknown as Pool, clients, connect }
}

beforeEach(() => {
  mocks.mark.mockReset().mockResolvedValue("started")
  mocks.record.mockReset().mockResolvedValue("recorded")
  mocks.inspect.mockReset().mockResolvedValue("granted")
  mocks.readTurn.mockReset().mockResolvedValue(completedTurn())
  mocks.readLegacyTurn.mockReset().mockResolvedValue({ sessionStatus: "completed", turnStatus: "completed", interrupted: false })
  mocks.reviewed.mockReset().mockImplementation(async (
    _client: unknown, _scope: unknown, _phase: unknown, expected: string | null | undefined, work: () => Promise<unknown>,
  ) => ({ kind: "current", value: await work(), sourceTurnId: expected ?? "source-turn-1" }))
  mocks.audit.mockReset().mockResolvedValue(undefined)
})

describe("protocol-gated request boundary composition", () => {
  it("arms atomically with the marker, commits a separate grant, then holds a fresh source fence", async () => {
    const test = harness()
    const fence = await acquireApplicationSubmissionStartFenceWithStopProtocol(test.pool, scope)
    expect(fence.state).toBe("ready")
    expect(test.connect).toHaveBeenCalledTimes(3)
    expect(mocks.mark).toHaveBeenCalledOnce()
    expect(mocks.record.mock.calls.map(call => call[3])).toEqual(["armed", "dispatch_granted"])
    expect(mocks.inspect).toHaveBeenCalledOnce()
    expect(mocks.reviewed.mock.calls.map(call => [call[2], call[3]])).toEqual([
      ["marker", undefined], ["boundary", "source-turn-1"], ["boundary", "source-turn-1"],
    ])
    expect(test.clients.slice(0, 2).map(client => client.query.mock.calls[client.query.mock.calls.length - 1]?.[0])).toEqual(["COMMIT", "COMMIT"])
    const boundary = test.clients[2]!
    expect(boundary.query).not.toHaveBeenCalledWith("COMMIT")
    expect(boundary.release).not.toHaveBeenCalled()

    let resume!: () => void
    const resumed = new Promise<void>(resolve => { resume = resolve })
    const continuation = (async () => { await resumed; await fence.release(true) })()
    expect(boundary.query).not.toHaveBeenCalledWith("COMMIT")
    resume()
    await continuation
    expect(boundary.query).toHaveBeenLastCalledWith("COMMIT")
    expect(boundary.release).toHaveBeenCalledOnce()
  })

  it("lets an exact Stop before the grant prevent the final request boundary", async () => {
    const test = harness()
    mocks.record.mockResolvedValueOnce("recorded").mockResolvedValueOnce("stopped")
    await expect(acquireApplicationSubmissionStartFenceWithStopProtocol(test.pool, scope)).resolves.toMatchObject({ state: "stopped" })
    expect(test.connect).toHaveBeenCalledTimes(2)
    expect(test.clients[0]?.query).toHaveBeenCalledWith("COMMIT")
    expect(test.clients[1]?.query).toHaveBeenLastCalledWith("ROLLBACK")
    expect(mocks.inspect).not.toHaveBeenCalled()
  })

  it("fails closed on a duplicate grant or an ambiguous grant commit", async () => {
    const duplicate = harness()
    mocks.record.mockResolvedValueOnce("recorded").mockResolvedValueOnce("duplicate")
    await expect(acquireApplicationSubmissionStartFenceWithStopProtocol(duplicate.pool, scope)).resolves.toMatchObject({ state: "uncertain" })
    expect(duplicate.connect).toHaveBeenCalledTimes(2)
    expect(duplicate.clients[1]?.query).toHaveBeenLastCalledWith("ROLLBACK")

    const ambiguous = harness({ failedCommit: 1 })
    await expect(acquireApplicationSubmissionStartFenceWithStopProtocol(ambiguous.pool, scope)).resolves.toMatchObject({ state: "uncertain" })
    expect(ambiguous.connect).toHaveBeenCalledTimes(2)
    expect(ambiguous.clients[1]?.query).toHaveBeenCalledWith("ROLLBACK")
  })

  it("does not report a Stop as definite after the grant has committed", async () => {
    const test = harness()
    mocks.readTurn.mockResolvedValueOnce(completedTurn()).mockResolvedValueOnce(completedTurn())
      .mockResolvedValueOnce(completedTurn({ sessionStatus: "aborted" }))
    await expect(acquireApplicationSubmissionStartFenceWithStopProtocol(test.pool, scope)).resolves.toMatchObject({ state: "uncertain" })
    expect(test.connect).toHaveBeenCalledTimes(3)
    expect(test.clients[2]?.query).toHaveBeenLastCalledWith("ROLLBACK")
  })

  it("does not leave a marker when arming is duplicate or interrupted", async () => {
    const duplicateArm = harness()
    mocks.record.mockResolvedValueOnce("duplicate")
    await expect(acquireApplicationSubmissionStartFenceWithStopProtocol(duplicateArm.pool, scope)).resolves.toMatchObject({ state: "uncertain" })
    expect(duplicateArm.clients[0]?.query).toHaveBeenLastCalledWith("ROLLBACK")
    expect(duplicateArm.connect).toHaveBeenCalledOnce()

    const interrupted = harness()
    mocks.mark.mockClear()
    mocks.readTurn.mockResolvedValueOnce(completedTurn({ sessionStatus: "running", interruptionEvidence: true }))
    await expect(acquireApplicationSubmissionStartFenceWithStopProtocol(interrupted.pool, scope)).resolves.toMatchObject({ state: "stopped" })
    expect(mocks.mark).not.toHaveBeenCalled()
    expect(interrupted.connect).toHaveBeenCalledOnce()
  })

  it.each([
    ["failed Turn", completedTurn({ sessionStatus: "running", turnStatus: "failed" }), "stopped"],
    ["cancelled session", completedTurn({ sessionStatus: "cancelled" }), "stopped"],
    ["unsupported state", completedTurn({ sessionStatus: "waiting_for_user" }), "inactive"],
  ] as const)("denies a %s before arming", async (_label, state, expected) => {
    const test = harness()
    mocks.readTurn.mockResolvedValueOnce(state)
    await expect(acquireApplicationSubmissionStartFenceWithStopProtocol(test.pool, scope)).resolves.toMatchObject({ state: expected })
    expect(mocks.mark).not.toHaveBeenCalled()
    expect(mocks.record).not.toHaveBeenCalled()
    expect(test.connect).toHaveBeenCalledOnce()
  })

  it("admits an active Turn only while its exact lease is coherent and live", async () => {
    const test = harness()
    mocks.readTurn.mockResolvedValue(activeTurn())
    const fence = await acquireApplicationSubmissionStartFenceWithStopProtocol(test.pool, scope)
    expect(fence.state).toBe("ready")
    expect(mocks.record.mock.calls.map(call => call[3])).toEqual(["armed", "dispatch_granted"])
    expect(mocks.readTurn).toHaveBeenCalledTimes(3)
    await fence.release(false)
  })

  it.each([["grant", 2], ["final boundary", 3]] as const)("rechecks the lease at the %s", async (_phase, readNumber) => {
    const test = harness()
    const expired = activeTurn({ leaseExpiresAt: new Date(Date.now() - 1_000) })
    mocks.readTurn.mockResolvedValueOnce(completedTurn())
    if (readNumber === 3) mocks.readTurn.mockResolvedValueOnce(completedTurn())
    mocks.readTurn.mockResolvedValueOnce(expired)

    await expect(acquireApplicationSubmissionStartFenceWithStopProtocol(test.pool, scope)).resolves.toMatchObject({ state: "uncertain" })
    expect(mocks.readTurn).toHaveBeenCalledTimes(readNumber)
    expect(test.clients[readNumber - 1]?.query).toHaveBeenLastCalledWith("ROLLBACK")
  })

  it.each([
    ["expired lease", activeTurn({ leaseExpiresAt: new Date(Date.now() - 1_000) }), "inactive"],
    ["future lease start", activeTurn({ leaseStartedAt: new Date(Date.now() + 60_000) }), "inactive"],
    ["missing owner", activeTurn({ leaseOwnerId: null }), "inactive"],
    ["missing start", activeTurn({ leaseStartedAt: null }), "inactive"],
    ["missing expiry", activeTurn({ leaseExpiresAt: null }), "inactive"],
    ["zero lease version", activeTurn({ leaseVersion: 0 }), "inactive"],
    ["in-progress Turn in completed Session", activeTurn({ sessionStatus: "completed" }), "inactive"],
    ["completed Turn with a stale lease", completedTurn({ leaseOwnerId: "worker-1" }), "inactive"],
    ["interruption evidence", completedTurn({ interruptionEvidence: true }), "stopped"],
  ] as const)("refuses %s before arming", async (_label, state, expected) => {
    const test = harness()
    mocks.readTurn.mockResolvedValueOnce(state)
    await expect(acquireApplicationSubmissionStartFenceWithStopProtocol(test.pool, scope)).resolves.toMatchObject({ state: expected })
    expect(mocks.mark).not.toHaveBeenCalled()
    expect(mocks.record).not.toHaveBeenCalled()
    expect(test.connect).toHaveBeenCalledOnce()
  })

  it("rejects a foreign Turn before opening a transaction", async () => {
    const test = harness()
    await expect(acquireApplicationSubmissionStartFenceWithStopProtocol(test.pool, { ...scope, turnId: "foreign-turn" }))
      .resolves.toMatchObject({ state: "inactive" })
    expect(test.connect).not.toHaveBeenCalled()
  })

  it("keeps stale reviewed source and invalid final stage sets closed", async () => {
    const stale = harness()
    mocks.reviewed.mockImplementationOnce(async (_c, _s, _p, _e, work) => ({ kind: "current", value: await work(), sourceTurnId: "source-turn-1" }))
      .mockResolvedValueOnce({ kind: "invalid" })
    await expect(acquireApplicationSubmissionStartFenceWithStopProtocol(stale.pool, scope)).resolves.toMatchObject({ state: "uncertain" })
    expect(stale.connect).toHaveBeenCalledTimes(2)

    const invalidStage = harness()
    mocks.inspect.mockResolvedValueOnce("fenced")
    await expect(acquireApplicationSubmissionStartFenceWithStopProtocol(invalidStage.pool, scope)).resolves.toMatchObject({ state: "uncertain" })
    expect(invalidStage.clients[2]?.query).toHaveBeenLastCalledWith("ROLLBACK")
  })
})

describe("protocol Stop probe composition", () => {
  it("injects the exact protocol poll only through controlled Worker composition", async () => {
    const preMarker = harness({ checkpoint: "browser_active" })
    const controller = new AbortController()
    const probe = startApplicationSubmissionStopProbe({
      pool: preMarker.pool, scope, stopCheck: isApplicationSubmissionStoppedWithStopProtocol,
      closePage: vi.fn().mockResolvedValue(undefined), controller, hasSubmissionStarted: () => false,
      onStopped: vi.fn(), onUnavailable: vi.fn(), intervalMs: 100_000,
    })
    await probe.pollNow()
    expect(controller.signal.aborted).toBe(false)
    expect(mocks.reviewed.mock.calls[0]?.[2]).toBe("marker")
    probe.stop()

    const afterArm = harness()
    mocks.inspect.mockResolvedValueOnce("stopped")
    const stoppedController = new AbortController()
    const stoppedProbe = startApplicationSubmissionStopProbe({
      pool: afterArm.pool, scope, stopCheck: isApplicationSubmissionStoppedWithStopProtocol,
      closePage: vi.fn().mockResolvedValue(undefined), controller: stoppedController, hasSubmissionStarted: () => true,
      onStopped: vi.fn(), onUnavailable: vi.fn(), intervalMs: 100_000,
    })
    await stoppedProbe.pollNow()
    expect(stoppedController.signal.aborted).toBe(true)
    stoppedProbe.stop()
  })

  it("allows only an exact normal completed Turn before arming", async () => {
    const test = harness({ checkpoint: "browser_active" })
    await expect(isApplicationSubmissionStoppedWithStopProtocol(test.pool, scope)).resolves.toBe(false)
    expect(mocks.reviewed.mock.calls[0]?.[2]).toBe("marker")

    const stopped = harness({ checkpoint: "browser_active" })
    mocks.readTurn.mockResolvedValueOnce(completedTurn({ sessionStatus: "aborted" }))
    await expect(isApplicationSubmissionStoppedWithStopProtocol(stopped.pool, scope)).resolves.toBe(true)
  })

  it("fails closed when the active Turn lease is stale during Stop polling", async () => {
    const test = harness({ checkpoint: "browser_active" })
    mocks.readTurn.mockResolvedValueOnce(activeTurn({ leaseExpiresAt: new Date(Date.now() - 1_000) }))
    await expect(isApplicationSubmissionStoppedWithStopProtocol(test.pool, scope)).rejects.toThrow("Turn state is unavailable")
    expect(test.clients[0]?.query).toHaveBeenLastCalledWith("ROLLBACK")
  })

  it("observes the exact durable Stop after arming and fails closed on missing state", async () => {
    const stopped = harness()
    mocks.inspect.mockResolvedValueOnce("stopped")
    await expect(isApplicationSubmissionStoppedWithStopProtocol(stopped.pool, scope)).resolves.toBe(true)

    const missing = harness()
    mocks.inspect.mockResolvedValueOnce("missing")
    await expect(isApplicationSubmissionStoppedWithStopProtocol(missing.pool, scope)).rejects.toThrow("Stop state is unavailable")
    expect(missing.clients[0]?.query).toHaveBeenLastCalledWith("ROLLBACK")
  })

  it("treats a post-grant Turn interruption as uncertain, not a definite Stop", async () => {
    const test = harness()
    mocks.readTurn.mockResolvedValueOnce(completedTurn({ sessionStatus: "aborted" }))
    mocks.inspect.mockResolvedValueOnce("granted")
    await expect(isApplicationSubmissionStoppedWithStopProtocol(test.pool, scope)).rejects.toThrow("Stop state is unavailable")
  })
})
