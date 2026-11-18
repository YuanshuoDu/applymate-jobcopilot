import { describe, expect, it, vi } from "vitest"
import { startMaterialDriftRecovery } from "./material-drift-recovery"
import { scheduledAutomationSnapshotDigest } from "./scheduled-taskgraph-pipeline-checkpoint"
describe("startMaterialDriftRecovery", () => {
  const owner = { userId: "user_1", sessionId: "session_1", turnId: "turn_old", rootTaskId: "root_old",
    rootAttemptCount: 2, turnLeaseOwnerId: "turn_lease_old", turnLeaseVersion: 3, executionId: "execution_1", executionAttemptCount: 4 }
  const gateOwner = { taskId: "gate_old", leaseOwnerId: "gate_lease_old", attemptCount: 5 }
  const sourceMarker = { schemaVersion: "agent-harness.v2.scheduled-prepare-material-drift-terminal.v1",
    reason: "scheduled_prepare_material_source_changed", owner, gate: gateOwner,
    analyzeFingerprintDigest: `sha256:${"a".repeat(64)}`, prepareProofDigest: `sha256:${"b".repeat(64)}`,
    artifactDigest: `sha256:${"c".repeat(64)}`, currentMaterialDigest: `sha256:${"d".repeat(64)}`, proofDigest: `sha256:${"e".repeat(64)}` }
  const automation = { id: "automation_1", name: "Weekday Scout", enabled: true, cron: "0 9 * * 1-5",
    timezone: "Europe/Berlin", triggerType: "weekdays", targetRoles: ["SWE"], targetLocations: ["Berlin"],
    minScore: 85, dailyCap: 8, requireApproval: true, autoApply: false, sessionId: "session_1" }
  const stoppedTurn = { id: owner.turnId, userId: owner.userId, sessionId: owner.sessionId, status: "interrupted",
    source: "automation", executionMode: "canonical_task_graph", input: { automationRunMode: "scheduled" },
    rootTaskId: owner.rootTaskId, leaseVersion: owner.turnLeaseVersion, createdAt: new Date("2026-11-17T09:00:00Z") }
  const root = { id: owner.rootTaskId, sessionId: owner.sessionId, turnId: owner.turnId, rootTaskId: owner.rootTaskId,
    parentTaskId: null, depth: 0, role: "orchestrator", taskType: "root", status: "failed", attemptCount: owner.rootAttemptCount }
  const gate = { id: gateOwner.taskId, sessionId: owner.sessionId, turnId: owner.turnId, rootTaskId: owner.rootTaskId,
    parentTaskId: owner.rootTaskId, depth: 1, role: "prepare", taskType: "scheduled_taskgraph_gate", status: "failed", attemptCount: gateOwner.attemptCount }
  const execution = { id: owner.executionId, userId: owner.userId, sessionId: owner.sessionId, status: "failed",
    error: "scheduled_prepare_material_source_changed", attemptCount: owner.executionAttemptCount,
    state: { scheduledTaskGraphMaterialDriftTerminal: sourceMarker } }
  const session = { id: "session_1", goal: "Run automation: Weekday Scout", status: "running", source: "automation", memorySummary: "Automation queued for execution.", qualityScore: null, currentTaskId: null, createdAt: new Date("2026-08-29T08:00:00Z"), updatedAt: new Date("2026-11-18T09:00:00Z"), completedAt: null }

  function snapshotForTest(minScore = 85) {
    return { schemaVersion: "agent-harness.v2.scheduled-automation-snapshot.v1", targetRoles: ["SWE"], targetLocations: ["Berlin"],
      minScore, dailyCap: 8, requireApproval: true, autoApply: false }
  }

  function intentFor(turnId: string, reservedExecutionAttemptCount: number, previousRecoveryTurnId: string | null = null, minScore = 85) {
    return { schemaVersion: "agent-harness.v2.material-drift-recovery.v2", turnId, userId: owner.userId, sessionId: owner.sessionId,
      automationId: automation.id, previousTurnId: owner.turnId, previousExecutionId: owner.executionId,
      previousGateTaskId: gateOwner.taskId, previousGateAttemptCount: gateOwner.attemptCount,
      previousRootTaskId: owner.rootTaskId, previousRootAttemptCount: owner.rootAttemptCount,
      previousTurnLeaseVersion: owner.turnLeaseVersion, previousExecutionAttemptCount: owner.executionAttemptCount,
      previousRecoveryTurnId, reservedExecutionAttemptCount,
      currentSnapshotDigest: scheduledAutomationSnapshotDigest(snapshotForTest(minScore)), sourceMarker }
  }

  function recoveredTurn(id: string, previousRecoveryTurnId: string | null, reserved: number, createdAt: string) {
    return { ...stoppedTurn, id, status: "interrupted", rootTaskId: `root_${id}`,
      input: { automationRunMode: "manual", scheduledAutomationSnapshot: snapshotForTest(80 + reserved),
        materialDriftRecovery: intentFor(id, reserved, previousRecoveryTurnId, 80 + reserved) },
      createdAt: new Date(createdAt) }
  }

  function recoveryDb(overrides: { turn?: unknown; execution?: unknown; queryResults?: unknown[][]; sessionStatus?: string;
    automationSessionId?: string | null } = {}) {
    const currentExecution = overrides.execution ?? execution
    const currentAutomation = overrides.automationSessionId === undefined ? automation : { ...automation, sessionId: overrides.automationSessionId }
    const closed = overrides.sessionStatus === "aborted" || overrides.sessionStatus === "archived"
    const queryResults = overrides.queryResults ?? (closed
      ? [[currentAutomation], [{ id: "session_1", source: "automation", status: overrides.sessionStatus }], [overrides.turn ?? stoppedTurn], [currentExecution]]
      : [[currentAutomation], [{ id: "session_1", source: "automation", status: "running" }], [overrides.turn ?? stoppedTurn], [], [root], [gate], [currentExecution]])
    const tx = {
      $queryRaw: vi.fn(async () => queryResults.shift() ?? []),
      agentExecution: { findFirst: vi.fn().mockImplementation(() => Promise.resolve(currentExecution)), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      agentAutomation: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      agentSession: { updateMany: vi.fn().mockResolvedValue({ count: 1 }), findFirst: vi.fn().mockResolvedValue(session) },
      agentTurn: { create: vi.fn().mockResolvedValue({}) },
      agentOutbox: {
        create: vi.fn().mockResolvedValue({}),
        findUnique: vi.fn().mockImplementation(({ where }: { where: { idempotencyKey: string } }) => {
          const turnId = where.idempotencyKey.replace("turn-dispatch:", "")
          return Promise.resolve({ id: "dispatch_1", topic: "agent.turn.dispatch", aggregateId: owner.sessionId,
            idempotencyKey: where.idempotencyKey, payload: { turnId, sessionId: owner.sessionId, ownerId: `web:${turnId}` } })
        }),
      },
    }
    const db = { $transaction: vi.fn((work: (value: never) => unknown) => work(tx as never)) }
    return { db, tx }
  }

  it("creates a bound manual Turn and dispatch intent after locked owner/lineage verification", async () => {
    const { db, tx } = recoveryDb()

    const result = await startMaterialDriftRecovery(db as never, { automationId: "automation_1", userId: "user_1",
      sessionId: "session_1", now: new Date("2026-11-18T09:00:00.000Z") })

    expect(result).toMatchObject({ kind: "created", automation, session, executionId: execution.id })
    expect(db.$transaction).toHaveBeenCalledOnce()
    expect(tx.$queryRaw).toHaveBeenCalledTimes(7)
    const rawCallOrder = tx.$queryRaw.mock.invocationCallOrder
    expect(tx.agentExecution.findFirst.mock.invocationCallOrder[0]).toBeGreaterThan(rawCallOrder[2])
    expect(tx.agentExecution.findFirst.mock.invocationCallOrder[0]).toBeLessThan(rawCallOrder[3])
    expect(rawCallOrder[5]).toBeLessThan(rawCallOrder[6])
    const createTurnOrder = tx.agentTurn.create.mock.invocationCallOrder[0]
    expect(createTurnOrder).toBeGreaterThan(rawCallOrder[6])
    expect(tx.agentExecution.updateMany.mock.invocationCallOrder[0]).toBeGreaterThan(createTurnOrder)
    expect(tx.agentOutbox.create.mock.invocationCallOrder[0]).toBeGreaterThan(tx.agentExecution.updateMany.mock.invocationCallOrder[0])
    const created = tx.agentTurn.create.mock.calls[0]?.[0]?.data as { id: string; executionMode: string; input: Record<string, unknown> }
    const intent = created.input.materialDriftRecovery as Record<string, unknown>
    expect(created).toMatchObject({ executionMode: "canonical_task_graph", input: {
      automationRunMode: "manual", scheduledAutomationSnapshot: { targetRoles: ["SWE"], targetLocations: ["Berlin"], requireApproval: true, autoApply: false },
    } })
    expect(intent).toEqual(expect.objectContaining({ schemaVersion: "agent-harness.v2.material-drift-recovery.v2",
      turnId: created.id, userId: owner.userId, sessionId: owner.sessionId, automationId: automation.id,
      previousTurnId: owner.turnId, previousExecutionId: owner.executionId, previousGateTaskId: gateOwner.taskId,
      previousGateAttemptCount: gateOwner.attemptCount, previousRootTaskId: owner.rootTaskId,
      previousRootAttemptCount: owner.rootAttemptCount, previousTurnLeaseVersion: owner.turnLeaseVersion,
      previousExecutionAttemptCount: owner.executionAttemptCount, previousRecoveryTurnId: null,
      reservedExecutionAttemptCount: owner.executionAttemptCount + 1, sourceMarker }))
    const outbox = tx.agentOutbox.create.mock.calls[0]?.[0]?.data
    expect(outbox).toMatchObject({ topic: "agent.turn.dispatch", aggregateId: owner.sessionId,
      idempotencyKey: `turn-dispatch:${created.id}`, payload: { turnId: created.id, sessionId: owner.sessionId, ownerId: `web:${created.id}` } })
    expect(tx.agentExecution.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: execution.id, status: "failed", attemptCount: execution.attemptCount }),
      data: expect.objectContaining({ attemptCount: { increment: 1 }, status: "queued", checkpoint: "scout", workerTaskId: null }),
    }))
  })

  it("replays the same queued Turn and outbox for an idempotent duplicate request", async () => {
    const recoveryIntent = intentFor(owner.turnId, 5)
    const queuedTurn = { ...stoppedTurn, status: "queued", executionMode: "canonical_task_graph",
      input: { automationRunMode: "manual", scheduledAutomationSnapshot: snapshotForTest(), materialDriftRecovery: recoveryIntent } }
    const { db, tx } = recoveryDb({ turn: queuedTurn, execution: { ...execution, attemptCount: 5, status: "queued", state: {}, error: null } })

    await expect(startMaterialDriftRecovery(db as never, { automationId: "automation_1", userId: "user_1", sessionId: "session_1" }))
      .resolves.toMatchObject({ kind: "already_started", turnId: owner.turnId, executionId: execution.id,
        dispatchId: "dispatch_1", turnStatus: "queued" })
    expect(tx.agentTurn.create).not.toHaveBeenCalled()
    expect(tx.agentExecution.updateMany).not.toHaveBeenCalled()
    expect(tx.agentOutbox.create).not.toHaveBeenCalled()
  })

  it("returns to ordinary Run Now after a completed recovery without touching its attempt", async () => {
    const recoveryIntent = intentFor("recovery_done", 5)
    const completedTurn = { ...stoppedTurn, id: "recovery_done", status: "completed", executionMode: "canonical_task_graph",
      input: { automationRunMode: "manual", scheduledAutomationSnapshot: snapshotForTest(), materialDriftRecovery: recoveryIntent } }
    const { db, tx } = recoveryDb({ turn: completedTurn, execution: { ...execution, attemptCount: 5, status: "completed", state: {}, error: null } })

    await expect(startMaterialDriftRecovery(db as never, { automationId: "automation_1", userId: "user_1", sessionId: "session_1" }))
      .resolves.toBeNull()
    expect(tx.agentTurn.create).not.toHaveBeenCalled()
    expect(tx.agentExecution.updateMany).not.toHaveBeenCalled()
    expect(tx.agentOutbox.create).not.toHaveBeenCalled()
  })

  it("chains a third stopped recovery to the immutable source and reserves exactly the next attempt", async () => {
    const first = recoveredTurn("recovery_1", null, 5, "2026-11-18T09:10:00Z")
    const second = recoveredTurn("recovery_2", "recovery_1", 6, "2026-11-18T09:20:00Z")
    const latest = recoveredTurn("recovery_3", "recovery_2", 7, "2026-11-18T09:30:00Z")
    const pausedExecution = { ...execution, status: "paused", error: null, state: {}, attemptCount: 7 }
    const { db, tx } = recoveryDb({ turn: latest, execution: pausedExecution, queryResults: [
      [automation], [{ id: "session_1", source: "automation" }], [latest], [second], [first], [stoppedTurn], [], [root], [gate], [pausedExecution],
    ] })

    const result = await startMaterialDriftRecovery(db as never, { automationId: "automation_1", userId: "user_1",
      sessionId: "session_1", now: new Date("2026-11-18T09:40:00Z") })

    expect(result).toMatchObject({ kind: "created", turnStatus: "queued", executionId: execution.id })
    const created = tx.agentTurn.create.mock.calls[0]?.[0]?.data as { id: string; input: Record<string, unknown> }
    expect(created.input.materialDriftRecovery).toEqual(expect.objectContaining({ schemaVersion: "agent-harness.v2.material-drift-recovery.v2",
      turnId: created.id, previousTurnId: owner.turnId, previousRecoveryTurnId: latest.id,
      previousExecutionAttemptCount: owner.executionAttemptCount, reservedExecutionAttemptCount: 8, sourceMarker }))
    expect(tx.agentExecution.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ status: "paused", attemptCount: 7 }),
      data: expect.objectContaining({ attemptCount: { increment: 1 }, status: "queued" }),
    }))
    expect(tx.agentOutbox.create).toHaveBeenCalledOnce()
  })

  it("fails closed when the exact stopped marker is absent", async () => {
    const { db, tx } = recoveryDb({ execution: { ...execution, state: {} } })

    await expect(startMaterialDriftRecovery(db as never, { automationId: "automation_1", userId: "user_1", sessionId: "session_1" }))
      .resolves.toEqual({ kind: "rejected" })
    expect(tx.agentTurn.create).not.toHaveBeenCalled()
    expect(tx.agentExecution.updateMany).not.toHaveBeenCalled()
    expect(tx.agentOutbox.create).not.toHaveBeenCalled()
  })

  it("falls through only when no material-drift marker or error is present", async () => {
    const { db, tx } = recoveryDb({ execution: { ...execution, state: {}, error: null } })

    await expect(startMaterialDriftRecovery(db as never, { automationId: "automation_1", userId: "user_1", sessionId: "session_1" }))
      .resolves.toBeNull()
    expect(tx.agentTurn.create).not.toHaveBeenCalled()
    expect(tx.agentExecution.updateMany).not.toHaveBeenCalled()
    expect(tx.agentOutbox.create).not.toHaveBeenCalled()
  })

  it("rejects an archived owner-linked session with a terminal drift marker", async () => {
    const { db, tx } = recoveryDb({ sessionStatus: "archived" })

    await expect(startMaterialDriftRecovery(db as never, { automationId: "automation_1", userId: "user_1", sessionId: "session_1" }))
      .resolves.toEqual({ kind: "rejected" })
    expect(tx.$queryRaw).toHaveBeenCalledTimes(4)
    expect(tx.agentTurn.create).not.toHaveBeenCalled()
    expect(tx.agentExecution.updateMany).not.toHaveBeenCalled()
    expect(tx.agentAutomation.updateMany).not.toHaveBeenCalled()
    expect(tx.agentSession.updateMany).not.toHaveBeenCalled()
    expect(tx.agentOutbox.create).not.toHaveBeenCalled()
  })

  it("rejects an aborted owner-linked session with the material-drift error", async () => {
    const { db, tx } = recoveryDb({ sessionStatus: "aborted", execution: { ...execution, state: {}, error: "scheduled_prepare_material_source_changed" } })

    await expect(startMaterialDriftRecovery(db as never, { automationId: "automation_1", userId: "user_1", sessionId: "session_1" }))
      .resolves.toEqual({ kind: "rejected" })
    expect(tx.agentTurn.create).not.toHaveBeenCalled()
    expect(tx.agentExecution.updateMany).not.toHaveBeenCalled()
    expect(tx.agentAutomation.updateMany).not.toHaveBeenCalled()
    expect(tx.agentSession.updateMany).not.toHaveBeenCalled()
    expect(tx.agentOutbox.create).not.toHaveBeenCalled()
  })

  it("rejects an archived session when its latest Turn carries even an invalid recovery intent", async () => {
    const forgedTurn = { ...stoppedTurn, input: { ...stoppedTurn.input, materialDriftRecovery: { schemaVersion: "forged" } } }
    const { db, tx } = recoveryDb({ sessionStatus: "archived", turn: forgedTurn, execution: { ...execution, state: {}, error: null } })

    await expect(startMaterialDriftRecovery(db as never, { automationId: "automation_1", userId: "user_1", sessionId: "session_1" }))
      .resolves.toEqual({ kind: "rejected" })
    expect(tx.agentTurn.create).not.toHaveBeenCalled()
    expect(tx.agentExecution.updateMany).not.toHaveBeenCalled()
    expect(tx.agentAutomation.updateMany).not.toHaveBeenCalled()
    expect(tx.agentSession.updateMany).not.toHaveBeenCalled()
    expect(tx.agentOutbox.create).not.toHaveBeenCalled()
  })

  it("preserves the no-drift fallthrough for a closed owner-linked session", async () => {
    const { db, tx } = recoveryDb({ sessionStatus: "archived", execution: { ...execution, state: {}, error: null } })

    await expect(startMaterialDriftRecovery(db as never, { automationId: "automation_1", userId: "user_1", sessionId: "session_1" }))
      .resolves.toBeNull()
    expect(tx.agentTurn.create).not.toHaveBeenCalled()
    expect(tx.agentExecution.updateMany).not.toHaveBeenCalled()
    expect(tx.agentAutomation.updateMany).not.toHaveBeenCalled()
    expect(tx.agentSession.updateMany).not.toHaveBeenCalled()
    expect(tx.agentOutbox.create).not.toHaveBeenCalled()
  })

  it("rejects a source-mismatched open session when its scoped execution has a drift marker", async () => {
    const { db, tx } = recoveryDb({ queryResults: [[automation], [{ id: "session_1", source: "user", status: "running" }],
      [stoppedTurn], [{ state: execution.state, error: null }]] })

    await expect(startMaterialDriftRecovery(db as never, { automationId: "automation_1", userId: "user_1", sessionId: "session_1" }))
      .resolves.toEqual({ kind: "rejected" })
    expect(tx.$queryRaw).toHaveBeenCalledTimes(4)
    expect(tx.agentTurn.create).not.toHaveBeenCalled()
    expect(tx.agentExecution.updateMany).not.toHaveBeenCalled()
    expect(tx.agentAutomation.updateMany).not.toHaveBeenCalled()
    expect(tx.agentSession.updateMany).not.toHaveBeenCalled()
    expect(tx.agentOutbox.create).not.toHaveBeenCalled()
  })

  it("rejects a drift error when the latest owner-scoped Turn is missing", async () => {
    const { db, tx } = recoveryDb({ queryResults: [[automation], [{ id: "session_1", source: "automation", status: "running" }],
      [], [{ state: {}, error: "scheduled_prepare_material_source_changed" }]] })

    await expect(startMaterialDriftRecovery(db as never, { automationId: "automation_1", userId: "user_1", sessionId: "session_1" }))
      .resolves.toEqual({ kind: "rejected" })
    expect(tx.$queryRaw).toHaveBeenCalledTimes(4)
    expect(tx.agentTurn.create).not.toHaveBeenCalled()
    expect(tx.agentExecution.updateMany).not.toHaveBeenCalled()
    expect(tx.agentAutomation.updateMany).not.toHaveBeenCalled()
    expect(tx.agentSession.updateMany).not.toHaveBeenCalled()
    expect(tx.agentOutbox.create).not.toHaveBeenCalled()
  })

  it("rejects any present recovery intent on a source-mismatched session", async () => {
    const intentTurn = { ...stoppedTurn, input: { ...stoppedTurn.input, materialDriftRecovery: { untrusted: true } } }
    const { db, tx } = recoveryDb({ queryResults: [[automation], [{ id: "session_1", source: "user", status: "running" }],
      [intentTurn], [{ state: {}, error: null }]] })

    await expect(startMaterialDriftRecovery(db as never, { automationId: "automation_1", userId: "user_1", sessionId: "session_1" }))
      .resolves.toEqual({ kind: "rejected" })
    expect(tx.agentTurn.create).not.toHaveBeenCalled()
    expect(tx.agentExecution.updateMany).not.toHaveBeenCalled()
    expect(tx.agentAutomation.updateMany).not.toHaveBeenCalled()
    expect(tx.agentSession.updateMany).not.toHaveBeenCalled()
    expect(tx.agentOutbox.create).not.toHaveBeenCalled()
  })

  it("preserves ordinary fallback for an open source-mismatched session with no drift evidence", async () => {
    const { db, tx } = recoveryDb({ queryResults: [[automation], [{ id: "session_1", source: "user", status: "running" }],
      [stoppedTurn], [{ state: {}, error: null }]] })

    await expect(startMaterialDriftRecovery(db as never, { automationId: "automation_1", userId: "user_1", sessionId: "session_1" }))
      .resolves.toBeNull()
    expect(tx.agentTurn.create).not.toHaveBeenCalled()
    expect(tx.agentExecution.updateMany).not.toHaveBeenCalled()
    expect(tx.agentAutomation.updateMany).not.toHaveBeenCalled()
    expect(tx.agentSession.updateMany).not.toHaveBeenCalled()
    expect(tx.agentOutbox.create).not.toHaveBeenCalled()
  })

  it("preserves ordinary fallback when an open owner-linked session has no latest Turn or drift evidence", async () => {
    const { db, tx } = recoveryDb({ queryResults: [[automation], [{ id: "session_1", source: "automation", status: "running" }],
      [], [{ state: {}, error: null }]] })

    await expect(startMaterialDriftRecovery(db as never, { automationId: "automation_1", userId: "user_1", sessionId: "session_1" }))
      .resolves.toBeNull()
    expect(tx.agentTurn.create).not.toHaveBeenCalled()
    expect(tx.agentExecution.updateMany).not.toHaveBeenCalled()
    expect(tx.agentAutomation.updateMany).not.toHaveBeenCalled()
    expect(tx.agentSession.updateMany).not.toHaveBeenCalled()
    expect(tx.agentOutbox.create).not.toHaveBeenCalled()
  })

  it("rejects a linked session missing from the owner-scoped session query", async () => {
    const { db, tx } = recoveryDb({ queryResults: [[automation], []] })

    await expect(startMaterialDriftRecovery(db as never, { automationId: "automation_1", userId: "user_1", sessionId: "session_1" }))
      .resolves.toEqual({ kind: "rejected" })
    expect(tx.$queryRaw).toHaveBeenCalledTimes(2)
    expect(tx.agentTurn.create).not.toHaveBeenCalled()
    expect(tx.agentExecution.updateMany).not.toHaveBeenCalled()
    expect(tx.agentAutomation.updateMany).not.toHaveBeenCalled()
    expect(tx.agentSession.updateMany).not.toHaveBeenCalled()
    expect(tx.agentOutbox.create).not.toHaveBeenCalled()
  })

  it("preserves the first Run Now fallthrough when the automation has no session", async () => {
    const { db, tx } = recoveryDb({ automationSessionId: null, queryResults: [[{ ...automation, sessionId: null }]] })

    await expect(startMaterialDriftRecovery(db as never, { automationId: "automation_1", userId: "user_1", sessionId: null }))
      .resolves.toBeNull()
    expect(tx.$queryRaw).toHaveBeenCalledOnce()
    expect(tx.agentTurn.create).not.toHaveBeenCalled()
  })

  it.each([
    ["malformed marker", { ...execution, state: { scheduledTaskGraphMaterialDriftTerminal: { reason: sourceMarker.reason } } }],
    ["owner mismatch", { ...execution, state: { scheduledTaskGraphMaterialDriftTerminal: { ...sourceMarker,
      owner: { ...owner, turnId: "foreign_turn" } } } }],
  ])("rejects an indicated but unverifiable drift lineage (%s)", async (_label, badExecution) => {
    const { db, tx } = recoveryDb({ execution: badExecution })

    await expect(startMaterialDriftRecovery(db as never, { automationId: "automation_1", userId: "user_1", sessionId: "session_1" }))
      .resolves.toEqual({ kind: "rejected" })
    expect(tx.agentTurn.create).not.toHaveBeenCalled()
    expect(tx.agentExecution.updateMany).not.toHaveBeenCalled()
    expect(tx.agentOutbox.create).not.toHaveBeenCalled()
  })

  it("fails closed before reserving when the PostgreSQL attempt counter is exhausted", async () => {
    const maxAttempt = 2_147_483_647
    const maxMarker = { ...sourceMarker, owner: { ...owner, executionAttemptCount: maxAttempt } }
    const maxExecution = { ...execution, attemptCount: maxAttempt, state: { scheduledTaskGraphMaterialDriftTerminal: maxMarker } }
    const { db, tx } = recoveryDb({ execution: maxExecution })

    await expect(startMaterialDriftRecovery(db as never, { automationId: "automation_1", userId: "user_1", sessionId: "session_1" }))
      .resolves.toEqual({ kind: "rejected" })
    expect(tx.agentTurn.create).not.toHaveBeenCalled()
    expect(tx.agentExecution.updateMany).not.toHaveBeenCalled()
  })
})
