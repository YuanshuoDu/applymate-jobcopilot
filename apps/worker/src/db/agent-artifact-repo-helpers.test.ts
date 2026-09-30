import { describe, expect, it, vi } from "vitest"
import type { Pool } from "pg"

import {
  artifactTaskFenceIsCurrent, artifactTaskLeaseIsLive, AgentArtifactRepositoryError,
  findCurrentDraftHeadWithClient, findReviewReceiptWithClient,
  toAgentArtifactReviewRow, toAgentArtifactRow, toAgentArtifactVersionRow, type AgentArtifactTaskFence,
} from "./agent-artifact-repo-helpers.js"

const fence: AgentArtifactTaskFence = {
  taskId: "task-a", userId: "user-a", sessionId: "session-a", turnId: "turn-a", rootTaskId: "root-a",
  parentTaskId: "parent-a", leaseOwner: "worker-a", attemptCount: 2,
}

function clientWith(rows: Array<{ readonly id: string } | { readonly live: boolean }>) {
  let index = 0
  return { query: vi.fn(async (_sql: string, _values?: unknown[]) => {
    const row = rows[index++]
    return { rows: row ? [row] : [], rowCount: row ? 1 : 0 }
  }) }
}

describe("selected-job artifact task fence helpers", () => {
  it("reads the current draft head and exact review receipt through only the supplied client", async () => {
    const calls: Array<{ sql: string; values?: unknown[] }> = []
    const query = vi.fn(async (sql: string, values?: unknown[]) => {
      calls.push({ sql, values })
      return sql.includes('FROM "agent_artifact" AS artifact')
        ? { rows: [{ artifactId: "draft-a", version: 4, contentHash: "content-a", sourceDigest: "source-a" }], rowCount: 1 }
        : { rows: [{
          userId: "user-a", sessionId: "session-a", jobId: "job-a", artifactId: "draft-a", version: 4,
          contentHash: "content-a", sourceDigest: "source-a", currentSourceDigest: "source-a", status: "passed",
          taskId: "reviewer-a", toolCallId: "review-call-a", reviewHash: "review-a",
        }], rowCount: 1 }
    })
    const client = { query }
    const headScope = { userId: "user-a", sessionId: "session-a", jobId: "job-a", artifactId: "draft-a" }
    const receiptScope = {
      ...headScope, version: 4, contentHash: "content-a", sourceDigest: "source-a", currentSourceDigest: "source-a",
      status: "passed" as const, taskId: "reviewer-a", reviewHash: "review-a",
    }

    await expect(findCurrentDraftHeadWithClient(client as never, headScope)).resolves.toEqual({
      artifactId: "draft-a", version: 4, contentHash: "content-a", sourceDigest: "source-a",
    })
    await expect(findReviewReceiptWithClient(client as never, receiptScope)).resolves.toMatchObject({
      artifactId: "draft-a", version: 4, status: "passed", toolCallId: "review-call-a", reviewHash: "review-a",
    })

    expect(query).toHaveBeenCalledTimes(2)
    expect(calls[0]?.values).toEqual(["draft-a", "user-a", "job-a", "session-a"])
    expect(calls[0]?.sql).toContain('version_row."version" = artifact."version"')
    expect(calls[1]?.values).toEqual(["user-a", "session-a", "job-a", "draft-a", 4, "content-a", "source-a", "source-a", "passed", "reviewer-a", "review-a"])
    expect(calls[1]?.sql).toContain('FROM "agent_artifact_review"')
    expect(calls.map(call => call.sql).join(" ")).not.toMatch(/"(content|findings|evidenceRefs|requestHash)"/)
    expect(client).not.toHaveProperty("connect")
  })

  it("maps artifact rows and rejects invalid database lifecycle records", () => {
    const createdAt = new Date("2026-09-30T00:00:00.000Z")
    expect(toAgentArtifactRow({
      id: "artifact-1", userId: "user-1", jobId: "job-1", artifactType: "cover_letter", lifecycle: "draft",
      baseId: "base-1", baseHash: "base-hash", content: { private: true }, hash: "draft-hash", constraintHash: "constraints",
      provenanceRefs: ["source-1", 3], evidenceRefs: ["evidence-1"], previousHash: null, version: "2",
      createdAt, updatedAt: createdAt,
    })).toMatchObject({
      id: "artifact-1", lifecycle: "draft", version: 2, provenanceRefs: ["source-1"], evidenceRefs: ["evidence-1"],
      createdAt, updatedAt: createdAt,
    })
    let invalidArtifact: unknown
    try { toAgentArtifactRow({ lifecycle: "unknown" }) } catch (error: unknown) { invalidArtifact = error }
    expect(invalidArtifact).toBeInstanceOf(AgentArtifactRepositoryError)
    expect(invalidArtifact).toMatchObject({ code: "precondition_failed" })
  })

  it("maps version and review persistence rows while validating review status", () => {
    const createdAt = new Date("2026-09-30T00:00:00.000Z")
    expect(toAgentArtifactVersionRow({
      id: "version-1", artifactId: "artifact-1", version: "3", userId: "user-1", sessionId: "session-1", jobId: "job-1",
      artifactType: "cover_letter", content: "draft", contentHash: "content-hash", sourceDigest: "source-digest",
      constraintHash: "constraints", provenanceRefs: ["source-1"], evidenceRefs: ["evidence-1"], baseId: "base-1",
      baseHash: "base-hash", previousHash: null, taskId: "task-1", toolCallId: "call-1", requestHash: "request-hash", createdAt,
    })).toMatchObject({ artifactId: "artifact-1", version: 3, taskId: "task-1", createdAt })
    expect(toAgentArtifactReviewRow({
      id: "review-1", artifactVersionId: "version-1", userId: "user-1", sessionId: "session-1", jobId: "job-1",
      artifactId: "artifact-1", version: "3", contentHash: "content-hash", sourceDigest: "source-digest",
      currentSourceDigest: "source-digest", status: "stale", findings: [], evidenceRefs: [], taskId: "task-2",
      toolCallId: "review-call", requestHash: "request-hash", reviewHash: "review-hash", createdAt,
    })).toMatchObject({ status: "stale", version: 3, findings: [], evidenceRefs: [], createdAt })
    let invalidReview: unknown
    try { toAgentArtifactReviewRow({ status: "unknown" }) } catch (error: unknown) { invalidReview = error }
    expect(invalidReview).toBeInstanceOf(AgentArtifactRepositoryError)
    expect(invalidReview).toMatchObject({ code: "precondition_failed" })
  })

  it("locks the task lineage and permits legitimate waiting Turn and parent states", async () => {
    const client = clientWith([{ id: "task-a" }, { id: "parent-a" }])
    await expect(artifactTaskFenceIsCurrent(client as unknown as Pick<Pool, "query">, fence, "job-a")).resolves.toBe(true)
    const [taskSql, taskValues] = client.query.mock.calls[0] as unknown as [string, unknown[]]
    expect(taskSql).toContain("FOR UPDATE OF session, turn, root, task")
    expect(taskSql).toContain('task."context"->\'selectedJobPreparation\'->>\'jobId\' = $9')
    expect(taskSql).toContain('root."interruptRequestedAt" IS NULL')
    expect(taskValues).toEqual(["task-a", "user-a", "session-a", "turn-a", "root-a", "parent-a", "worker-a", 2, "job-a"])
    expect(client.query.mock.calls[1]?.[0]).toContain('parent."interruptRequestedAt" IS NULL FOR UPDATE')
  })

  it("fails closed for invalid fences and missing or interrupted parent lineage", async () => {
    const invalid = clientWith([])
    await expect(artifactTaskFenceIsCurrent(invalid as unknown as Pick<Pool, "query">, { ...fence, attemptCount: 0 }, "job-a")).resolves.toBe(false)
    expect(invalid.query).not.toHaveBeenCalled()

    const stoppedParent = clientWith([{ id: "task-a" }])
    await expect(artifactTaskFenceIsCurrent(stoppedParent as unknown as Pick<Pool, "query">, fence, "job-a")).resolves.toBe(false)
  })

  it("rechecks lease expiry against wall clock before commit", async () => {
    const live = clientWith([{ live: true }])
    await expect(artifactTaskLeaseIsLive(live as unknown as Pick<Pool, "query">, fence)).resolves.toBe(true)
    expect(live.query.mock.calls[0]?.[0]).toContain("clock_timestamp()")
    const expired = clientWith([{ live: false }])
    await expect(artifactTaskLeaseIsLive(expired as unknown as Pick<Pool, "query">, fence)).resolves.toBe(false)
  })
})
