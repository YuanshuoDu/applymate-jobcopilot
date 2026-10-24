import { describe, expect, it, vi } from "vitest"
import { resumeScheduledGatePrepareTurn, type ScheduledGatePrepareResumePorts } from "./scheduled-gate-prepare-pg-resume.fixture.js"
import type { TurnLease } from "../turns/lease.js"

const lease = (ownerId: string, leaseVersion: number): TurnLease => ({ turnId: "turn-1", sessionId: "session-1",
  userId: "user-1", ownerId, leaseVersion, leaseStartedAt: new Date(1_000), leaseExpiresAt: new Date(61_000) })
const input = () => ({ owner: { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1",
  rootAttemptCount: 1, turnLeaseOwnerId: "owner-v1", turnLeaseVersion: 1, executionId: "execution-1", executionAttemptCount: 1 },
  turnLease: lease("owner-v1", 1), waitId: "wait-1", expectedTurnRevision: 7, answer: "keep_resume",
  allowedActions: ["jobs.get"] as const })

describe("scheduled Gate Prepare PG resume fixture", () => {
  it("answers, closes the old lease, consumes the wakeup, and returns the exact next Root owner", async () => {
    const calls: string[] = []
    const ports: ScheduledGatePrepareResumePorts = {
      answerQuestion: vi.fn(async value => { calls.push("answer"); return { disposition: "resolved", status: "answered",
        waitId: value.waitId, turnId: value.expectedTurnId, nextTurnRevision: value.expectedRevision + 1 } }),
      finishRoot: vi.fn(async () => { calls.push("finish-root") }),
      finishExecution: vi.fn(async () => { calls.push("finish-execution") }),
      releaseTurn: vi.fn(async () => { calls.push("release"); return true }),
      drainWakeups: vi.fn(async () => { calls.push("wakeup"); return 1 }),
      claimTurn: vi.fn(async value => { calls.push("claim"); return lease(value.ownerId, 2) }),
      ensureRoot: vi.fn(async value => { calls.push("ensure"); return { id: value.rootTaskId, status: "running", leaseOwner: value.lease.ownerId } }),
      startExecution: vi.fn(async () => { calls.push("start") }),
    }
    const resumed = await resumeScheduledGatePrepareTurn({ ...input(), ports })
    expect(calls).toEqual(["answer", "finish-root", "finish-execution", "release", "wakeup", "claim", "ensure", "start"])
    expect(resumed.owner).toMatchObject({ turnLeaseOwnerId: "owner-v1-resumed", turnLeaseVersion: 2 })
    expect(resumed.turnExecutionOwner).toMatchObject({ kind: "turn", ownerId: "owner-v1-resumed", leaseVersion: 2,
      taskId: "root-1", rootTaskId: "root-1" })
  })

  it("does not release or reclaim a Turn if the exact question answer was not committed", async () => {
    const ports: ScheduledGatePrepareResumePorts = {
      answerQuestion: vi.fn(async value => ({ disposition: "stale", status: "answered", waitId: value.waitId,
        turnId: value.expectedTurnId, nextTurnRevision: value.expectedRevision })),
      finishRoot: vi.fn(), finishExecution: vi.fn(), releaseTurn: vi.fn(async () => true), drainWakeups: vi.fn(async () => 1),
      claimTurn: vi.fn(async value => lease(value.ownerId, 2)),
      ensureRoot: vi.fn(async value => ({ id: value.rootTaskId, status: "running", leaseOwner: value.lease.ownerId })),
      startExecution: vi.fn(),
    }
    await expect(resumeScheduledGatePrepareTurn({ ...input(), ports })).rejects.toThrow("scheduled_prepare_answer_not_committed")
    expect(ports.finishRoot).not.toHaveBeenCalled()
    expect(ports.releaseTurn).not.toHaveBeenCalled()
    expect(ports.claimTurn).not.toHaveBeenCalled()
  })
})
