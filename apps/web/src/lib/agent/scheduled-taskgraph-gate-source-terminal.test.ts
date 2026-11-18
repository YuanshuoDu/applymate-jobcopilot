import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ScheduledTaskGraphPipelineOwner } from "./scheduled-taskgraph-pipeline-checkpoint"
import { createAnalyzeSourceChangedErrorWithClaims, AnalyzeSourceChangedError } from "./stages/analyze-model-input"
import { isScheduledTaskGraphSourceChangeTerminal } from "./scheduled-taskgraph-source-change-terminal"
import { createScheduledTaskGraphGateMaterialDriftError } from "./scheduled-taskgraph-gate-material-drift"
import { AgentExecutionCancelledError } from "./execution-control"
import { respondToScheduledTaskGraphGateActionFailure, respondToScheduledTaskGraphGateSourceChange, respondToScheduledTaskGraphGateSourceFailure,
  terminalizeScheduledTaskGraphGateSourceChange } from "./scheduled-taskgraph-gate-source-terminal"

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(), queryRaw: vi.fn(), updateExecution: vi.fn(), updateTasks: vi.fn(), acquireFence: vi.fn(),
  assertSources: vi.fn(), turnCurrent: vi.fn(), rootAction: vi.fn(), rootWaitMatches: vi.fn(), gateLeaseCurrent: vi.fn(),
  gateProofCurrent: vi.fn(), prepareWaitId: vi.fn(), validateAuditPrepare: vi.fn(), validatePrepare: vi.fn(), gateHistory: vi.fn(),
  inspectGateInput: vi.fn(), persistMaterial: vi.fn(),
  sameOwner: (left: unknown, right: Record<string, unknown>) => Boolean(left && typeof left === "object"
    && ["userId", "sessionId", "turnId", "rootTaskId", "rootAttemptCount", "turnLeaseOwnerId", "turnLeaseVersion", "executionId", "executionAttemptCount"]
      .every(key => (left as Record<string, unknown>)[key] === right[key])),
  sameStableOwner: (left: unknown, right: Record<string, unknown>) => Boolean(left && typeof left === "object"
    && ["userId", "sessionId", "turnId", "rootTaskId", "rootAttemptCount", "executionId", "executionAttemptCount"]
      .every(key => (left as Record<string, unknown>)[key] === right[key])),
  order: [] as string[],
}))

vi.mock("@/lib/db", () => ({ db: { $transaction: mocks.transaction } }))
vi.mock("./scheduled-taskgraph-pipeline-request", () => ({
  blocked: (status: number, errorCode: string) => Response.json({ status: "blocked", errorCode }, { status }),
  gateFailureDiagnostic: (phase: string, error: unknown) => ({ phase, errorClass: error instanceof Error ? "error" : "non_error" }),
  matchingTurnSnapshot: (input: unknown) => (input as { snapshot?: unknown })?.snapshot ?? null,
  scheduledTaskGraphClaimIsValid: (claim: Record<string, unknown> | null, owner: Record<string, unknown>, key: string, token: unknown) =>
    Boolean(claim && claim.key === key && claim.claimToken === token && mocks.sameOwner(claim.owner, owner)),
  scheduledTaskGraphLineageOwnerIsSame: (value: unknown, owner: Record<string, unknown>) => mocks.sameStableOwner(value, owner),
}))
vi.mock("./scheduled-taskgraph-pipeline-checkpoint", () => ({
  scheduledAutomationSnapshotDigest: () => `sha256:${"b".repeat(64)}`,
  scheduledTaskGraphContinuationKey: () => `scheduled-taskgraph:v2:sha256:${"a".repeat(64)}`,
}))
vi.mock("./scheduled-automation-snapshot", () => ({ parseScheduledAutomationSnapshot: (value: unknown) => value }))
vi.mock("./scheduled-taskgraph-gate-input", () => ({ isScheduledTaskGraphGateProofCurrent: (...args: unknown[]) => mocks.gateProofCurrent(...args),
  inspectScheduledTaskGraphGateInput: (...args: unknown[]) => mocks.inspectGateInput(...args) }))
vi.mock("./scheduled-taskgraph-gate-material-drift", () => ({
  createScheduledTaskGraphGateMaterialDriftError: (input: Record<string, unknown>) => {
    const evidence = input.evidence as Record<string, unknown>
    const error = new Error("scheduled_prepare_material_source_changed") as Error & { proof?: Record<string, unknown> }
    error.name = "ScheduledPrepareMaterialDriftError"
    error.proof = { owner: input.owner, gate: input.gate, snapshotDigest: input.snapshotDigest,
      artifactDigest: evidence.artifactDigest, currentMaterialDigest: evidence.currentMaterialDigest,
      proofDigest: `${evidence.artifactDigest}:${evidence.currentMaterialDigest}` }
    return error
  },
  readScheduledTaskGraphGateMaterialDriftProof: (error: unknown) => error instanceof Error
    ? (error as Error & { proof?: Record<string, unknown> }).proof ?? null : null,
  scheduledTaskGraphGateMaterialDriftProofMatches: (expected: Record<string, unknown>, current: Record<string, unknown>) =>
    expected.proofDigest === current.proofDigest && JSON.stringify(expected.owner) === JSON.stringify(current.owner)
      && JSON.stringify(expected.gate) === JSON.stringify(current.gate),
  isScheduledTaskGraphGateMaterialDriftTerminal: () => false,
  persistScheduledTaskGraphGateMaterialDriftTerminal: async (input: Record<string, unknown>) => {
    mocks.persistMaterial(input)
    const owner = input.owner as Record<string, unknown>, state = input.expectedState as Record<string, unknown>
    const saved = await mocks.updateExecution({ where: { id: input.executionId, userId: owner.userId, sessionId: owner.sessionId,
      status: "running", attemptCount: input.executionAttemptCount, state: { equals: state } },
      data: { status: "failed", error: "scheduled_prepare_material_source_changed", state: { ...state,
        scheduledTaskGraphMaterialDriftTerminal: { reason: "scheduled_prepare_material_source_changed", gate: input.gate,
          owner, artifactDigest: (input.proof as Record<string, unknown>).artifactDigest } } } })
    return saved.count === 1 ? "terminalized" : "state_changed"
  },
}))
vi.mock("./scheduled-taskgraph-audit-action", () => ({
  scheduledTaskGraphPrepareWaitId: (...args: unknown[]) => mocks.prepareWaitId(...args),
  validateScheduledTaskGraphAuditPrepareSource: (...args: unknown[]) => mocks.validateAuditPrepare(...args),
}))
vi.mock("./scheduled-taskgraph-run-service", () => ({ validateScheduledPrepareWaitIdentity: (...args: unknown[]) => mocks.validatePrepare(...args) }))
vi.mock("./scheduled-taskgraph-pipeline-fence", () => ({
  scheduledTaskGraphClaimMatches: (state: Record<string, unknown>, key: string, owner: Record<string, unknown>, token: string) => {
    const claim = state.scheduledTaskGraphClaim as Record<string, unknown> | undefined
    return Boolean(claim?.key === key && claim.claimToken === token && mocks.sameOwner(claim.owner, owner))
  },
}))
vi.mock("./scheduled-taskgraph-gate-source", () => ({
  acquireScheduledTaskGraphGateSourceFence: async () => { mocks.order.push("source_fence"); await mocks.acquireFence() },
  assertScheduledTaskGraphGateSourcesCurrent: async () => { mocks.order.push("source_check"); await mocks.assertSources() },
  isScheduledTaskGraphGateSourceChangedError: (error: unknown) => error instanceof Error && error.name === "AnalyzeSourceChangedError",
  isScheduledTaskGraphGateSourceProofInvalidError: () => false,
  scheduledTaskGraphGateRecord: (value: unknown) => value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null,
}))
vi.mock("./scheduled-taskgraph-gate-root-wait", () => ({
  lockScheduledTaskGraphRootAction: async (...args: unknown[]) => { mocks.order.push("root_wait"); return mocks.rootAction(...args) },
  scheduledGateRootWaitWitnessMatches: (...args: unknown[]) => mocks.rootWaitMatches(...args),
  scheduledGateWaitAttemptMatchesCurrentHistory: (...args: unknown[]) => mocks.gateHistory(...args),
}))
vi.mock("./scheduled-taskgraph-gate-rpc", () => ({
  scheduledTaskGraphGateTaskLeaseIsCurrent: (...args: unknown[]) => mocks.gateLeaseCurrent(...args),
  scheduledTaskGraphGateTurnIsCurrent: (...args: unknown[]) => mocks.turnCurrent(...args),
}))

const owner: ScheduledTaskGraphPipelineOwner = {
  userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", rootAttemptCount: 3,
  turnLeaseOwnerId: "analyze-lease", turnLeaseVersion: 7, executionId: "execution-1", executionAttemptCount: 5,
}
const key = `scheduled-taskgraph:v2:sha256:${"a".repeat(64)}`
const claimToken = "claim-1", digest = `sha256:${"b".repeat(64)}`
const analysisFenceAt = "2026-11-01T12:00:00.000Z"
function checkpoint() {
  return {
    nextStage: "gate", analysisFailed: 0, scoutedJobs: [{ id: "job-1" }],
    scoredJobs: [{ job: { id: "job-1", userId: owner.userId }, score: 82, analysisFenceAt }],
    scheduledTaskGraphAnalyzeSourceFingerprints: { "job-1": { version: "agent-harness.v2.analyze-source-input.v1", digest: "c".repeat(64) } },
    scheduledTaskGraphClaim: { schemaVersion: "agent-harness.v2.scheduled-pipeline-claim.v1", key, claimToken, owner,
      claimedAt: analysisFenceAt, leaseExpiresAt: "2026-11-01T12:10:00.000Z" },
    scheduledTaskGraphContinuation: { schemaVersion: "agent-harness.v2.scheduled-pipeline-continuation.v1", key, owner,
      snapshotDigest: digest, graphRevision: 9, evidenceDigest: "d".repeat(64) },
  }
}
function sourceError() { return createAnalyzeSourceChangedErrorWithClaims([{ jobId: "job-1", analysisFenceAt }]) }
const turn = { id: owner.turnId, userId: owner.userId, sessionId: owner.sessionId, rootTaskId: owner.rootTaskId,
  source: "automation", executionMode: "canonical_task_graph", input: { snapshot: {} }, status: "waiting_for_dependency",
  leaseOwnerId: null, leaseVersion: owner.turnLeaseVersion, leaseExpiresAt: null }
const gateTask = { id: "gate-1", sessionId: owner.sessionId, turnId: owner.turnId, rootTaskId: owner.rootTaskId,
  parentTaskId: owner.rootTaskId, depth: 1, role: "prepare", taskType: "scheduled_taskgraph_gate", status: "running",
  attemptCount: 2, leaseOwner: "gate-worker", leaseExpiresAt: new Date(Date.now() + 60_000), interruptRequestedAt: null,
  closedAt: null, expectedOutputSchema: { schemaVersion: "agent-harness.v2.subagent.result", role: "prepare", taskType: "scheduled_taskgraph_gate" },
  allowedActions: [] }
const wait = { waitId: "wait-1", stepId: "step-1", requestAttemptCount: 0, approvalIds: [], gateTaskId: "gate-1",
  owner: { userId: owner.userId, sessionId: owner.sessionId, turnId: owner.turnId, rootTaskId: owner.rootTaskId,
    rootAttemptCount: owner.rootAttemptCount, turnLeaseOwnerId: owner.turnLeaseOwnerId, turnLeaseVersion: owner.turnLeaseVersion },
  turn: { id: owner.turnId, status: turn.status, leaseOwnerId: null, leaseVersion: owner.turnLeaseVersion, leaseExpiresAt: null },
  root: { id: owner.rootTaskId, status: "waiting", attemptCount: owner.rootAttemptCount, waitId: "wait-1" } }
const gateRootWait = { root: { id: owner.rootTaskId, status: "waiting", attemptCount: owner.rootAttemptCount,
  interruptRequestedAt: null, closedAt: null, result: { status: "waiting_for_dependency", waitId: "wait-1", stepCount: 0, toolCallCount: 0, finalItemId: null } }, gateWait: wait }

function request(overrides: Record<string, unknown> = {}) {
  return { owner, key, claimToken, attestationSnapshotDigest: digest, attestation: { proof: true }, prepareProof: { proof: true },
    gate: { taskId: "gate-1", leaseOwnerId: "gate-worker", attemptCount: 2 }, sourceChangeError: sourceError(), ...overrides }
}
function rowQuery(query: unknown): string { return (query as { sql?: string })?.sql ?? "" }
function setup(state = checkpoint()) {
  const execution = { id: owner.executionId, status: "running", attemptCount: owner.executionAttemptCount, state, error: null }
  mocks.order.length = 0
  mocks.transaction.mockImplementation(async (work: (tx: unknown) => Promise<unknown>) => work({
    $queryRaw: mocks.queryRaw,
    agentExecution: { updateMany: mocks.updateExecution },
    applicationTask: { updateMany: mocks.updateTasks },
  }))
  mocks.queryRaw.mockImplementation(async (query: unknown) => {
    const sql = rowQuery(query)
    mocks.order.push(sql.match(/FROM "([^"]+)"/)?.[1] ?? "query")
    if (sql.includes('FROM "agent_sessions"')) return [{ id: owner.sessionId, status: "active" }]
    if (sql.includes('FROM "agent_turns"')) return [turn]
    if (sql.includes('FROM "sub_agent_tasks"')) return [gateTask]
    if (sql.includes('FROM "agent_executions"')) return [execution]
    return []
  })
  mocks.updateExecution.mockResolvedValue({ count: 1 })
  mocks.updateTasks.mockResolvedValue({ count: 1 })
  mocks.acquireFence.mockResolvedValue(undefined)
  mocks.assertSources.mockRejectedValue(new AnalyzeSourceChangedError())
  mocks.turnCurrent.mockReturnValue(true)
  mocks.rootAction.mockResolvedValue(gateRootWait)
  mocks.rootWaitMatches.mockReturnValue(true)
  mocks.gateLeaseCurrent.mockReturnValue(true)
    mocks.gateProofCurrent.mockResolvedValue(true)
    mocks.prepareWaitId.mockReturnValue(undefined)
    mocks.validateAuditPrepare.mockResolvedValue(true)
    mocks.validatePrepare.mockResolvedValue(true)
    mocks.gateHistory.mockResolvedValue(true)
}

describe("scheduled TaskGraph Gate source-change terminalization", () => {
  beforeEach(() => {
    [mocks.transaction, mocks.queryRaw, mocks.updateExecution, mocks.updateTasks, mocks.acquireFence, mocks.assertSources,
      mocks.turnCurrent, mocks.rootAction, mocks.rootWaitMatches, mocks.gateLeaseCurrent, mocks.gateProofCurrent,
      mocks.prepareWaitId, mocks.validateAuditPrepare, mocks.validatePrepare, mocks.gateHistory, mocks.inspectGateInput,
      mocks.persistMaterial].forEach(mock => mock.mockReset())
    setup()
  })

  it("rechecks drift and tombstones only the exact parked Gate child in a source-fence-first transaction", async () => {
    const state = checkpoint()
    setup(state)
    const result = await terminalizeScheduledTaskGraphGateSourceChange(request())

    expect(result).toBe("terminalized")
    expect(mocks.order).toEqual(["source_fence", "agent_sessions", "agent_turns", "root_wait", "sub_agent_tasks", "agent_executions", "source_check"])
    expect(mocks.rootWaitMatches).toHaveBeenCalledWith(expect.objectContaining({ owner, gateTaskId: "gate-1" }))
    expect(mocks.gateLeaseCurrent).toHaveBeenCalledWith(gateTask, expect.objectContaining({ taskId: "gate-1", leaseOwnerId: "gate-worker", attemptCount: 2 }))
    expect(mocks.updateExecution).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: owner.executionId, userId: owner.userId, sessionId: owner.sessionId, status: "running",
        attemptCount: owner.executionAttemptCount, state: { equals: state } },
      data: expect.objectContaining({ status: "failed", error: "scheduled_pipeline_source_changed",
        state: expect.objectContaining({ scheduledTaskGraphSourceChangeTerminal: expect.objectContaining({
          owner: expect.objectContaining({ executionId: owner.executionId, executionAttemptCount: owner.executionAttemptCount }),
        }) }) }),
    }))
    const savedState = mocks.updateExecution.mock.calls[0]?.[0]?.data?.state as Record<string, unknown>
    expect(isScheduledTaskGraphSourceChangeTerminal({ owner, status: "failed", error: "scheduled_pipeline_source_changed", state: savedState })).toBe(true)
    expect(mocks.updateTasks).toHaveBeenCalledOnce()
  })

  it("does not terminalize when the Gate lease or parked Root wait witness changed", async () => {
    setup()
    mocks.gateLeaseCurrent.mockReturnValue(false)
    await expect(terminalizeScheduledTaskGraphGateSourceChange(request())).resolves.toBe("gate_task_changed")
    expect(mocks.updateExecution).not.toHaveBeenCalled()

    setup()
    mocks.rootWaitMatches.mockReturnValue(false)
    await expect(terminalizeScheduledTaskGraphGateSourceChange(request())).resolves.toBe("owner_changed")
    expect(mocks.updateExecution).not.toHaveBeenCalled()

    const evidence = { artifactDigest: `sha256:${"e".repeat(64)}`, currentMaterialDigest: `sha256:${"f".repeat(64)}` }
    const materialError = createScheduledTaskGraphGateMaterialDriftError({ owner, gate: request().gate,
      snapshotDigest: digest, analyzeCheckpoint: checkpoint(), prepareProof: request().prepareProof, evidence })
    setup()
    mocks.gateLeaseCurrent.mockReturnValue(false)
    await expect(terminalizeScheduledTaskGraphGateSourceChange(request({ sourceChangeError: materialError })))
      .resolves.toBe("gate_task_changed")
    expect(mocks.persistMaterial).not.toHaveBeenCalled()

    setup()
    mocks.rootWaitMatches.mockReturnValue(false)
    await expect(terminalizeScheduledTaskGraphGateSourceChange(request({ sourceChangeError: materialError })))
      .resolves.toBe("owner_changed")
    expect(mocks.persistMaterial).not.toHaveBeenCalled()
  })

  it("refuses missing server-only claims and returns retryable when sources are current again", async () => {
    setup()
    const response = await respondToScheduledTaskGraphGateSourceChange(request({ sourceChangeError: new AnalyzeSourceChangedError() }))
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ status: "blocked", errorCode: "scheduled_pipeline_claim_conflict" })
    expect(mocks.transaction).not.toHaveBeenCalled()

    setup()
    mocks.assertSources.mockResolvedValue(undefined)
    const recovered = await respondToScheduledTaskGraphGateSourceChange(request())
    expect(recovered.status).toBe(503)
    expect(await recovered.json()).toEqual({ status: "blocked", errorCode: "scheduled_pipeline_handoff_retryable" })
    expect(mocks.updateExecution).not.toHaveBeenCalled()
  })

  it("does not clean Analyze tasks when the exact execution state CAS loses", async () => {
    setup()
    mocks.updateExecution.mockResolvedValue({ count: 0 })
    await expect(terminalizeScheduledTaskGraphGateSourceChange(request())).resolves.toBe("state_changed")
    expect(mocks.updateTasks).not.toHaveBeenCalled()
  })

  it("terminalizes only a re-confirmed material-only drift after Analyze remains current", async () => {
    const state = checkpoint(), gate = { taskId: "gate-1", leaseOwnerId: "gate-worker", attemptCount: 2 }
    const evidence = { artifactDigest: `sha256:${"e".repeat(64)}`, currentMaterialDigest: `sha256:${"f".repeat(64)}` }
    const error = new Error("scheduled_prepare_material_source_changed") as Error & { proof?: Record<string, unknown> }
    error.name = "ScheduledPrepareMaterialDriftError"
    error.proof = { owner, gate, snapshotDigest: digest, ...evidence, proofDigest: `${evidence.artifactDigest}:${evidence.currentMaterialDigest}` }
    setup(state)
    mocks.assertSources.mockResolvedValue(undefined)
    mocks.inspectGateInput.mockImplementation(async () => { mocks.order.push("material_recheck"); return { kind: "material_source_drift", evidence } })
    await expect(terminalizeScheduledTaskGraphGateSourceChange(request({ sourceChangeError: error }))).resolves.toBe("terminalized")
    expect(mocks.order).toEqual(["source_fence", "agent_sessions", "agent_turns", "root_wait", "sub_agent_tasks", "agent_executions", "source_check", "material_recheck"])
    expect(mocks.inspectGateInput).toHaveBeenCalledWith(expect.objectContaining({ owner, gate: expect.objectContaining({ taskId: gate.taskId }) }), expect.anything())
    expect(mocks.persistMaterial).toHaveBeenCalledOnce()
    expect(mocks.updateTasks).not.toHaveBeenCalled()

    setup(state)
    mocks.inspectGateInput.mockClear()
    mocks.persistMaterial.mockClear()
    mocks.assertSources.mockRejectedValue(new AnalyzeSourceChangedError())
    await expect(terminalizeScheduledTaskGraphGateSourceChange(request({ sourceChangeError: error }))).resolves.toBe("source_current")
    expect(mocks.inspectGateInput).not.toHaveBeenCalled()
    expect(mocks.persistMaterial).not.toHaveBeenCalled()
  })

  it("does not terminalize material drift if the source was restored or the material proof changed", async () => {
    const state = checkpoint(), evidence = { artifactDigest: `sha256:${"e".repeat(64)}`, currentMaterialDigest: `sha256:${"f".repeat(64)}` }
    const error = new Error("scheduled_prepare_material_source_changed") as Error & { proof?: Record<string, unknown> }
    error.name = "ScheduledPrepareMaterialDriftError"
    error.proof = { owner, gate: request().gate, snapshotDigest: digest, ...evidence, proofDigest: `${evidence.artifactDigest}:${evidence.currentMaterialDigest}` }
    setup(state)
    mocks.assertSources.mockResolvedValue(undefined)
    mocks.inspectGateInput.mockResolvedValue({ kind: "valid", input: {} })
    await expect(terminalizeScheduledTaskGraphGateSourceChange(request({ sourceChangeError: error }))).resolves.toBe("source_current")
    expect(mocks.updateExecution).not.toHaveBeenCalled()

    setup(state)
    mocks.assertSources.mockResolvedValue(undefined)
    mocks.inspectGateInput.mockResolvedValue({ kind: "material_source_drift", evidence: { ...evidence,
      currentMaterialDigest: `sha256:${"9".repeat(64)}` } })
    await expect(terminalizeScheduledTaskGraphGateSourceChange(request({ sourceChangeError: error }))).resolves.toBe("not_confirmed")
    expect(mocks.updateExecution).not.toHaveBeenCalled()
  })

  it("does not accept a caller-created material error without the opaque server proof", async () => {
    const unbranded = new Error("scheduled_prepare_material_source_changed")
    await expect(terminalizeScheduledTaskGraphGateSourceChange(request({ sourceChangeError: unbranded })))
      .resolves.toBe("not_confirmed")
    expect(mocks.transaction).not.toHaveBeenCalled()
  })

  it("maps a committed material drift to the fixed public reason without exposing proof details", async () => {
    const state = checkpoint(), evidence = { artifactDigest: `sha256:${"e".repeat(64)}`, currentMaterialDigest: `sha256:${"f".repeat(64)}` }
    const error = createScheduledTaskGraphGateMaterialDriftError({ owner, gate: request().gate, snapshotDigest: digest,
      analyzeCheckpoint: state, prepareProof: request().prepareProof, evidence })
    setup(state)
    mocks.assertSources.mockResolvedValue(undefined)
    mocks.inspectGateInput.mockResolvedValue({ kind: "material_source_drift", evidence })
    const response = await respondToScheduledTaskGraphGateActionFailure({ error, request: { attestation: {}, prepareProof: {},
      gateTaskId: "gate-1", gateLeaseOwnerId: "gate-worker", gateAttemptCount: 2 },
      locked: { owner, key, claimToken, snapshot: {} }, phase: "owner_assertion" })
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ status: "blocked", errorCode: "scheduled_prepare_material_source_changed" })
    expect(mocks.persistMaterial).toHaveBeenCalledOnce()
    expect(mocks.updateTasks).not.toHaveBeenCalled()
  })

  it("revalidates Gate proof, Prepare wait and resumed Gate history before source terminalization", async () => {
    setup()
    mocks.gateProofCurrent.mockResolvedValue(false)
    await expect(terminalizeScheduledTaskGraphGateSourceChange(request())).resolves.toBe("not_confirmed")
    expect(mocks.updateExecution).not.toHaveBeenCalled()
    expect(mocks.assertSources).not.toHaveBeenCalled()

    setup()
    mocks.prepareWaitId.mockReturnValue(null)
    await expect(terminalizeScheduledTaskGraphGateSourceChange(request())).resolves.toBe("not_confirmed")
    expect(mocks.updateExecution).not.toHaveBeenCalled()
  })

  it("only adapts recognized source failures and refuses to report drift without a locked checkpoint", async () => {
    const requestFields = { attestation: {}, prepareProof: {}, gateTaskId: "gate-1", gateLeaseOwnerId: "gate-worker", gateAttemptCount: 2 }
    await expect(respondToScheduledTaskGraphGateSourceFailure({ error: new Error("ordinary failure"), request: requestFields }))
      .resolves.toBeNull()
    const missingOwner = await respondToScheduledTaskGraphGateSourceFailure({ error: sourceError(), request: requestFields })
    expect(missingOwner?.status).toBe(409)
    expect(await missingOwner?.json()).toEqual({ status: "blocked", errorCode: "scheduled_pipeline_turn_stale" })
    expect(mocks.transaction).not.toHaveBeenCalled()

    setup()
    const response = await respondToScheduledTaskGraphGateSourceFailure({ error: sourceError(), request: requestFields,
      locked: { owner, key, claimToken, snapshot: {} } })
    expect(response?.status).toBe(409)
    expect(await response?.json()).toEqual({ status: "blocked", errorCode: "scheduled_pipeline_source_changed" })
    expect(mocks.updateExecution).toHaveBeenCalledOnce()
  })

  it("preserves owner-assertion exceptions and maps final Gate failures without disguising their class", async () => {
    const databaseError = new Error("private database detail"), requestFields = {
      attestation: {}, prepareProof: {}, gateTaskId: "gate-1", gateLeaseOwnerId: "gate-worker", gateAttemptCount: 2,
    }
    await expect(respondToScheduledTaskGraphGateActionFailure({ error: databaseError, request: requestFields,
      phase: "owner_assertion", rethrowUnknown: true })).rejects.toBe(databaseError)

    const failed = await respondToScheduledTaskGraphGateActionFailure({ error: databaseError, request: requestFields,
      locked: { owner, key, claimToken, snapshot: {} }, phase: "gate_execution" })
    expect(failed.status).toBe(500)
    expect(await failed.json()).toEqual({ status: "blocked", errorCode: "scheduled_pipeline_execution_failed" })

    const cancelled = await respondToScheduledTaskGraphGateActionFailure({ error: new AgentExecutionCancelledError(),
      request: requestFields, locked: { owner, key, claimToken, snapshot: {} }, phase: "gate_execution" })
    expect(cancelled.status).toBe(409)
    expect(await cancelled.json()).toEqual({ status: "blocked", errorCode: "scheduled_pipeline_turn_stale" })
  })
})
