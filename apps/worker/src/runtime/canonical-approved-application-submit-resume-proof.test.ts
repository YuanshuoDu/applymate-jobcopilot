import { beforeEach, describe, expect, it, vi } from "vitest"
import { APPLICATION_FILLER_TEMPLATE_ID } from "./subagents/role-policy.js"
import { readCanonicalApprovedApplicationSubmitResumeProof } from "./canonical-approved-application-submit-resume-proof.js"

const { loadGraph, readReceipts } = vi.hoisted(() => ({ loadGraph: vi.fn(), readReceipts: vi.fn() }))
vi.mock("./subagents/task-graph-pg-state.js", () => ({ loadTaskGraph: loadGraph }))
vi.mock("./canonical-approved-application-submit-resume-receipts.js", () => ({ readCanonicalApprovedApplicationSubmitReceipts: readReceipts }))

const now = new Date("2026-11-22T12:00:00.000Z")
const lease = { userId: "user-a", sessionId: "session-a", turnId: "turn-a", ownerId: "owner-a", leaseVersion: 3,
  leaseStartedAt: new Date("2026-11-22T11:00:00.000Z"), leaseExpiresAt: new Date("2026-11-22T12:01:00.000Z") }
const node = { templateId: APPLICATION_FILLER_TEMPLATE_ID, taskId: "filler-a", verificationDisposition: "specialized" }
const graph = { item: { revision: 7 }, snapshot: { nodes: [node] }, state: { nodes: [{ ...node, status: "completed" }] } }
const turn = { id: lease.turnId, userId: lease.userId, sessionId: lease.sessionId, source: "user", executionMode: "canonical_task_graph",
  status: "in_progress", rootTaskId: "root-a", input: {}, revision: 13, leaseOwnerId: lease.ownerId, leaseVersion: lease.leaseVersion,
  leaseExpiresAt: lease.leaseExpiresAt, sessionStatus: "waiting_for_user" }
const applicationTask = { id: "application-a", userId: lease.userId, sessionId: lease.sessionId, jobId: "job-a", fillTurnId: lease.turnId,
  fillTurnSessionId: lease.sessionId, fillTurnUserId: lease.userId, status: "waiting_for_authorization", checkpoint: "form_filled",
  workerTaskId: null, resumeId: "resume-a", coverLetterId: null, confirmedAnswers: {}, question: null }
const root = (status = "waiting_for_user", changes: Record<string, unknown> = {}) => ({ id: "root-a", status, leaseOwner: null,
  attemptCount: 1, leaseExpiresAt: null, interruptRequestedAt: null, completedAt: null, closedAt: null, nextAttemptAt: null,
  failureReason: null, ...changes })

function clientFor(options: { root?: Record<string, unknown>; turn?: Record<string, unknown>; node?: Record<string, unknown> } = {}) {
  const queries: string[] = []
  const calls: { sql: string; values?: readonly unknown[] }[] = []
  const query = vi.fn(async (sql: string, values?: readonly unknown[]) => {
    queries.push(sql)
    calls.push({ sql, values })
    if (sql.includes('FROM "agent_turns" AS turn JOIN "agent_sessions"')) return { rows: [{ ...turn, ...options.turn }] }
    if (sql.includes('FROM "sub_agent_tasks" AS root')) return { rows: [options.root ?? root()] }
    if (sql.includes('FROM "sub_agent_tasks" AS filler')) return { rows: [{ result: { status: "filled_for_user_review" } }] }
    if (sql.includes('FROM "application_tasks"')) return { rows: [applicationTask] }
    if (sql.includes('FROM "application_task_events"')) return { rows: [] }
    throw new Error("unexpected proof query")
  })
  return { client: { query } as never, query, queries, calls }
}

beforeEach(() => {
  loadGraph.mockReset().mockResolvedValue(graph)
  readReceipts.mockReset().mockResolvedValue({ resourceHash: "a".repeat(64), materialHash: "b".repeat(64), answersHash: "c".repeat(64),
    scopeHash: "d".repeat(64), approvalRevision: 9, state: "form_filled", workerTaskId: null, outboxId: null })
})

describe("canonical approved application submit resume proof", () => {
  it.each(["waiting", "waiting_for_user"])("accepts a safe persisted %s Root before normal Root rebind", async status => {
    const test = clientFor({ root: root(status) })
    const result = await readCanonicalApprovedApplicationSubmitResumeProof(test.client, { lease, rootTaskId: "root-a", now })
    expect(result).toMatchObject({ state: "form_filled", rootTaskId: "root-a", fillerTaskId: "filler-a", turnRevision: 13 })
    expect(test.queries[1]).toContain("root.\"status\" IN ('running','waiting','waiting_for_user')")
    expect(readReceipts).toHaveBeenCalledOnce()
  })

  it("accepts an already rebound Root only under this exact unexpired lease", async () => {
    const test = clientFor({ root: root("running", { leaseOwner: lease.ownerId, leaseExpiresAt: new Date("2026-11-22T12:02:00Z") }) })
    await expect(readCanonicalApprovedApplicationSubmitResumeProof(test.client, { lease, rootTaskId: "root-a", now })).resolves.toMatchObject({ state: "form_filled" })
  })

  it("admits only an expired prior Root owner for canonical reclaim", async () => {
    const test = clientFor({ root: root("running", { leaseOwner: "prior-owner", leaseExpiresAt: new Date("2026-11-22T11:59:00Z") }) })
    await expect(readCanonicalApprovedApplicationSubmitResumeProof(test.client, { lease, rootTaskId: "root-a", now })).resolves.toMatchObject({ state: "form_filled" })
    const sql = test.calls[1]!.sql.replace(/\s+/g, " ")
    expect(sql).toContain(`OR (root."status"='running' AND root."leaseOwner" IS NOT NULL AND root."leaseExpiresAt" IS NOT NULL AND root."leaseExpiresAt"<=$6)`)
    expect(test.calls[1]!.values?.slice(4)).toEqual([lease.ownerId, now])
  })

  it.each([
    ["waiting root with a lease", root("waiting", { leaseOwner: "other-worker" })],
    ["wrong root attempt", root("waiting", { attemptCount: 2 })],
    ["interrupted root", root("waiting", { interruptRequestedAt: now })],
    ["terminal root", root("waiting", { completedAt: now })],
    ["running root with a live foreign lease", root("running", { leaseOwner: "other-worker", leaseExpiresAt: new Date("2026-11-22T12:02:00Z") })],
  ] as const)("denies %s", async (_label, row) => {
    const test = clientFor({ root: row })
    await expect(readCanonicalApprovedApplicationSubmitResumeProof(test.client, { lease, rootTaskId: "root-a", now })).resolves.toBeNull()
    expect(readReceipts).not.toHaveBeenCalled()
  })

  it("requires the exact specialized single-filler graph", async () => {
    loadGraph.mockResolvedValueOnce({ ...graph, snapshot: { nodes: [{ ...node, verificationDisposition: "legacy_unverified" }] } })
    const test = clientFor()
    await expect(readCanonicalApprovedApplicationSubmitResumeProof(test.client, { lease, rootTaskId: "root-a", now })).resolves.toBeNull()
    expect(readReceipts).not.toHaveBeenCalled()
  })
})
