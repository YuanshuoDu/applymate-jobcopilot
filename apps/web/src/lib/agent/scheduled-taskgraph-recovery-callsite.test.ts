import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ matching: vi.fn(), recovery: vi.fn() }))
vi.mock("./scheduled-taskgraph-pipeline-request", () => ({ matchingTurnSnapshot: mocks.matching }))
vi.mock("./scheduled-taskgraph-recovery-admission", () => ({ resolveScheduledTaskGraphRecoveryAdmission: mocks.recovery }))

import { scheduledTaskGraphGatePreflightSnapshot, scheduledTaskGraphRecoverySnapshot } from "./scheduled-taskgraph-recovery-callsite"

const snapshot = { schemaVersion: "agent-harness.v2.scheduled-automation-snapshot.v1", targetRoles: ["Engineer"],
  targetLocations: ["Dublin"], minScore: 70, dailyCap: 1, requireApproval: true, autoApply: false }
const owner = { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", rootAttemptCount: 1,
  turnLeaseOwnerId: "worker-1", turnLeaseVersion: 2, executionId: "execution-1", executionAttemptCount: 3 }
const request = new Request("https://local.test/private", { headers: { "x-agent-worker-secret": "worker-secret" } })
const client = { $queryRaw: vi.fn(), agentExecution: { findFirst: vi.fn().mockResolvedValue({ id: owner.executionId,
  attemptCount: owner.executionAttemptCount }) } } as unknown as Parameters<typeof scheduledTaskGraphRecoverySnapshot>[0]["client"]

beforeEach(() => {
  mocks.matching.mockReset()
  mocks.recovery.mockReset().mockResolvedValue(null)
})

describe("scheduled TaskGraph recovery callsites", () => {
  it("keeps scheduled snapshots on the existing path", async () => {
    mocks.matching.mockReturnValue(snapshot)

    await expect(scheduledTaskGraphRecoverySnapshot({ client, request, owner, turnInput: {}, caller: "gate" })).resolves.toBe(snapshot)

    expect(mocks.recovery).not.toHaveBeenCalled()
  })

  it("adds the persisted execution identity for Gate preflight", async () => {
    mocks.matching.mockReturnValue(null)
    mocks.recovery.mockResolvedValue({ snapshot, automationId: "automation-1", owner })
    const gateOwner = { userId: owner.userId, sessionId: owner.sessionId, turnId: owner.turnId, rootTaskId: owner.rootTaskId,
      rootAttemptCount: owner.rootAttemptCount, turnLeaseOwnerId: owner.turnLeaseOwnerId, turnLeaseVersion: owner.turnLeaseVersion }

    await expect(scheduledTaskGraphGatePreflightSnapshot({ client, request, owner: gateOwner,
      turnInput: { automationRunMode: "manual" } })).resolves.toBe(snapshot)

    expect(client.agentExecution.findFirst).toHaveBeenCalledWith({ where: { userId: owner.userId, sessionId: owner.sessionId },
      select: { id: true, attemptCount: true } })
    expect(mocks.recovery).toHaveBeenCalledWith({ client, request, owner, caller: "gate" })
  })

  it.each(["analyze_prepare", "gate"] as const)("uses the persisted admission only for %s", async caller => {
    mocks.matching.mockReturnValue(null)
    mocks.recovery.mockResolvedValue({ snapshot, automationId: "automation-1", owner })

    await expect(scheduledTaskGraphRecoverySnapshot({ client, request, owner, turnInput: { automationRunMode: "manual" }, caller }))
      .resolves.toBe(snapshot)

    expect(mocks.recovery).toHaveBeenCalledWith({ client, request, owner, caller })
  })

  it.each(["execute", "audit"] as const)("does not extend recovery admission to %s", async caller => {
    mocks.matching.mockReturnValue(null)

    await expect(scheduledTaskGraphRecoverySnapshot({ client, request, owner, turnInput: { automationRunMode: "manual" }, caller }))
      .resolves.toBeNull()

    expect(mocks.recovery).not.toHaveBeenCalled()
  })

  it("fails closed when the private HTTP request is unavailable", async () => {
    mocks.matching.mockReturnValue(null)

    await expect(scheduledTaskGraphRecoverySnapshot({ client, owner, turnInput: { automationRunMode: "manual" }, caller: "gate" }))
      .resolves.toBeNull()

    expect(mocks.recovery).not.toHaveBeenCalled()
  })
})
