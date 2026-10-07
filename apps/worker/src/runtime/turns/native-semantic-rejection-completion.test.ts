import { beforeEach, describe, expect, it, vi } from "vitest"

const readers = vi.hoisted(() => ({
  graph: vi.fn(), state: vi.fn(), controls: vi.fn(), proof: vi.fn(),
}))
vi.mock("../subagents/task-graph-pg-state.js", () => ({ loadTaskGraph: readers.graph }))
vi.mock("../subagents/native-verification-pg-bindings.js", () => ({ loadNativeVerificationOwnedState: readers.state }))
vi.mock("../subagents/native-verification-pg-request.js", () => ({ readNativeVerificationControlTasks: readers.controls }))
vi.mock("../subagents/native-verification-pg-readback.js", () => ({ readNativeVerificationFailedRootRejectionWithClient: readers.proof }))

import { completeNativeSemanticRejectionStepWithClient } from "./native-semantic-rejection-completion.js"
import type { TurnEngineQueryClient } from "./turn-engine-owner-sql.js"
import type { TurnExecutionOwnerFence } from "../execution-owner.js"

const owner: TurnExecutionOwnerFence = { kind: "turn", userId: "u", sessionId: "s", turnId: "t", taskId: "root", rootTaskId: "root",
  ownerId: "lease", leaseVersion: 2, leaseExpiresAt: new Date("2030-01-01T00:00:00Z") }
const identity = { candidateDigest: "a".repeat(64), controlTaskId: "control", controlOperationId: "operation", controlAttempt: 2, controlReportDigest: "b".repeat(64) }
const input = { owner, stepId: "step-4", finishReason: "stop", errorCode: null, inputTokens: 12, outputTokens: 7,
  estimatedCostUsd: 0.00012345, now: new Date("2026-10-07T00:00:00Z"), identity }
const packetText = "Whole final candidate\n"

function client(options: {
  stepStatus?: string; probeStatus?: string; stepTaskId?: string; stepAttempt?: number; checkpoint?: string
  stepInputTokens?: number; stepOutputTokens?: number; stepCost?: string; receipt?: Record<string, unknown> | null
  insertRows?: number; history?: string[]; rootOwned?: boolean; rootAttempt?: number; sessionOpen?: boolean
  turnOwned?: boolean; workAdmitted?: boolean; mode?: string; costMatches?: boolean
} = {}) {
  const calls: { sql: string; values?: readonly unknown[] }[] = []
  const query = vi.fn(async (sql: string, values?: readonly unknown[]) => {
    calls.push({ sql, values })
    if (sql.includes('FROM "agent_sessions"')) {
      const admitted = sql.includes("pause_request") ? options.workAdmitted !== false : options.sessionOpen !== false
      return { rows: admitted ? [{ id: "s" }] : [], rowCount: admitted ? 1 : 0 }
    }
    if (sql.startsWith('SELECT turn."id"')) return { rows: options.turnOwned === false ? [] : [{ id: "t" }], rowCount: options.turnOwned === false ? 0 : 1 }
    if (sql.includes("to_jsonb(turn)")) return { rows: [{ mode: options.mode ?? "durable_v1" }], rowCount: 1 }
    if (sql.includes('FROM "sub_agent_tasks" AS task')) {
      return { rows: options.rootOwned === false ? [] : [{ attemptCount: options.rootAttempt ?? 1, status: "running" }], rowCount: options.rootOwned === false ? 0 : 1 }
    }
    if (sql.includes('FROM "agent_steps"')) {
      const locked = sql.includes('"inputTokens"'), status = locked ? options.stepStatus ?? "streaming" : options.probeStatus ?? options.stepStatus ?? "streaming"
      const completed = status === "completed"
      return { rows: [{ id: "step-4", taskId: options.stepTaskId ?? "root", attempt: options.stepAttempt ?? 1, status,
        finishReason: completed ? input.finishReason : null, errorCode: null,
        inputTokens: completed ? options.stepInputTokens ?? input.inputTokens : 0,
        outputTokens: completed ? options.stepOutputTokens ?? input.outputTokens : 0,
        estimatedCostUsd: completed ? options.stepCost ?? "0.00012345" : "0", inputThroughSequence: options.checkpoint ?? "8" }], rowCount: 1 }
    }
    if (sql.includes("numeric(12,8)")) return { rows: [{ same: options.costMatches !== false }], rowCount: 1 }
    if (sql.startsWith('UPDATE "agent_steps"')) return { rows: [], rowCount: 1 }
    if (sql.includes('FROM "agent_native_semantic_rejections" AS rejection')) return { rows: (options.history ?? ["step-4"]).map(stepId => ({ stepId })), rowCount: options.history?.length ?? 1 }
    if (sql.startsWith('SELECT * FROM "agent_native_semantic_rejections"')) return { rows: options.receipt ? [options.receipt] : [], rowCount: options.receipt ? 1 : 0 }
    if (sql.startsWith('INSERT INTO "agent_native_semantic_rejections"')) return { rows: [], rowCount: options.insertRows ?? 1 }
    throw new Error(`unexpected SQL ${sql.slice(0, 70)}`)
  })
  return { calls, client: { query } as unknown as TurnEngineQueryClient }
}

const receipt = { userId: "u", sessionId: "s", turnId: "t", rootTaskId: "root", stepId: "step-4", attempt: 1,
  inputThroughSequence: "8", candidateDigest: identity.candidateDigest, controlTaskId: identity.controlTaskId,
  controlOperationId: identity.controlOperationId, controlAttempt: identity.controlAttempt, controlReportDigest: identity.controlReportDigest }

beforeEach(() => {
  vi.clearAllMocks()
  readers.graph.mockResolvedValue({ rootTaskId: "root", snapshot: { nodes: [] }, state: {}, tasks: new Map() })
  readers.state.mockResolvedValue({ criteriaValid: true, goal: "Goal", turnGoalConflict: false, nativeSourcesValid: true })
  readers.controls.mockResolvedValue([{ taskId: identity.controlTaskId, packet: { target: { kind: "root_goal", candidateText: packetText } } }])
  readers.proof.mockResolvedValue(identity)
})

describe("atomic native semantic rejection completion", () => {
  it("revalidates the persisted candidate proof before atomically completing the Step and writing its private receipt", async () => {
    const mock = client()
    await expect(completeNativeSemanticRejectionStepWithClient(mock.client, input)).resolves.toEqual({ inputThroughSequence: 8n, distinctStepCount: 1 })
    expect(readers.proof).toHaveBeenCalledWith(mock.client, expect.objectContaining({
      candidateText: packetText, controlTaskId: identity.controlTaskId, stepId: input.stepId,
    }))
    expect(readers.graph).toHaveBeenCalledWith(mock.client, expect.objectContaining({ userId: "u", sessionId: "s", turnId: "t",
      rootTaskId: "root", parentTaskId: "root", turnLeaseOwner: "lease", turnLeaseVersion: 2,
      parentLeaseOwner: "lease", parentAttemptCount: 1 }), true)
    const updateIndex = mock.calls.findIndex(call => call.sql.startsWith('UPDATE "agent_steps"'))
    const insertIndex = mock.calls.findIndex(call => call.sql.startsWith('INSERT INTO "agent_native_semantic_rejections"'))
    expect(updateIndex).toBeGreaterThanOrEqual(0)
    expect(insertIndex).toBeGreaterThan(updateIndex)
    expect(mock.calls[insertIndex]?.values).toEqual(["u", "s", "t", "root", "step-4", "8", identity.candidateDigest,
      identity.controlTaskId, identity.controlOperationId, identity.controlAttempt, identity.controlReportDigest, input.now])
  })

  it.each([
    ["changed report digest", { ...identity, controlReportDigest: "c".repeat(64) }],
    ["changed control attempt", { ...identity, controlAttempt: 3 }],
  ])("rejects %s from current strict readback before Step mutation", async (_name, proof) => {
    readers.proof.mockResolvedValue(proof)
    const mock = client()
    await expect(completeNativeSemanticRejectionStepWithClient(mock.client, input)).rejects.toMatchObject({ code: "persistence_conflict" })
    expect(mock.calls.some(call => call.sql.startsWith('UPDATE "agent_steps"') || call.sql.startsWith('INSERT INTO "agent_native_semantic_rejections"'))).toBe(false)
  })

  it("does not accept passed, foreign, or missing current proof identity", async () => {
    readers.proof.mockResolvedValue(null)
    const mock = client()
    await expect(completeNativeSemanticRejectionStepWithClient(mock.client, input)).rejects.toMatchObject({ code: "persistence_conflict" })
    expect(mock.calls.some(call => call.sql.startsWith('UPDATE "agent_steps"'))).toBe(false)
  })

  it("replays only the exact completed Step and receipt without an update or duplicate insert", async () => {
    readers.proof.mockResolvedValue(null)
    const mock = client({ stepStatus: "completed", receipt })
    await expect(completeNativeSemanticRejectionStepWithClient(mock.client, input)).resolves.toEqual({ inputThroughSequence: 8n, distinctStepCount: 1 })
    expect(readers.graph).not.toHaveBeenCalled()
    expect(readers.state).not.toHaveBeenCalled()
    expect(readers.controls).not.toHaveBeenCalled()
    expect(readers.proof).not.toHaveBeenCalled()
    expect(mock.calls.some(call => call.sql.startsWith('UPDATE "agent_steps"') || call.sql.startsWith('INSERT INTO "agent_native_semantic_rejections"'))).toBe(false)
    const rootLock = mock.calls.find(call => call.sql.includes('FOR UPDATE OF task'))
    expect(rootLock?.sql).toContain('task."status" = \'running\'')
    expect(rootLock?.sql).toContain('task."interruptRequestedAt" IS NULL')
    expect(rootLock?.sql).toContain('task."leaseExpiresAt" > CURRENT_TIMESTAMP')
    expect(rootLock?.sql).toContain('task."leaseOwner" = $4')
    expect(rootLock?.values).toEqual(["root", "s", "t", "lease", "u"])
    expect(mock.calls.some(call => call.sql.includes('FROM "agent_steps"') && call.sql.includes('FOR UPDATE'))).toBe(true)
    const receiptRead = mock.calls.find(call => call.sql.startsWith('SELECT * FROM "agent_native_semantic_rejections"'))
    expect(receiptRead?.sql).not.toMatch(/\bFOR\s+UPDATE\b/i)
    const countRead = mock.calls.find(call => call.sql.includes('FROM "agent_native_semantic_rejections" AS rejection'))
    expect(countRead?.sql).toContain('rejection."inputThroughSequence" = $5')
    expect(countRead?.sql).toContain('rejection."controlReportDigest" = $10')
    expect(countRead?.sql).toContain('LIMIT 3')
    expect(countRead?.values).toEqual(["u", "s", "t", "root", "8", identity.candidateDigest, identity.controlTaskId,
      identity.controlOperationId, identity.controlAttempt, identity.controlReportDigest])
  })

  it.each([
    ["user owner", { ...receipt, userId: "other-user" }],
    ["session owner", { ...receipt, sessionId: "other-session" }],
    ["Turn owner", { ...receipt, turnId: "other-turn" }],
    ["root owner", { ...receipt, rootTaskId: "other-root" }],
    ["Step ID", { ...receipt, stepId: "other-step" }],
    ["Step attempt", { ...receipt, attempt: 2 }],
    ["input epoch", { ...receipt, inputThroughSequence: "9" }],
    ["candidate", { ...receipt, candidateDigest: "c".repeat(64) }],
    ["control task", { ...receipt, controlTaskId: "other-control" }],
    ["control operation", { ...receipt, controlOperationId: "other-operation" }],
    ["control attempt", { ...receipt, controlAttempt: 3 }],
    ["report digest", { ...receipt, controlReportDigest: "c".repeat(64) }],
  ])("rejects completed replay with mismatched %s receipt", async (_name, mismatchedReceipt) => {
    const mock = client({ stepStatus: "completed", receipt: mismatchedReceipt })
    await expect(completeNativeSemanticRejectionStepWithClient(mock.client, input)).rejects.toMatchObject({ code: "persistence_conflict" })
    expect(mock.calls.some(call => call.sql.startsWith('UPDATE "agent_steps"') || call.sql.startsWith('INSERT INTO "agent_native_semantic_rejections"'))).toBe(false)
  })

  it("rejects completed replay with changed persisted usage, epoch, or numeric cost", async () => {
    for (const options of [
      { stepStatus: "completed", receipt, stepInputTokens: 13 },
      { stepStatus: "completed", receipt, checkpoint: "9" },
      { stepStatus: "completed", receipt, costMatches: false },
    ]) {
      const mock = client(options)
      await expect(completeNativeSemanticRejectionStepWithClient(mock.client, input)).rejects.toMatchObject({ code: "persistence_conflict" })
      expect(mock.calls.some(call => call.sql.startsWith('UPDATE "agent_steps"') || call.sql.startsWith('INSERT INTO "agent_native_semantic_rejections"'))).toBe(false)
    }
  })

  it("does not write when the non-locking completed probe changes before Step lock", async () => {
    const mock = client({ probeStatus: "completed", stepStatus: "streaming" })
    await expect(completeNativeSemanticRejectionStepWithClient(mock.client, input)).rejects.toMatchObject({ code: "persistence_conflict" })
    expect(readers.proof).not.toHaveBeenCalled()
    expect(mock.calls.some(call => call.sql.startsWith('UPDATE "agent_steps"') || call.sql.startsWith('INSERT INTO "agent_native_semantic_rejections"'))).toBe(false)
  })

  it("does not read proof or write for a Step that is neither completed nor streaming", async () => {
    const mock = client({ stepStatus: "failed" })
    await expect(completeNativeSemanticRejectionStepWithClient(mock.client, input)).rejects.toMatchObject({ code: "persistence_conflict" })
    expect(readers.proof).not.toHaveBeenCalled()
    expect(mock.calls.some(call => call.sql.startsWith('UPDATE "agent_steps"') || call.sql.startsWith('INSERT INTO "agent_native_semantic_rejections"'))).toBe(false)
  })

  it.each([
    ["wrong task", { stepTaskId: "other-root" }],
    ["wrong attempt", { stepAttempt: 2 }],
  ])("rejects completed replay with %s lineage before proof readback", async (_name, options) => {
    const mock = client({ ...options, stepStatus: "completed", receipt })
    await expect(completeNativeSemanticRejectionStepWithClient(mock.client, input)).rejects.toMatchObject({ code: "persistence_conflict" })
    expect(readers.proof).not.toHaveBeenCalled()
    expect(mock.calls.some(call => call.sql.startsWith('UPDATE "agent_steps"') || call.sql.startsWith('INSERT INTO "agent_native_semantic_rejections"'))).toBe(false)
  })

  it.each([
    ["closed Session", { sessionOpen: false }],
    ["lost Turn lease", { turnOwned: false }],
    ["lost or interrupted Root lease", { rootOwned: false }],
    ["invalid Root attempt", { rootAttempt: 0 }],
    ["unpinned durable mode", { mode: "legacy_v1" }],
  ])("rejects completed replay after %s", async (_name, options) => {
    const mock = client({ ...options, stepStatus: "completed", receipt })
    await expect(completeNativeSemanticRejectionStepWithClient(mock.client, input)).rejects.toMatchObject({ code: "persistence_conflict" })
    expect(mock.calls.some(call => call.sql.startsWith('UPDATE "agent_steps"') || call.sql.startsWith('INSERT INTO "agent_native_semantic_rejections"'))).toBe(false)
  })

  it("rejects completed replay when session work is paused", async () => {
    const mock = client({ workAdmitted: false, stepStatus: "completed", receipt })
    await expect(completeNativeSemanticRejectionStepWithClient(mock.client, input)).rejects.toMatchObject({ code: "session_pause_requested" })
    expect(mock.calls.some(call => call.sql.startsWith('UPDATE "agent_steps"') || call.sql.startsWith('INSERT INTO "agent_native_semantic_rejections"'))).toBe(false)
  })

  it("delegates numeric(12,8) half-boundary comparison to PostgreSQL", async () => {
    const boundary = { ...input, estimatedCostUsd: 1.000000005 }
    const mock = client({ stepStatus: "completed", receipt: { ...receipt } })
    await expect(completeNativeSemanticRejectionStepWithClient(mock.client, boundary)).resolves.toEqual({ inputThroughSequence: 8n, distinctStepCount: 1 })
    const comparison = mock.calls.find(call => call.sql.includes("numeric(12,8)"))
    expect(comparison?.sql).toContain("$1::numeric(12,8) = $2::numeric(12,8)")
    expect(comparison?.values).toEqual([1.000000005, "0.00012345"])
  })

  it("rejects mismatched receipt replay and insertion conflicts", async () => {
    const mismatched = client({ stepStatus: "completed", receipt: { ...receipt, controlReportDigest: "c".repeat(64) } })
    await expect(completeNativeSemanticRejectionStepWithClient(mismatched.client, input)).rejects.toMatchObject({ code: "persistence_conflict" })
    const conflictInsert = client({ insertRows: 0 })
    await expect(completeNativeSemanticRejectionStepWithClient(conflictInsert.client, input)).rejects.toMatchObject({ code: "persistence_conflict" })
  })
})
