import { describe, expect, it, vi } from "vitest"
import { hasOwnCorrectionSuccessorHeadWithClient, type OwnCorrectionSuccessorHeadScope } from "./agent-artifact-correction-head.js"

const scope: OwnCorrectionSuccessorHeadScope = { userId: "user-1", sessionId: "session-1", jobId: "job-1",
  artifactId: "draft-1", priorVersion: 3, priorContentHash: "sha256:prior", sourceDigest: "sha256:source",
  correctionWriterTaskId: "correction-writer-1" }
const exact = { artifactId: scope.artifactId, headVersion: 4, headHash: "sha256:next", version: 4,
  contentHash: "sha256:next", sourceDigest: scope.sourceDigest, previousHash: scope.priorContentHash,
  taskId: scope.correctionWriterTaskId }

describe("own correction successor head", () => {
  it("accepts only a locked exact v+1 current head written by this correction task", async () => {
    const client = { query: vi.fn(async (..._args: unknown[]) => ({ rows: [exact] })) }
    await expect(hasOwnCorrectionSuccessorHeadWithClient(client as never, scope)).resolves.toBe(true)
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining('version_row."taskId"=$7'), [
      scope.artifactId, scope.userId, scope.jobId, scope.sessionId, scope.priorVersion, scope.priorContentHash,
      scope.correctionWriterTaskId, scope.sourceDigest,
    ])
    expect(client.query.mock.calls[0]?.[0]).toContain("FOR UPDATE OF artifact")
  })

  it.each([
    { rows: [] }, { rows: [exact, exact] }, { rows: [{ ...exact, taskId: "other-writer" }] },
    { rows: [{ ...exact, headVersion: 5, version: 5 }] }, { rows: [{ ...exact, previousHash: "sha256:other" }] },
    { rows: [{ ...exact, sourceDigest: "sha256:other" }] }, { rows: [{ ...exact, contentHash: "sha256:other" }] },
  ])("rejects absent, ambiguous, foreign, later, or mismatched head evidence", async response => {
    const client = { query: vi.fn(async () => response) }
    await expect(hasOwnCorrectionSuccessorHeadWithClient(client as never, scope)).resolves.toBe(false)
  })

  it("does not query for malformed owner or version scope", async () => {
    const client = { query: vi.fn() }
    await expect(hasOwnCorrectionSuccessorHeadWithClient(client as never, { ...scope, priorVersion: 0 })).resolves.toBe(false)
    await expect(hasOwnCorrectionSuccessorHeadWithClient(client as never, { ...scope, userId: " " })).resolves.toBe(false)
    expect(client.query).not.toHaveBeenCalled()
  })
})
