import { beforeEach, describe, expect, it, vi } from "vitest"
import { APPLICATION_FILLER_TEMPLATE_ID } from "./subagents/role-policy.js"
import { readCanonicalApprovedApplicationSubmitResumeProof } from "./canonical-approved-application-submit-resume-proof.js"

const { loadGraph, readReceipts, readReviewedArtifact } = vi.hoisted(() => ({
  loadGraph: vi.fn(), readReceipts: vi.fn(), readReviewedArtifact: vi.fn(),
}))
vi.mock("./subagents/task-graph-pg-state.js", () => ({ loadTaskGraph: loadGraph }))
vi.mock("./canonical-approved-application-submit-resume-receipts.js", () => ({ readCanonicalApprovedApplicationSubmitReceipts: readReceipts }))
vi.mock("./selected-job-reviewed-artifact-read.js", () => ({ readSelectedJobReviewedArtifactWithClient: readReviewedArtifact }))

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
const reviewedMarker = { schemaVersion: "agent-harness.v2.selected-job-reviewed-fill-source.v1", sourceTurnId: "source-a" }
const reviewedArtifact = {
  sourceTurnId: "source-a", rootTaskId: "source-root", graphRevision: 7, jobId: "job-a", writerTaskId: "writer-a",
  reviewerTaskId: "reviewer-a", reviewerToolCallId: "review-tool-a", reviewHash: `sha256:${"a".repeat(64)}`, artifactId: "artifact-a",
  version: 2, contentHash: `sha256:${"b".repeat(64)}`, sourceDigest: `sha256:${"c".repeat(64)}`, content: "Synthetic reviewed material",
}
const reviewedBrowserStart = { actor: "worker", data: {
  schemaVersion: "agent-harness.v2.reviewed-application-fill-browser-start.v1", userId: "user-a", sessionId: "session-a",
  fillTurnId: "turn-a", applicationTaskId: "application-a", fillerTaskId: "filler-a", jobId: "job-a", rootTaskId: "source-root",
  graphRevision: 7, attemptCount: 1, leaseOwner: "worker-a", leaseExpiresAt: "2026-11-22T12:00:30.000Z",
  sourceTurnId: "source-a", writerTaskId: "writer-a", reviewerTaskId: "reviewer-a", reviewerToolCallId: "review-tool-a",
  reviewHash: `sha256:${"a".repeat(64)}`, artifactId: "artifact-a", version: 2,
  contentHash: `sha256:${"b".repeat(64)}`, sourceDigest: `sha256:${"c".repeat(64)}`,
} }

function clientFor(options: {
  root?: Record<string, unknown>; turn?: Record<string, unknown>; turnRows?: Array<Record<string, unknown>>
  events?: Array<Record<string, unknown>>; applicationTask?: Record<string, unknown>; node?: Record<string, unknown>
} = {}) {
  const queries: string[] = []
  const calls: { sql: string; values?: readonly unknown[] }[] = []
  const query = vi.fn(async (sql: string, values?: readonly unknown[]) => {
    queries.push(sql)
    calls.push({ sql, values })
    if (sql.includes('FROM "agent_turns" AS turn JOIN "agent_sessions"')) return { rows: options.turnRows ?? [{ ...turn, ...options.turn }] }
    if (sql.includes('FROM "sub_agent_tasks" AS root')) return { rows: [options.root ?? root()] }
    if (sql.includes('FROM "sub_agent_tasks" AS filler')) return { rows: [{ result: { status: "filled_for_user_review" } }] }
    if (sql.includes('FROM "application_tasks"')) return { rows: [{ ...applicationTask, ...options.applicationTask }] }
    if (sql.includes('FROM "application_task_events"')) return { rows: options.events ?? [] }
    throw new Error("unexpected proof query")
  })
  return { client: { query } as never, query, queries, calls }
}

beforeEach(() => {
  loadGraph.mockReset().mockResolvedValue(graph)
  readReceipts.mockReset().mockResolvedValue({ resourceHash: "a".repeat(64), materialHash: "b".repeat(64), answersHash: "c".repeat(64),
    scopeHash: "d".repeat(64), approvalRevision: 9, state: "form_filled", workerTaskId: null, outboxId: null })
  readReviewedArtifact.mockReset().mockResolvedValue(null)
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

  it.each([
    { state: "form_filled", task: { status: "waiting_for_authorization", checkpoint: "form_filled", workerTaskId: null }, workerTaskId: null, outboxId: null },
    { state: "submission_authorized", task: { status: "filling", checkpoint: "submission_authorized", workerTaskId: "submit-worker-a" },
      workerTaskId: "submit-worker-a", outboxId: "submit-outbox-a" },
  ] as const)("accepts null mode with exact reviewed binding at $state", async scenario => {
    readReviewedArtifact.mockResolvedValue(reviewedArtifact)
    readReceipts.mockResolvedValue({ resourceHash: "a".repeat(64), materialHash: "b".repeat(64), answersHash: "c".repeat(64),
      scopeHash: "d".repeat(64), approvalRevision: 9, state: scenario.state,
      workerTaskId: scenario.workerTaskId, outboxId: scenario.outboxId })
    const test = clientFor({
      turn: { executionMode: null, input: { reviewedApplicationMaterialSource: reviewedMarker } },
      events: [reviewedBrowserStart], applicationTask: scenario.task,
    })
    await expect(readCanonicalApprovedApplicationSubmitResumeProof(test.client, { lease, rootTaskId: "root-a", now }))
      .resolves.toMatchObject({ state: scenario.state, rootTaskId: "root-a", applicationTaskId: "application-a",
        workerTaskId: scenario.workerTaskId, outboxId: scenario.outboxId })
    expect(test.calls[0]?.sql).toContain(`(turn."executionMode"='canonical_task_graph' OR turn."executionMode" IS NULL)`)
    expect(readReceipts).toHaveBeenCalledOnce()
    expect(readReviewedArtifact).toHaveBeenCalledOnce()
  })

  it.each([
    ["no marker", null, {}],
    ["malformed marker", null, { reviewedApplicationMaterialSource: { ...reviewedMarker, extra: true } }],
    ["unrelated explicit mode", "legacy_pipeline_adapter", { reviewedApplicationMaterialSource: reviewedMarker }],
  ] as const)("rejects null or unrelated execution mode with %s", async (_label, executionMode, input) => {
    const test = clientFor({ turn: { executionMode, input } })
    await expect(readCanonicalApprovedApplicationSubmitResumeProof(test.client, { lease, rootTaskId: "root-a", now })).resolves.toBeNull()
    expect(readReceipts).not.toHaveBeenCalled()
  })

  it("rejects ambiguous owned Turn and duplicate reviewed browser bindings", async () => {
    const duplicateTurn = clientFor({ turnRows: [{ ...turn }, { ...turn }] })
    await expect(readCanonicalApprovedApplicationSubmitResumeProof(duplicateTurn.client, { lease, rootTaskId: "root-a", now })).resolves.toBeNull()
    const duplicateBinding = clientFor({
      turn: { executionMode: null, input: { reviewedApplicationMaterialSource: reviewedMarker } },
      events: [reviewedBrowserStart, reviewedBrowserStart],
    })
    await expect(readCanonicalApprovedApplicationSubmitResumeProof(duplicateBinding.client, { lease, rootTaskId: "root-a", now })).resolves.toBeNull()
    expect(readReceipts).not.toHaveBeenCalled()
  })

  it.each(["root-a", "unrelated-root"])("rejects a browser binding with the wrong reviewed source Root %s", async sourceRootId => {
    readReviewedArtifact.mockResolvedValue(reviewedArtifact)
    const test = clientFor({
      turn: { executionMode: null, input: { reviewedApplicationMaterialSource: reviewedMarker } },
      events: [{ ...reviewedBrowserStart, data: { ...reviewedBrowserStart.data, rootTaskId: sourceRootId } }],
    })
    await expect(readCanonicalApprovedApplicationSubmitResumeProof(test.client, { lease, rootTaskId: "root-a", now })).resolves.toBeNull()
    expect(readReceipts).not.toHaveBeenCalled()
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
