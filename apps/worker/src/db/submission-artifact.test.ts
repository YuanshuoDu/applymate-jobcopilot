import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  insertBase: vi.fn(),
  insertBaseWithClient: vi.fn(),
  find: vi.fn(),
}))

vi.mock("./agent-artifact-repo.js", () => ({
  createAgentArtifactRepository: () => mocks,
  insertAgentArtifactBaseWithClient: mocks.insertBaseWithClient,
}))

import type { Pool } from "pg"
import { hashArtifactContent } from "../runtime/subagents/artifact-adapters.js"
import { ensureSubmissionArtifact, ensureSubmissionArtifactWithClient } from "./submission-artifact.js"

const input = { applicationTaskId: "task-1", userId: "user-1", jobId: "job-1", resumeId: "resume-1", coverLetterId: null, answersHash: "a".repeat(64) }
const reviewedHash = "b".repeat(64)
const row = {
  id: "application:task-1", userId: "user-1", jobId: "job-1", artifactType: "application", lifecycle: "base",
  baseId: "application:task-1", baseHash: "hash", content: {}, hash: "hash", constraintHash: "hash", provenanceRefs: [], evidenceRefs: [], previousHash: null,
  version: 1, createdAt: new Date(), updatedAt: new Date(),
}

beforeEach(() => vi.clearAllMocks())

describe("ensureSubmissionArtifact", () => {
  it("preserves the exact legacy v1 manifest and hash", async () => {
    const content = { schemaVersion: "agent-harness.application-submission.v1", applicationTaskId: input.applicationTaskId,
      jobId: input.jobId, resumeId: input.resumeId, coverLetterId: input.coverLetterId, answersHash: input.answersHash }
    const expected = { ...row, hash: hashArtifactContent(content) }
    mocks.insertBaseWithClient.mockResolvedValueOnce(expected)
    const client = { query: vi.fn() }
    await expect(ensureSubmissionArtifactWithClient(client as never, input)).resolves.toBe(expected)
    expect(mocks.insertBaseWithClient).toHaveBeenCalledWith(client, expect.objectContaining({
      id: "application:task-1", artifactType: "application", content,
    }))
  })

  it("preserves legacy v1 calls with any existing nonempty answers hash", async () => {
    const legacyInput = { ...input, answersHash: "answers-hash" }
    const content = { schemaVersion: "agent-harness.application-submission.v1", applicationTaskId: input.applicationTaskId,
      jobId: input.jobId, resumeId: input.resumeId, coverLetterId: input.coverLetterId, answersHash: legacyInput.answersHash }
    const expected = { ...row, hash: hashArtifactContent(content) }
    mocks.insertBase.mockResolvedValueOnce(expected)
    await expect(ensureSubmissionArtifact({} as Pool, legacyInput)).resolves.toBe(expected)
    expect(mocks.insertBase).toHaveBeenCalledWith(expect.objectContaining({ content, hash: expected.hash }))
  })
  it("persists only the shared reviewed v2 manifest commitment", async () => {
    const reviewedInput = { ...input, reviewedCoverLetterHash: reviewedHash }
    const content = { schemaVersion: "agent-harness.application-submission.v2", applicationTaskId: input.applicationTaskId, jobId: input.jobId, resumeId: input.resumeId, coverLetterId: input.coverLetterId, reviewedCoverLetterHash: reviewedHash, answersHash: input.answersHash }
    const expected = { ...row, hash: hashArtifactContent(content) }
    mocks.insertBase.mockResolvedValueOnce(expected)
    await expect(ensureSubmissionArtifact({} as Pool, reviewedInput)).resolves.toBe(expected)
    expect(mocks.insertBase).toHaveBeenCalledWith(expect.objectContaining({ content, hash: expected.hash }))
    expect(JSON.stringify(content)).not.toContain("reviewerTaskId")
    expect(JSON.stringify(content)).not.toContain("cover letter text")
  })

  it("reuses the same reviewed immutable artifact after an idempotent unique race", async () => {
    const reviewedInput = { ...input, reviewedCoverLetterHash: reviewedHash }
    const content = { schemaVersion: "agent-harness.application-submission.v2", applicationTaskId: input.applicationTaskId, jobId: input.jobId, resumeId: input.resumeId, coverLetterId: input.coverLetterId, reviewedCoverLetterHash: reviewedHash, answersHash: input.answersHash }
    const expected = { ...row, hash: hashArtifactContent(content) }
    mocks.insertBase.mockRejectedValueOnce({ code: "23505" })
    mocks.find.mockResolvedValueOnce(expected)
    await expect(ensureSubmissionArtifact({} as Pool, reviewedInput)).resolves.toBe(expected)
  })

  it.each([
    ["changed reviewed commitment", { ...input, reviewedCoverLetterHash: "c".repeat(64) }],
    ["legacy artifact", input],
  ])("conflicts rather than overwriting a prior row (%s)", async (_name, retryInput) => {
    const originalContent = { schemaVersion: "agent-harness.application-submission.v2", applicationTaskId: input.applicationTaskId, jobId: input.jobId, resumeId: input.resumeId, coverLetterId: input.coverLetterId, reviewedCoverLetterHash: reviewedHash, answersHash: input.answersHash }
    mocks.insertBase.mockRejectedValueOnce({ code: "23505" })
    mocks.find.mockResolvedValueOnce({ ...row, hash: hashArtifactContent(originalContent) })
    await expect(ensureSubmissionArtifact({} as Pool, retryInput)).rejects.toMatchObject({ code: "conflict" })
  })

  it("rejects malformed reviewed commitments before any repository write", async () => {
    await expect(ensureSubmissionArtifact({} as Pool, { ...input, reviewedCoverLetterHash: "not-a-digest" }))
      .rejects.toMatchObject({ code: "invalid_input" })
    expect(mocks.insertBase).not.toHaveBeenCalled()
  })

  it("fails when a unique race resolves to a different artifact", async () => {
    mocks.insertBase.mockRejectedValueOnce({ code: "23505" })
    mocks.find.mockResolvedValueOnce({ ...row, hash: "sha256:wrong" })
    await expect(ensureSubmissionArtifact({} as Pool, input)).rejects.toMatchObject({ code: "conflict" })
  })
})
