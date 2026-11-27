import { beforeEach, describe, expect, it, vi } from "vitest"
import type { PoolClient } from "pg"
import { readCurrentScheduledDraftJobMaterialDigest, readScheduledDraftJobMaterialDigests, scheduledDraftJobMaterialDigest } from "./scheduled-draft-job-material.js"
import { loadTaskGraphVerificationReceipts } from "./task-graph-pg-verification-receipts.js"
import type { TaskGraphVerificationScope } from "./task-graph-pg-verification-receipt-validation.js"
import { redactJobReadOutput } from "../tools/job-read-output-redaction.js"

vi.mock("./task-graph-pg-verification-receipts.js", () => ({ loadTaskGraphVerificationReceipts: vi.fn() }))

const jobId = "123e4567-e89b-42d3-a456-426614174000"
const scope: TaskGraphVerificationScope = { userId: "owner-1", sessionId: "session-1", turnId: "turn-1",
  rootTaskId: "root-1", parentTaskId: "root-1", taskId: "analyst-1", attemptCount: 2 }
const baseJob = {
  id: jobId, company: "Example GmbH", role: "Software Engineer", location: "Berlin", status: "saved", score: 7,
  url: "https://jobs.example/role", source: "greenhouse", salary: "€70k", description: "Build reliable services",
  keywords: "TypeScript, PostgreSQL",
}

function receipt(job: Record<string, unknown>, toolName = "jobs.get", callId = "call-1") {
  const output = toolName === "jobs.get" ? { job } : { jobs: [job], page: 1, hasMore: false }
  return {
    items: [
      { id: `call-item-${callId}`, type: "tool_call", content: { toolCallId: callId, toolName } },
      { id: `result-item-${callId}`, type: "tool_result", content: { toolCallId: callId, output } },
    ],
    outcomes: new Map([[callId, "completed"]]), replayReceipts: [], evidenceObservations: [],
  }
}

function clientFor(row: Record<string, unknown>) {
  const query = vi.fn(async (..._args: unknown[]) => ({ rows: [row], rowCount: 1 }))
  return { client: { query } as unknown as PoolClient, query }
}

beforeEach(() => vi.clearAllMocks())

describe("scheduled draft job material proof", () => {
  it("matches the same redacted Job material and ignores volatile status and score", async () => {
    const safeReceipt = redactJobReadOutput("jobs.get", { job: baseJob })
    vi.mocked(loadTaskGraphVerificationReceipts).mockResolvedValue(receipt((safeReceipt as { job: Record<string, unknown> }).job) as never)
    const source = clientFor({ ...baseJob, status: "applied", score: 10, createdAt: new Date(), updatedAt: new Date() })
    const observed = await readScheduledDraftJobMaterialDigests(source.client, scope, [jobId])
    const current = await readCurrentScheduledDraftJobMaterialDigest(source.client, scope.userId, jobId)

    expect(observed.get(jobId)).toBe(current)
    expect(source.query).toHaveBeenCalledOnce()
    expect(source.query.mock.calls[0]?.[1]).toEqual([jobId, scope.userId])
  })

  it("reads current material through the caller client and changes digest with stable source text", async () => {
    const first = clientFor(baseJob), changed = clientFor({ ...baseJob, description: "A materially changed role" })
    const firstDigest = await readCurrentScheduledDraftJobMaterialDigest(first.client, scope.userId, jobId)
    const changedDigest = await readCurrentScheduledDraftJobMaterialDigest(changed.client, scope.userId, jobId)

    expect(firstDigest).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(changedDigest).not.toBe(firstDigest)
    expect(first.query).toHaveBeenCalledOnce()
    expect(first.query.mock.calls[0]?.[1]).toEqual([jobId, scope.userId])
  })

  it("does not admit a search receipt without the exact inline jobs.get source", async () => {
    vi.mocked(loadTaskGraphVerificationReceipts).mockResolvedValue(receipt(baseJob, "jobs.search") as never)
    const { client } = clientFor(baseJob)
    const digests = await readScheduledDraftJobMaterialDigests(client, scope, [jobId])

    expect(digests).toEqual(new Map())
  })

  it("hashes the exact server-loaded Job through the same redacted stable projection", () => {
    expect(scheduledDraftJobMaterialDigest(baseJob)).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(scheduledDraftJobMaterialDigest({ ...baseJob, status: "applied", score: 10 })).toBe(scheduledDraftJobMaterialDigest(baseJob))
    expect(scheduledDraftJobMaterialDigest({ ...baseJob, id: "foreign" })).toBeNull()
  })

  it.each([
    ["missing source", { job: null }],
    ["reference only", { $ref: "tool-result-reference" }],
    ["wrong job", { job: { ...baseJob, id: "223e4567-e89b-42d3-a456-426614174000" } }],
  ])("does not produce a material digest from %s", async (_name, output) => {
    vi.mocked(loadTaskGraphVerificationReceipts).mockResolvedValue({
      ...receipt(baseJob), items: [
        { id: "call", type: "tool_call", content: { toolCallId: "call-1", toolName: "jobs.get" } },
        { id: "result", type: "tool_result", content: { toolCallId: "call-1", output } },
      ],
    } as never)
    const { client } = clientFor(baseJob)

    expect(await readScheduledDraftJobMaterialDigests(client, scope, [jobId])).toEqual(new Map())
  })

  it("fails closed when repeated exact receipts disagree about the same Job", async () => {
    const conflicting = receipt(baseJob)
    const second = receipt({ ...baseJob, description: "Changed between reads" }, "jobs.get", "call-2")
    vi.mocked(loadTaskGraphVerificationReceipts).mockResolvedValue({
      ...conflicting, items: [...conflicting.items, ...second.items],
      outcomes: new Map([["call-1", "completed"], ["call-2", "completed"]]),
    } as never)
    const { client } = clientFor(baseJob)

    expect(await readScheduledDraftJobMaterialDigests(client, scope, [jobId])).toEqual(new Map())
  })

  it("rejects unbounded or noncanonical job selectors without reading receipts", async () => {
    const { client } = clientFor(baseJob)
    expect(await readScheduledDraftJobMaterialDigests(client, scope, ["not-a-canonical-job"])).toEqual(new Map())
    expect(loadTaskGraphVerificationReceipts).not.toHaveBeenCalled()
  })
})
