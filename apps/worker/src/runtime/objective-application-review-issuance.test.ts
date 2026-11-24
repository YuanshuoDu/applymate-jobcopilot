import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Pool, PoolClient } from "pg"
import { OBJECTIVE_APPLICATION_REVIEW_INTENT_SCHEMA, type ObjectiveApplicationReviewIntent } from "@jobcopilot/agent-protocol"
import { buildObjectiveApplicationResumeWitness } from "@jobcopilot/shared"
import type { TurnLease } from "./turns/lease.js"
import { issueOrReplayObjectiveApplicationReview } from "./objective-application-review-issuance.js"
import {
  objectiveApplicationReviewIntentHash, objectiveApplicationReviewSetId,
} from "./objective-application-review-set-state.js"

const mocks = vi.hoisted(() => ({
  fence: vi.fn(), admission: vi.fn(), isPause: vi.fn(), evidence: vi.fn(), resume: vi.fn(), applicationTask: vi.fn(),
  issue: vi.fn(), readSet: vi.fn(),
}))

vi.mock("../db/source-material-fence.js", () => ({ acquireSourceMaterialFence: mocks.fence }))
vi.mock("./session-gate.js", () => ({ assertSessionWorkAdmission: mocks.admission, isSessionPauseRequestedError: mocks.isPause }))
vi.mock("./subagents/objective-tailor-completed-source.js", () => ({ readCompletedObjectiveTailorSourceEvidence: mocks.evidence }))
vi.mock("./approval/objective-application-resume-witness.js", () => ({ readObjectiveApplicationResumeWitness: mocks.resume }))
vi.mock("./reviewed-application-review-task.js", () => ({ lockOrCreateReviewedApplicationTask: mocks.applicationTask }))
vi.mock("./approval/objective-application-approval-set-store.js", () => ({
  createPgObjectiveApplicationApprovalSetStore: vi.fn(() => ({ issueInTransaction: mocks.issue })),
}))
vi.mock("./objective-application-review-set-state.js", async importOriginal => {
  const actual = await importOriginal<typeof import("./objective-application-review-set-state.js")>()
  return { ...actual, readObjectiveApplicationReviewSetState: mocks.readSet }
})

const now = new Date("2026-11-24T10:00:00.000Z")
const lease: TurnLease = { userId: "owner-1", sessionId: "session-1", turnId: "review-turn-1", ownerId: "worker-1",
  leaseVersion: 3, leaseStartedAt: new Date(now.getTime() - 1000), leaseExpiresAt: new Date(now.getTime() + 30_000) }
const selection: ObjectiveApplicationReviewIntent = {
  schema: OBJECTIVE_APPLICATION_REVIEW_INTENT_SCHEMA, sourceTurnId: "source-turn-1", rootTaskId: "source-root-1",
  graphItemId: "task-graph:source-root-1", graphRevision: 9, slotOrdinals: [2, 5],
}
const reviewRootTaskId = "review-root-1"

function witness(jobId: string) {
  return buildObjectiveApplicationResumeWitness({ userId: lease.userId, jobId, resumeId: `adapted-${jobId}`,
    finalResumeAssignmentRevision: 2, materialRevision: 4,
    material: { name: "Adapted", content: { role: "Engineer" }, templateId: null, templateOptions: null,
      kind: "adapted", targetJobId: jobId, parentResumeId: "base-resume", basicsDetached: false } })!
}

function evidence() {
  return {
    sourceTurnId: selection.sourceTurnId, sourceRootTaskId: selection.rootTaskId, graphItemId: selection.graphItemId,
    graphRevision: selection.graphRevision, finalItemId: "task-graph-final:source-root-1",
    outcomes: [2, 5].map(ordinal => {
      const jobId = `job-${ordinal}`, writerTaskId = `writer-${ordinal}`, reviewerTaskId = `reviewer-${ordinal}`
      const artifactRef = { artifactId: `artifact-${ordinal}`, version: 3, contentHash: `sha256:${"a".repeat(64)}`, sourceDigest: `sha256:${"b".repeat(64)}` }
      return { slotId: `tailor-${ordinal}`, status: "ready", jobId, writerTaskId, reviewerTaskId, artifactRef,
        reviewReceipt: { status: "passed", taskId: reviewerTaskId, ...artifactRef, currentSourceDigest: artifactRef.sourceDigest,
          reviewHash: `sha256:${"c".repeat(64)}`, toolCallId: `review-tool-${ordinal}` } }
    }),
  }
}

function fakePool(existingItem?: Record<string, unknown>) {
  const calls: string[] = []
  const query = vi.fn(async (sql: string) => {
    calls.push(sql)
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql) || sql.startsWith("SELECT set_config(")) return { rows: [], rowCount: 0 }
    if (sql.includes('FROM "agent_sessions"')) return { rows: [{ id: lease.sessionId }], rowCount: 1 }
    if (sql.includes('FROM "agent_turns"')) return { rows: [{ id: lease.turnId, rootTaskId: reviewRootTaskId, revision: 7,
      input: { intent: { kind: "objective_application_review", version: 1, selection } } }], rowCount: 1 }
    if (sql.includes('FROM "sub_agent_tasks"')) return { rows: [{ id: reviewRootTaskId }], rowCount: 1 }
    if (sql.includes('FROM "agent_items"')) return { rows: existingItem ? [existingItem] : [], rowCount: existingItem ? 1 : 0 }
    throw new Error(`Unexpected SQL: ${sql}`)
  })
  const client = { query, release: vi.fn() }
  const pool = { connect: vi.fn(async () => client) } as unknown as Pool
  return { pool, client, calls, query }
}

function pendingState(setId: string, itemId: string, intentHash: string) {
  return { status: "pending", setId, itemId, intentHash, members: [] }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.fence.mockResolvedValue(undefined)
  mocks.admission.mockResolvedValue(undefined)
  mocks.isPause.mockReturnValue(false)
  mocks.evidence.mockResolvedValue(evidence())
  mocks.resume.mockImplementation(async (_client: unknown, input: { jobId: string }) => witness(input.jobId))
  mocks.applicationTask.mockImplementation(async (_client: unknown, input: { jobId: string }) => `application-task-${input.jobId}`)
  mocks.issue.mockImplementation(async (_client: unknown, input: { setId: string }) => ({ disposition: "created", itemId: `agent-wait:approval-set:${input.setId}`, approvalSet: { setId: input.setId } }))
  mocks.readSet.mockImplementation(async (_client: unknown, input: { sessionId: string; turnId: string; selection: ObjectiveApplicationReviewIntent }) => {
    const setId = objectiveApplicationReviewSetId(input.sessionId, input.turnId)
    return pendingState(setId, `agent-wait:approval-set:${setId}`, objectiveApplicationReviewIntentHash(input.selection))
  })
})

describe("Worker Objective application review issuance", () => {
  it("issues exact selected ready slots under one source-fenced live lease transaction", async () => {
    const fake = fakePool()
    const result = await issueOrReplayObjectiveApplicationReview({ pool: fake.pool, lease, rootTaskId: reviewRootTaskId, selection, now })
    expect(result.status).toBe("issued")
    expect(fake.calls[0]).toBe("BEGIN")
    expect(fake.calls).toContain("COMMIT")
    expect(fake.client.release).toHaveBeenCalledOnce()
    expect(mocks.fence).toHaveBeenCalledWith(fake.client, [lease.userId])
    expect(mocks.fence.mock.invocationCallOrder[0]).toBeLessThan(fake.query.mock.invocationCallOrder[2]!)
    expect(mocks.evidence).toHaveBeenCalledWith(fake.client, expect.objectContaining({ selectedSlotIds: ["tailor-2", "tailor-5"] }))
    const issueInput = mocks.issue.mock.calls[0]?.[1]
    expect(issueInput.members.map((member: { slotOrdinal: number }) => member.slotOrdinal)).toEqual([2, 5])
    expect(issueInput.members[0].receipt.scope.action).toBe("review_application")
    expect(issueInput.members[0].receipt.payload.resumeWitness.resumeId).toBe("adapted-job-2")
    expect(mocks.applicationTask).toHaveBeenCalledWith(fake.client, expect.objectContaining({ jobId: "job-2", resumeId: "adapted-job-2" }))
    expect(fake.calls.some(sql => sql.includes('"leaseExpiresAt">clock_timestamp()'))).toBe(true)
    expect(fake.calls.some(sql => sql.includes('root."leaseExpiresAt">clock_timestamp()'))).toBe(true)
  })

  it("replays an exact existing set before reading source or Resume evidence", async () => {
    const setId = objectiveApplicationReviewSetId(lease.sessionId, lease.turnId)
    const fake = fakePool({ id: `agent-wait:approval-set:${setId}`, sessionId: lease.sessionId, turnId: lease.turnId, type: "approval_request" })
    const result = await issueOrReplayObjectiveApplicationReview({ pool: fake.pool, lease, rootTaskId: reviewRootTaskId, selection, now })
    expect(result.status).toBe("waiting")
    expect(mocks.readSet).toHaveBeenCalledOnce()
    expect(mocks.evidence).not.toHaveBeenCalled()
    expect(mocks.resume).not.toHaveBeenCalled()
    expect(mocks.issue).not.toHaveBeenCalled()
    expect(fake.calls).toContain("COMMIT")
  })

  it("rolls back without issuing when a selected slot is no longer ready", async () => {
    const current = evidence()
    mocks.evidence.mockResolvedValue({ ...current, outcomes: [current.outcomes[0], { ...current.outcomes[1], status: "failed" }] })
    const fake = fakePool()
    const result = await issueOrReplayObjectiveApplicationReview({ pool: fake.pool, lease, rootTaskId: reviewRootTaskId, selection, now })
    expect(result).toEqual({ status: "denied" })
    expect(fake.calls).toContain("ROLLBACK")
    expect(fake.calls).not.toContain("COMMIT")
    expect(mocks.applicationTask).toHaveBeenCalledOnce()
    expect(mocks.issue).not.toHaveBeenCalled()
  })

  it("rejects a colliding non-group item without reading evidence", async () => {
    const setId = objectiveApplicationReviewSetId(lease.sessionId, lease.turnId)
    const fake = fakePool({ id: `agent-wait:approval-set:${setId}`, sessionId: lease.sessionId, turnId: lease.turnId, type: "question" })
    const result = await issueOrReplayObjectiveApplicationReview({ pool: fake.pool, lease, rootTaskId: reviewRootTaskId, selection, now })
    expect(result).toEqual({ status: "denied" })
    expect(mocks.evidence).not.toHaveBeenCalled()
    expect(mocks.issue).not.toHaveBeenCalled()
    expect(fake.calls).toContain("ROLLBACK")
  })
})
