import { beforeEach, describe, expect, it, vi } from "vitest"

const harness = vi.hoisted(() => ({
  lock: vi.fn(), load: vi.fn(), observations: vi.fn(), packet: vi.fn(), control: vi.fn(), country: vi.fn(), redact: vi.fn(),
}))

vi.mock("./task-graph-pg-state.js", () => ({ lockTaskGraphScope: harness.lock }))
vi.mock("./task-graph-pg-verification-receipts.js", () => ({ loadTaskGraphVerificationReceipts: harness.load }))
vi.mock("./sponsorship-observation-binder-core.js", () => ({ readSponsorshipTaskObservationsWithClient: harness.observations }))
vi.mock("./sponsorship-review-packet.js", () => ({ buildSponsorshipReviewPacket: harness.packet }))
vi.mock("./native-verification-pg-request.js", () => ({ ensureNativeVerificationControl: harness.control }))
vi.mock("../context/root-task-objective.js", () => ({ resolveRootTaskSponsorshipTargetCountry: harness.country }))
vi.mock("../tools/durable-wait-output-redaction.js", () => ({ redactDurableWaitOutput: harness.redact }))

import { requestSponsorshipReview } from "./sponsorship-review-request.js"

const userId = "user-1", sessionId = "session-1", turnId = "turn-1", rootTaskId = "root-1"
const scoutTaskId = "subagent-12345678-1234-4234-9234-123456789012"
const waitId = "wait-12345678-1234-4234-9234-123456789012"
const jobId = "c123456789012345678901234"

function readyReceipts(ordinal: number) {
  const input = { idempotencyKey: "wait-key", taskIds: [scoutTaskId], mode: "all", timeoutMs: 30_000 }
  const output = { waitId, status: "ready", taskIds: [scoutTaskId], deadlineAt: "2026-11-27T12:00:00.000Z",
    matchedTaskIds: [scoutTaskId], tasks: [{ taskId: scoutTaskId, status: "completed", role: "scout", result: {}, failureReason: null }] }
  const call = { id: "call-item", type: "tool_call", taskId: rootTaskId, stepId: "root-wait-step", attempt: 1, ordinal,
    content: { toolCallId: "wait-call", toolName: "agent.wait", toolVersion: "1", status: "completed", errorCode: null, input } }
  const result = { id: "result-item", type: "tool_result", taskId: rootTaskId, stepId: "root-wait-step", attempt: 1, ordinal,
    content: { toolCallId: "wait-call", errorCode: null, output } }
  return { items: [call, result], outcomes: new Map([["wait-call", "completed"]]), replayReceipts: [], evidenceObservations: [] }
}

function runtime(predecessor: { ordinal: number; attempt: number } = { ordinal: 4, attempt: 1 }, currentAttempt = 1) {
  const calls: Array<{ sql: string; params: readonly unknown[] }> = []
  const client = { query: vi.fn(async (sql: string, params: readonly unknown[] = []) => {
    calls.push({ sql, params })
    if (sql.startsWith("BEGIN") || sql.includes("set_config") || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] }
    if (sql.includes('SELECT turn."input"')) return { rows: [{ input: {} }] }
    if (sql.includes('SELECT "ordinal", "attempt", "status", "taskId" FROM "agent_steps"')) {
      return { rows: [{ ordinal: 6, attempt: currentAttempt, status: "streaming", taskId: rootTaskId }] }
    }
    if (sql.includes('SELECT priorStep."ordinal"')) return { rows: [{ ...predecessor, taskId: rootTaskId }] }
    if (sql.includes('SELECT task."id", session."userId"')) return { rows: [{ id: scoutTaskId, userId, sessionId, turnId,
      rootTaskId, parentTaskId: rootTaskId, role: "scout", taskType: "job_discovery", status: "completed", attemptCount: 1,
      context: {}, result: {} }] }
    if (sql.includes('FROM "Job"')) return { rows: [{ id: jobId }] }
    throw new Error("unexpected sponsorship request query")
  }), release: vi.fn() }
  return { calls, client, pool: { connect: vi.fn(async () => client) } }
}

const context = { actorRole: "orchestrator", taskId: rootTaskId, rootTaskId, sessionId, turnId, stepId: "current-step",
  scope: { userId }, signal: new AbortController().signal, capabilities: ["canManageChildren"], reportProgress: async () => undefined }
const native = { enabled: true, turnLeaseOwner: "worker-1", turnLeaseVersion: 7, parentLeaseOwner: "worker-1", parentAttemptCount: () => 1 }

describe("sponsorship review request Root predecessor", () => {
  beforeEach(() => vi.clearAllMocks())

  it("uses the nearest earlier same-attempt Root wait despite a Turn-global child step", async () => {
    const f = runtime({ ordinal: 4, attempt: 1 })
    harness.lock.mockResolvedValue({ id: rootTaskId, parentTaskId: null })
    harness.load.mockResolvedValue(readyReceipts(4))
    harness.observations.mockResolvedValue([{ jobId, observation: { status: "inconclusive" }, source: { digest: "source" } }])
    harness.packet.mockReturnValue({ target: {}, content: {} })
    harness.control.mockResolvedValue({ taskId: "reviewer-1", status: "queued" })
    harness.country.mockReturnValue({ status: "valid", sponsorshipTargetCountry: { countryCode: "IE" } })
    harness.redact.mockImplementation((value: unknown) => value)

    await expect(requestSponsorshipReview(f.pool as never, native, context as never, jobId))
      .resolves.toEqual({ taskId: "reviewer-1", status: "queued" })

    const predecessor = f.calls.find(call => call.sql.includes('SELECT priorStep."ordinal"'))
    expect(predecessor?.params).toEqual([sessionId, turnId, rootTaskId, 6, userId])
    expect(predecessor?.sql).toContain('ORDER BY priorStep."ordinal" DESC LIMIT 1')
    expect(predecessor?.sql).not.toContain('priorStep."attempt" =')
    expect(harness.load).toHaveBeenCalledWith(f.client, expect.objectContaining({ attemptCount: 1, exclusiveBeforeOrdinal: 6 }))
    expect(harness.observations).toHaveBeenCalledOnce()
    expect(harness.control).toHaveBeenCalledOnce()
  })

  it("fails closed when the nearest earlier Root step belongs to another attempt", async () => {
    const f = runtime({ ordinal: 4, attempt: 1 }, 2)
    harness.lock.mockResolvedValue({ id: rootTaskId, parentTaskId: null })
    harness.country.mockReturnValue({ status: "valid", sponsorshipTargetCountry: { countryCode: "IE" } })

    await expect(requestSponsorshipReview(f.pool as never, native, context as never, jobId))
      .rejects.toThrow("sponsorship_review_source_unavailable")

    expect(harness.load).not.toHaveBeenCalled()
    expect(harness.observations).not.toHaveBeenCalled()
    expect(harness.control).not.toHaveBeenCalled()
    expect(f.calls.some(call => call.sql === "ROLLBACK")).toBe(true)
  })
})
