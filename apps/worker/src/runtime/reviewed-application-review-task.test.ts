import { describe, expect, it, vi } from "vitest"
import {
  lockOrCreateReviewedApplicationTask, readReviewedApplicationReviewBinding, sameReviewedApplicationReviewBinding,
  writeReviewedApplicationReviewBinding, REVIEW_BINDING_EVENT, REVIEW_BINDING_SCHEMA, type ReviewedApplicationReviewBinding,
} from "./reviewed-application-review-task.js"

const scope = { userId: "user-1", sessionId: "session-1", jobId: "job-1", resumeId: "resume-1", now: new Date("2026-11-21T10:00:00.000Z") }
const binding: ReviewedApplicationReviewBinding = {
  schemaVersion: REVIEW_BINDING_SCHEMA, approvalId: "reviewed-application-review:review-turn-1", reviewTurnId: "review-turn-1",
  applicationTaskId: "application-1", userId: scope.userId, sessionId: scope.sessionId, jobId: scope.jobId,
  proof: {
    jobId: scope.jobId, sourceTurnId: "source-turn-1", rootTaskId: "root-1", graphRevision: 7,
    writerTaskId: "writer-1", reviewerTaskId: "reviewer-1", reviewerToolCallId: "review-call-1",
    reviewHash: `sha256:${"a".repeat(64)}`, artifactId: "draft-1", version: 2,
    contentHash: `sha256:${"b".repeat(64)}`, sourceDigest: `sha256:${"c".repeat(64)}`,
  },
  receiptScope: {
    action: "review_application", toolCallId: "review_application:review-turn-1", resourceHash: "d".repeat(64),
    materialHash: "e".repeat(64), answersHash: "f".repeat(64), revision: 4, expiresAt: "2026-11-21T10:30:00.000Z",
  },
}

function readyRow(overrides: Record<string, unknown> = {}) {
  return { id: "application-1", userId: scope.userId, sessionId: scope.sessionId, jobId: scope.jobId, resumeId: scope.resumeId,
    status: "waiting_for_user", checkpoint: "materials_ready", workerTaskId: null, fillTurnId: null,
    fillTurnSessionId: null, fillTurnUserId: null, startedAt: null, completedAt: null, ...overrides }
}

describe("reviewed application review task binding", () => {
  it("creates one same-Session ready task without an upsert reset", async () => {
    const query = vi.fn(async (sql: string, _params?: readonly unknown[]) => sql.includes("INSERT INTO \"application_tasks\"")
      ? { rows: [], rowCount: 1 } : { rows: [readyRow()], rowCount: 1 })
    await expect(lockOrCreateReviewedApplicationTask({ query } as never, scope)).resolves.toBe("application-1")
    expect(query.mock.calls[0]?.[0]).toContain("ON CONFLICT (\"userId\",\"jobId\") DO NOTHING")
    expect(query.mock.calls[0]?.[0]).not.toContain("DO UPDATE")
    expect(query.mock.calls[0]?.[1]?.[4]).toBe(scope.resumeId)
    expect(query.mock.calls[1]?.[0]).toContain("FOR UPDATE")
  })

  it.each([
    ["another Session", { sessionId: "other-session" }],
    ["different resume", { resumeId: "other-resume" }],
    ["protected checkpoint", { checkpoint: "form_fill_queued" }],
    ["non-ready status", { status: "filling" }],
    ["existing worker task", { workerTaskId: "worker-task-1" }],
    ["existing fill Turn", { fillTurnId: "fill-turn-1" }],
    ["prior Worker attempt", { startedAt: new Date() }],
    ["completed attempt", { completedAt: new Date() }],
  ])("refuses to reuse %s", async (_name, overrides) => {
    const query = vi.fn(async (sql: string) => sql.includes("INSERT INTO")
      ? { rows: [], rowCount: 0 } : { rows: [readyRow(overrides)], rowCount: 1 })
    await expect(lockOrCreateReviewedApplicationTask({ query } as never, scope)).resolves.toBeNull()
  })

  it("stores proof identities and canonical receipt scope without letter content or nonce", async () => {
    const query = vi.fn(async (_sql: string, _params?: readonly unknown[]) => ({ rows: [] as unknown[], rowCount: 1 }))
    await writeReviewedApplicationReviewBinding({ query } as never, binding, scope.now)
    const [sql, params] = query.mock.calls[0]!
    expect(sql).toContain("application_task_events")
    const data = JSON.parse(String(params?.[4])) as Record<string, unknown>
    expect(data).toEqual(binding)
    expect(JSON.stringify(data)).not.toContain("nonce")
    expect(JSON.stringify(data)).not.toContain("letter")
  })

  it("replays only one exact private event and rejects duplicates or malformed extra fields", async () => {
    const row = { taskId: binding.applicationTaskId, type: REVIEW_BINDING_EVENT, actor: "worker",
      body: "Reviewed application approval binding recorded.", data: binding }
    const query = vi.fn(async (_sql: string, _params?: readonly unknown[]) => ({ rows: [row] as unknown[], rowCount: 1 }))
    await expect(readReviewedApplicationReviewBinding({ query } as never, binding.applicationTaskId, binding.reviewTurnId)).resolves.toEqual(binding)
    expect(sameReviewedApplicationReviewBinding({ ...binding, receiptScope: { ...binding.receiptScope } }, binding)).toBe(true)
    query.mockResolvedValueOnce({ rows: [{ ...row, data: { ...binding, letter: "private" } }], rowCount: 1 })
    await expect(readReviewedApplicationReviewBinding({ query } as never, binding.applicationTaskId, binding.reviewTurnId)).resolves.toBeNull()
    query.mockResolvedValueOnce({ rows: [row, row], rowCount: 2 })
    await expect(readReviewedApplicationReviewBinding({ query } as never, binding.applicationTaskId, binding.reviewTurnId)).resolves.toBeNull()
  })
})
