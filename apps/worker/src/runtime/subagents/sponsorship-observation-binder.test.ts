import { beforeEach, describe, expect, it, vi } from "vitest"
import type { CoordinationTaskView } from "../tools/coordination-types.js"
import { ROLE_RESULT_SCHEMA } from "./role-results.js"
import { SPONSORSHIP_OBSERVATION_PUBLIC_SCHEMA } from "./sponsorship-observation-contract.js"
import { readSponsorshipWaitObservations } from "./sponsorship-observation-binder.js"
import { redactDurableWaitOutput } from "../tools/durable-wait-output-redaction.js"

const mocks = vi.hoisted(() => ({ load: vi.fn(), getJob: vi.fn() }))
vi.mock("./task-graph-pg-verification-receipts.js", () => ({ loadTaskGraphVerificationReceipts: mocks.load }))
vi.mock("../tools/read-data-source.js", () => ({ createPostgresReadToolDataSource: () => ({ getJob: mocks.getJob }) }))

const jobId = "c123456789012345678901234"
const source = "greenhouse"
const url = "https://jobs.example/role/123"
const job = {
  id: jobId, company: "Example Ltd", description: "Visa sponsorship may be considered for this role in Ireland.",
  keywords: null, location: "Dublin, Ireland", role: "Software Engineer", salary: null, score: null,
  source, status: "active", url,
}
const structuredResult = {
  schemaVersion: ROLE_RESULT_SCHEMA, role: "scout", status: "completed",
  candidates: [{ jobId, source, url, evidenceIds: ["source-evidence"] }],
  evidence: [{ id: "source-evidence", kind: "job", ref: jobId, source }], summary: "One saved listing.",
}
const durableTaskResult = { status: "completed", finalText: "scout result", structuredResult }
const task: CoordinationTaskView = {
  id: "subagent-12345678-1234-4234-9234-123456789012", userId: "user-1", sessionId: "session-1", turnId: "turn-1",
  rootTaskId: "root-1", parentTaskId: "root-1", path: "/root-1/scout", depth: 1,
  role: "scout", taskType: "job_discovery", status: "completed", goal: "Find listings", context: {}, result: durableTaskResult,
  attemptCount: 1, maxAttempts: 1, leaseOwner: null, leaseExpiresAt: null, interruptRequestedAt: null, failureReason: null,
}

function receipt(jobValue: unknown = job, inputJobId = jobId, status: "completed" | "failed" = "completed", suffix = "1") {
  const callId = `call-${suffix}`
  return [
    { id: `call-item-${suffix}`, revision: 2, stepId: `step-${suffix}`, attempt: 1, ordinal: Number(suffix) - 1, type: "tool_call",
      content: { toolCallId: callId, toolName: "jobs.get", toolVersion: "1", status, errorCode: status === "completed" ? null : "read_failed", input: { jobId: inputJobId } } },
    { id: `result-item-${suffix}`, revision: 1, stepId: `step-${suffix}`, attempt: 1, ordinal: Number(suffix) - 1, type: "tool_result",
      content: { toolCallId: callId, output: status === "completed" ? { job: jobValue } : null, errorCode: status === "completed" ? null : "read_failed" } },
  ]
}

function runtime(input: { items?: readonly unknown[]; current?: unknown; callCount?: number; resultCount?: number; taskMatches?: boolean } = {}) {
  const client = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      void params
      if (sql.startsWith("BEGIN") || sql.includes("set_config") || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] }
      if (sql.includes('FROM "sub_agent_tasks"')) return { rows: input.taskMatches === false ? [] : [{ result: durableTaskResult }] }
      if (sql.includes("COUNT(*) FILTER")) return { rows: [{ callCount: input.callCount ?? input.items?.filter(item => (item as { type: string }).type === "tool_call").length ?? 1,
        resultCount: input.resultCount ?? input.items?.filter(item => (item as { type: string }).type === "tool_result").length ?? 1 }] }
      throw new Error("unexpected query")
    }), release: vi.fn(),
  }
  const pool = { connect: vi.fn(async () => client) }
  mocks.load.mockResolvedValue({ items: input.items ?? receipt(), outcomes: new Map([["call-1", "completed"]]), replayReceipts: [], evidenceObservations: [] })
  mocks.getJob.mockResolvedValue(input.current === undefined ? job : input.current)
  return { pool, client }
}

describe("same-Job sponsorship observation receipt binder", () => {
  beforeEach(() => { mocks.load.mockReset(); mocks.getJob.mockReset() })

  it("keeps no jobs.get as not_checked rather than a negative claim", async () => {
    const f = runtime({ callCount: 0, resultCount: 0 })
    const [value] = await readSponsorshipWaitObservations(f.pool as never, task) ?? []
    expect(value?.observation).toMatchObject({ schemaVersion: SPONSORSHIP_OBSERVATION_PUBLIC_SCHEMA, status: "not_checked", reason: "not_performed" })
    expect(mocks.load).not.toHaveBeenCalled()
  })

  it("reports a failed same-Job receipt as unavailable", async () => {
    const f = runtime({ items: receipt(null, jobId, "failed") })
    mocks.load.mockResolvedValueOnce({ items: receipt(null, jobId, "failed"), outcomes: new Map([["call-1", "failed"]]), replayReceipts: [], evidenceObservations: [] })
    const [value] = await readSponsorshipWaitObservations(f.pool as never, task) ?? []
    expect(value?.observation).toMatchObject({ status: "unavailable", reason: "read_failed" })
  })

  it("reports a missing current Job or a failed current-material read as unavailable", async () => {
    const missing = runtime({ current: null })
    const [notFound] = await readSponsorshipWaitObservations(missing.pool as never, task) ?? []
    expect(notFound?.observation).toMatchObject({ status: "unavailable", reason: "source_missing" })

    const failed = runtime()
    mocks.getJob.mockRejectedValueOnce(new Error("private database detail"))
    const [readFailed] = await readSponsorshipWaitObservations(failed.pool as never, task) ?? []
    expect(readFailed?.observation).toMatchObject({ status: "unavailable", reason: "read_failed" })
    expect(JSON.stringify(readFailed)).not.toContain("private database detail")
  })

  it("fails closed when the owner-scoped durable Scout lookup has no matching task identity", async () => {
    const f = runtime({ taskMatches: false })
    const [value] = await readSponsorshipWaitObservations(f.pool as never, task) ?? []
    expect(value?.observation).toMatchObject({ status: "unavailable", reason: "read_failed" })
    expect(mocks.load).not.toHaveBeenCalled()
    expect(mocks.getJob).not.toHaveBeenCalled()
    const identityQuery = f.client.query.mock.calls.find(([sql]) => sql.includes('FROM "sub_agent_tasks"'))
    expect(identityQuery?.[0]).toContain('task."sessionId" = $2 AND task."turnId" = $3 AND task."rootTaskId" = $4 AND task."parentTaskId" = $5')
    expect(identityQuery?.[1]).toEqual([task.id, task.sessionId, task.turnId, task.rootTaskId, task.parentTaskId, task.userId, task.attemptCount])
  })

  it("rejects duplicate equal completed receipts as ambiguous", async () => {
    const items = [...receipt(job, jobId, "completed", "1"), ...receipt(job, jobId, "completed", "2")]
    const f = runtime({ items })
    mocks.load.mockResolvedValueOnce({ items, outcomes: new Map([["call-1", "completed"], ["call-2", "completed"]]), replayReceipts: [], evidenceObservations: [] })
    const [value] = await readSponsorshipWaitObservations(f.pool as never, task) ?? []
    expect(value?.observation).toMatchObject({ status: "unavailable", reason: "duplicate_receipt" })
    expect(mocks.getJob).not.toHaveBeenCalled()
  })

  it("rejects a jobs.get receipt for a different Job", async () => {
    const f = runtime({ items: receipt(job, "c999999999999999999999999") })
    mocks.load.mockResolvedValueOnce({ items: receipt(job, "c999999999999999999999999"), outcomes: new Map([["call-1", "completed"]]), replayReceipts: [], evidenceObservations: [] })
    const [value] = await readSponsorshipWaitObservations(f.pool as never, task) ?? []
    expect(value?.observation).toMatchObject({ status: "unavailable", reason: "wrong_job" })
    expect(mocks.getJob).not.toHaveBeenCalled()
  })

  it("rejects stale saved material and preserves a current source only as inconclusive", async () => {
    const stale = runtime({ items: receipt({ ...job, description: "Old listing text." }) })
    const [drifted] = await readSponsorshipWaitObservations(stale.pool as never, task) ?? []
    expect(drifted?.observation).toMatchObject({ status: "unavailable", reason: "source_drift" })

    const current = runtime()
    const [observed] = await readSponsorshipWaitObservations(current.pool as never, task) ?? []
    expect(observed?.observation).toMatchObject({ status: "inconclusive", reason: "interpretation_unverified" })
    expect(JSON.stringify(observed)).not.toContain(job.description)
    expect(JSON.stringify(observed)).not.toContain("bindingDigest")
    expect(observed?.guidance).toContain("jobs.get")

    const safe = redactDurableWaitOutput({ waitId: "wait-12345678-1234-4234-9234-123456789012", status: "ready",
      taskIds: [task.id], deadlineAt: "2026-11-27T00:00:00.000Z", matchedTaskIds: [task.id], tasks: [{ taskId: task.id,
        status: "completed", role: "scout", result: { ...durableTaskResult, sponsorshipObservations: [observed] }, failureReason: null }] }, "agent.wait", "turn") as Record<string, unknown>
    const safeResult = ((safe.tasks as Array<Record<string, unknown>>)[0]!.result) as Record<string, unknown>
    expect((safeResult.sponsorshipObservations as Array<Record<string, unknown>>)[0]).toMatchObject({ jobId, sourceRef: "saved_job_listing" })
    expect(JSON.stringify(safe)).not.toContain(job.description)
    const replay = redactDurableWaitOutput(JSON.parse(JSON.stringify(safe)), "agent.wait", "turn")
    expect(replay).toEqual(safe)
  })
})
