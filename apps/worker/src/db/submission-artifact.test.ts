import { describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  insertBase: vi.fn(),
  find: vi.fn(),
}))

vi.mock("./agent-artifact-repo.js", () => ({
  createAgentArtifactRepository: () => mocks,
}))

import type { Pool } from "pg"
import { hashArtifactContent } from "../runtime/subagents/artifact-adapters.js"
import { ensureSubmissionArtifact } from "./submission-artifact.js"

const input = { applicationTaskId: "task-1", userId: "user-1", jobId: "job-1", resumeId: "resume-1", coverLetterId: null, answersHash: "a".repeat(64) }
const row = {
  id: "application:task-1", userId: "user-1", jobId: "job-1", artifactType: "application", lifecycle: "base",
  baseId: "application:task-1", baseHash: "hash", content: {}, hash: "hash", constraintHash: "hash", provenanceRefs: [], evidenceRefs: [], previousHash: null,
  version: 1, createdAt: new Date(), updatedAt: new Date(),
}

describe("ensureSubmissionArtifact", () => {
  it("writes an immutable non-sensitive manifest", async () => {
    mocks.insertBase.mockResolvedValueOnce(row)
    await expect(ensureSubmissionArtifact({} as Pool, input)).resolves.toBe(row)
    expect(mocks.insertBase).toHaveBeenCalledWith(expect.objectContaining({ id: "application:task-1", artifactType: "application", content: expect.objectContaining({ answersHash: input.answersHash }) }))
  })

  it("reuses the same immutable artifact after an idempotent unique race", async () => {
    const content = {
      schemaVersion: "agent-harness.application-submission.v1",
      applicationTaskId: input.applicationTaskId,
      jobId: input.jobId,
      resumeId: input.resumeId,
      coverLetterId: input.coverLetterId,
      answersHash: input.answersHash,
    }
    const expected = { ...row, hash: hashArtifactContent(content) }
    mocks.insertBase.mockRejectedValueOnce({ code: "23505" })
    mocks.find.mockResolvedValueOnce(expected)
    await expect(ensureSubmissionArtifact({} as Pool, input)).resolves.toBe(expected)
  })

  it("fails when a unique race resolves to a different artifact", async () => {
    mocks.insertBase.mockRejectedValueOnce({ code: "23505" })
    mocks.find.mockResolvedValueOnce({ ...row, hash: "sha256:wrong" })
    await expect(ensureSubmissionArtifact({} as Pool, input)).rejects.toMatchObject({ code: "conflict" })
  })
})
