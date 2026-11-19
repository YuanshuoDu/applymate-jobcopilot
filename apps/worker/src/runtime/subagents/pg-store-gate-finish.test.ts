import { describe, expect, it, vi } from "vitest"
import { hashArtifactContent } from "./artifact-adapters.js"
import { scheduledGateRegistrationReceiptKey } from "./scheduled-gate-registration-receipt.js"
import { scheduledTaskGraphStableContinuationKey } from "./scheduled-taskgraph-continuation-receipt.js"
import { lockScheduledGateFinish } from "./pg-store-gate-finish.js"

const failureReason = "scheduled_prepare_material_source_changed"
const handoffKey = `scheduled-taskgraph:sha256:${"a".repeat(64)}`
const registeredOwner = { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1",
  rootAttemptCount: 1, executionId: "execution-1", executionAttemptCount: 0 }
const owner = { ...registeredOwner, turnLeaseOwnerId: "turn-worker-1", turnLeaseVersion: 5 }
const gate = { taskId: "gate-1", leaseOwnerId: "worker-1", attemptCount: 1 }
const snapshotDigest = `sha256:${"b".repeat(64)}`, evidenceDigest = "c".repeat(64), checkpointDigest = "d".repeat(64)
const analyzeGraphRevision = 10, prepareScheduleRevision = 11
const continuationKey = scheduledTaskGraphStableContinuationKey({ owner, continuationKey: handoffKey, snapshotDigest,
  evidenceDigest, checkpointDigest, analyzeGraphRevision, prepareScheduleRevision })!
const receipt = { schemaVersion: "agent-harness.v2.scheduled-taskgraph-gate-binding.v1", owner: registeredOwner, continuationKey,
  snapshotDigest, evidenceDigest, checkpointDigest, analyzeGraphRevision, prepareScheduleRevision,
  prepareWaitId: "prepare-wait", gateTaskId: gate.taskId, gateAppendRevision: 12 }
const continuation = { schemaVersion: "agent-harness.v2.scheduled-pipeline-continuation.v1", key: handoffKey,
  owner, snapshotDigest: receipt.snapshotDigest, graphRevision: receipt.analyzeGraphRevision, evidenceDigest: receipt.evidenceDigest }

function terminalState(overrides: Readonly<{ owner?: Record<string, unknown>; gate?: Record<string, unknown>; proofDigest?: string; sourceTerminal?: unknown }> = {}) {
  const terminalOwner = overrides.owner ?? owner, terminalGate = overrides.gate ?? gate
  const proof = { schemaVersion: "agent-harness.v2.scheduled-prepare-material-drift-proof.v1", owner: terminalOwner,
    gate: terminalGate, snapshotDigest: receipt.snapshotDigest, analyzeFingerprintDigest: `sha256:${"e".repeat(64)}`,
    prepareProofDigest: `sha256:${"f".repeat(64)}`, artifactDigest: `sha256:${"1".repeat(64)}`,
    currentMaterialDigest: `sha256:${"2".repeat(64)}` }
  const marker = { schemaVersion: "agent-harness.v2.scheduled-prepare-material-drift-terminal.v1",
    reason: failureReason, owner: terminalOwner, gate: terminalGate, analyzeFingerprintDigest: proof.analyzeFingerprintDigest,
    prepareProofDigest: proof.prepareProofDigest, artifactDigest: proof.artifactDigest,
    currentMaterialDigest: proof.currentMaterialDigest, proofDigest: overrides.proofDigest ?? hashArtifactContent(proof) }
  return { scheduledTaskGraphContinuation: continuation,
    scheduledTaskGraphMaterialDriftTerminal: marker,
    ...(overrides.sourceTerminal === undefined ? {} : { scheduledTaskGraphSourceChangeTerminal: overrides.sourceTerminal }) }
}

function database(overrides: Readonly<{
  turn?: Record<string, unknown>; root?: Record<string, unknown>; gateAvailable?: boolean;
  execution?: Record<string, unknown>; registeredReceipt?: unknown
}> = {}) {
  const calls: string[] = []
  const client = { query: vi.fn(async (sql: string) => {
    calls.push(sql)
    if (sql.includes('FROM "agent_turns"')) return { rows: [overrides.turn ?? { id: "turn-1", rootTaskId: "root-1",
      status: "in_progress", leaseOwnerId: owner.turnLeaseOwnerId, leaseVersion: owner.turnLeaseVersion,
      leaseExpiresAt: new Date(Date.now() + 60_000), leaseLive: true }], rowCount: 1 }
    if (sql.includes('"parentTaskId" IS NULL')) return { rows: [overrides.root ?? { id: "root-1", status: "running",
      attemptCount: 1, interruptRequestedAt: null, closedAt: null }], rowCount: 1 }
    if (sql.includes('"taskType" = $6')) return { rows: overrides.gateAvailable === false ? [] : [{ id: gate.taskId }], rowCount: overrides.gateAvailable === false ? 0 : 1 }
    if (sql.includes('SELECT "payload" FROM "agent_events"')) return { rows: [{ payload: receipt }], rowCount: 1 }
    if (sql.includes('SELECT event."itemId"')) return { rows: [{ itemId: null, taskId: null, actor: "system",
      idempotencyKey: scheduledGateRegistrationReceiptKey(continuationKey, gate.taskId), payload: overrides.registeredReceipt ?? receipt, hasOutbox: false }], rowCount: 1 }
    if (sql.includes('FROM "agent_executions"')) return { rows: [overrides.execution ?? { id: registeredOwner.executionId,
      status: "running", error: null, state: {}, attemptCount: registeredOwner.executionAttemptCount }], rowCount: 1 }
    return { rows: [], rowCount: 0 }
  }) }
  return { calls, client }
}

const task = { userId: "user-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1", role: "prepare" }
const normalInput = { taskId: gate.taskId, sessionId: "session-1", ownerId: gate.leaseOwnerId, attemptCount: gate.attemptCount }
const materialInput = { ...normalInput, status: "failed", failureReason, retryDisposition: "terminal" }

describe("lockScheduledGateFinish", () => {
  it("rejects a non-child Gate before issuing queries", async () => {
    const { calls, client } = database()
    await expect(lockScheduledGateFinish(client as never, { ...task, parentTaskId: null }, normalInput)).resolves.toBe(false)
    expect(calls).toHaveLength(0)
  })

  it("locks and validates the registered Gate with a database-clock deadline fence", async () => {
    const { calls, client } = database()
    await expect(lockScheduledGateFinish(client as never, task, normalInput)).resolves.toBe(true)
    const query = calls.find(sql => sql.includes('"taskType" = $6')) ?? ""
    expect(query).toContain('"absoluteDeadlineAt" IS NULL OR "absoluteDeadlineAt" > clock_timestamp()')
    expect(query).toContain('"leaseExpiresAt" > clock_timestamp()')
    expect(query).toContain('"closedAt" IS NULL')
  })

  it("accepts only the exact trusted material-drift marker after its execution was terminalized", async () => {
    const { calls, client } = database({ execution: { id: registeredOwner.executionId, status: "failed", error: failureReason,
      state: terminalState(), attemptCount: registeredOwner.executionAttemptCount } })
    await expect(lockScheduledGateFinish(client as never, task, materialInput)).resolves.toBe(true)
    expect(calls.some(sql => sql.includes('FROM "agent_executions"') && sql.includes('"status" = \'running\''))).toBe(false)
  })

  it.each([
    ["missing marker", {}],
    ["Analyze source terminal marker", { state: { ...terminalState(), scheduledTaskGraphSourceChangeTerminal: { reason: "scheduled_pipeline_source_changed" } } }],
    ["bad proof digest", { state: terminalState({ proofDigest: `sha256:${"9".repeat(64)}` }) }],
    ["foreign owner", { state: terminalState({ owner: { ...owner, userId: "foreign-user" } }) }],
    ["foreign Gate lease", { state: terminalState({ gate: { ...gate, leaseOwnerId: "other-worker" } }) }],
    ["wrong execution reason", { error: "scheduled_pipeline_source_changed", state: terminalState() }],
    ["wrong execution attempt", { attemptCount: 1, state: terminalState() }],
  ] as const)("rejects %s", async (_label, executionOverrides) => {
    const { client } = database({ execution: { id: registeredOwner.executionId, status: "failed", error: failureReason,
      state: {}, attemptCount: registeredOwner.executionAttemptCount, ...executionOverrides } })
    await expect(lockScheduledGateFinish(client as never, task, materialInput)).resolves.toBe(false)
  })

  it.each([
    ["interrupted Turn", { turn: { id: "turn-1", rootTaskId: "root-1", status: "interrupted", leaseOwnerId: null,
      leaseVersion: owner.turnLeaseVersion, leaseExpiresAt: null, leaseLive: false } }],
    ["changed Turn lease owner", { turn: { id: "turn-1", rootTaskId: "root-1", status: "in_progress", leaseOwnerId: "new-owner",
      leaseVersion: owner.turnLeaseVersion + 1, leaseExpiresAt: new Date(Date.now() + 60_000), leaseLive: true } }],
    ["interrupted Root", { root: { id: "root-1", status: "interrupted", attemptCount: 1,
      interruptRequestedAt: new Date(), closedAt: null } }],
    ["changed Root attempt", { root: { id: "root-1", status: "running", attemptCount: 2,
      interruptRequestedAt: null, closedAt: null } }],
    ["expired or replaced Gate lease", { gateAvailable: false }],
  ] as const)("rejects %s", async (_label, overrides) => {
    const { client } = database({ execution: { id: registeredOwner.executionId, status: "failed", error: failureReason,
      state: terminalState(), attemptCount: registeredOwner.executionAttemptCount }, ...overrides })
    await expect(lockScheduledGateFinish(client as never, task, materialInput)).resolves.toBe(false)
  })

  it("does not accept a failed execution for any other Gate failure", async () => {
    const { client } = database({ execution: { id: registeredOwner.executionId, status: "failed",
      error: "scheduled_pipeline_source_changed", state: terminalState(), attemptCount: registeredOwner.executionAttemptCount } })
    await expect(lockScheduledGateFinish(client as never, task, { ...normalInput, status: "failed",
      failureReason: "scheduled_pipeline_source_changed", retryDisposition: "terminal" })).resolves.toBe(false)
  })

  it("rejects a material-drift reason unless the worker is finishing a terminal failure", async () => {
    const { calls, client } = database()
    await expect(lockScheduledGateFinish(client as never, task, { ...normalInput, status: "completed", failureReason }))
      .resolves.toBe(false)
    expect(calls).toHaveLength(0)
  })
})
