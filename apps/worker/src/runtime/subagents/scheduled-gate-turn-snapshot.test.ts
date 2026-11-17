import { beforeEach, describe, expect, it, vi } from "vitest"
import { readScheduledGateTurnSnapshot } from "./scheduled-gate-turn-snapshot.js"

const mocks = vi.hoisted(() => ({ approvalIds: vi.fn() }))
vi.mock("./scheduled-prepare-gate-wait-witness.js", async importOriginal => {
  const actual = await importOriginal<typeof import("./scheduled-prepare-gate-wait-witness.js")>()
  return { ...actual, scheduledPrepareGateApprovalWitnessIds: mocks.approvalIds }
})

const scope = { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1",
  turnLeaseOwner: "turn-owner", turnLeaseVersion: 5 }
const witness = { gateTaskId: "gate-1", gateAttemptCount: 2, leaseOwnerId: "gate-owner", requestAttemptCount: 1,
  preparedJobIds: ["job-1"] }

function row(overrides: Record<string, unknown> = {}) {
  return { sessionId: scope.sessionId, sessionUserId: scope.userId, sessionStatus: "running", turnId: scope.turnId,
    turnSessionId: scope.sessionId, turnUserId: scope.userId, turnRootTaskId: scope.rootTaskId,
    turnStatus: "waiting_for_approval", source: "automation", executionMode: "canonical_task_graph", input: {},
    turnLeaseOwnerId: scope.turnLeaseOwner, turnLeaseVersion: scope.turnLeaseVersion,
    turnLeaseExpiresAt: new Date("2026-11-16T12:05:00Z"), turnLeaseValid: true,
    rootId: scope.rootTaskId, rootSessionId: scope.sessionId, rootTurnId: scope.turnId, rootStatus: "running",
    rootAttemptCount: 3, rootInterruptRequestedAt: null, rootClosedAt: null, ...overrides }
}
function client(value: Record<string, unknown>) {
  return { query: vi.fn(async () => ({ rows: [value] })) }
}

describe("scheduled Gate Turn snapshot", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.approvalIds.mockResolvedValue(["approval-1"]) })

  it("accepts a running Root approval wait under the current live Turn lease", async () => {
    await expect(readScheduledGateTurnSnapshot(client(row()) as never, scope, 3, "completed", witness))
      .resolves.toMatchObject({ source: "automation", executionMode: "canonical_task_graph" })
    expect(mocks.approvalIds).toHaveBeenCalledOnce()
  })

  it.each([
    ["missing Turn owner", { turnLeaseOwnerId: null }],
    ["invalid lease version", { turnLeaseVersion: 0 }],
    ["expired lease", { turnLeaseValid: false }],
  ] as const)("rejects a running Root approval wait with a %s", async (_label, overrides) => {
    await expect(readScheduledGateTurnSnapshot(client(row(overrides)) as never, scope, 3, "completed", witness)).resolves.toBeNull()
    expect(mocks.approvalIds).not.toHaveBeenCalled()
  })

  it("requires an unleased Turn when the Root is parked on its approval wait", async () => {
    const parked = row({ rootStatus: "waiting", turnLeaseOwnerId: null, turnLeaseExpiresAt: null, turnLeaseValid: false })
    await expect(readScheduledGateTurnSnapshot(client(parked) as never, scope, 3, "completed", witness))
      .resolves.toMatchObject({ source: "automation" })
    await expect(readScheduledGateTurnSnapshot(client(row({ rootStatus: "waiting" })) as never, scope, 3, "completed", witness))
      .resolves.toBeNull()
  })

  it("rejects approval waits without an active witness or on a question-required finish", async () => {
    mocks.approvalIds.mockResolvedValue([])
    await expect(readScheduledGateTurnSnapshot(client(row()) as never, scope, 3, "completed", witness)).resolves.toBeNull()
    mocks.approvalIds.mockResolvedValue(["approval-1"])
    await expect(readScheduledGateTurnSnapshot(client(row()) as never, scope, 3, "waiting_for_user", witness)).resolves.toBeNull()
  })
})
