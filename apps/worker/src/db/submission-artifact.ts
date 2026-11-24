import type { Pool, PoolClient } from "pg"
import { buildApplicationSubmissionManifest, type ApplicationSubmissionManifest } from "@jobcopilot/shared"

import { hashArtifactContent } from "../runtime/subagents/artifact-adapters.js"
import { createAgentArtifactRepository, insertAgentArtifactBaseWithClient, type AgentArtifactRow } from "./agent-artifact-repo.js"

export type SubmissionArtifactInput = {
  readonly applicationTaskId: string
  readonly userId: string
  readonly jobId: string
  readonly resumeId: string | null
  readonly coverLetterId: string | null
  readonly answersHash: string
  readonly reviewedCoverLetterHash?: string
}

export class SubmissionArtifactError extends Error {
  constructor(readonly code: "invalid_input" | "conflict", message: string) {
    super(message)
    this.name = "SubmissionArtifactError"
  }
}

function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "23505")
}

function assertInput(input: SubmissionArtifactInput): void {
  if ([input.applicationTaskId, input.userId, input.jobId, input.answersHash].some(value => !value.trim())) {
    throw new SubmissionArtifactError("invalid_input", "Submission artifact identity is incomplete.")
  }
}

function manifestFor(input: SubmissionArtifactInput): ApplicationSubmissionManifest {
  if (input.reviewedCoverLetterHash === undefined) {
    return {
      schemaVersion: "agent-harness.application-submission.v1",
      applicationTaskId: input.applicationTaskId,
      jobId: input.jobId,
      resumeId: input.resumeId,
      coverLetterId: input.coverLetterId,
      answersHash: input.answersHash,
    }
  }
  const material = {
    applicationTaskId: input.applicationTaskId,
    jobId: input.jobId,
    resumeId: input.resumeId,
    coverLetterId: input.coverLetterId,
    reviewedCoverLetterHash: input.reviewedCoverLetterHash,
  }
  const manifest = buildApplicationSubmissionManifest(material, input.answersHash)
  if (!manifest || manifest.schemaVersion !== "agent-harness.application-submission.v2") {
    throw new SubmissionArtifactError("invalid_input", "Reviewed submission artifact manifest is malformed.")
  }
  return manifest
}

function sameArtifact(row: AgentArtifactRow, input: SubmissionArtifactInput, hash: string): boolean {
  return row.id === `application:${input.applicationTaskId}` && row.userId === input.userId && row.jobId === input.jobId &&
    row.artifactType === "application" && row.lifecycle === "base" && row.hash === hash
}

/** Creates an immutable, non-sensitive manifest consumed by application.submit. */
export async function ensureSubmissionArtifact(pool: Pool, input: SubmissionArtifactInput): Promise<AgentArtifactRow> {
  assertInput(input)
  const content = manifestFor(input)
  const hash = hashArtifactContent(content)
  const repository = createAgentArtifactRepository(pool)
  try {
    return await repository.insertBase({
      id: `application:${input.applicationTaskId}`,
      userId: input.userId,
      jobId: input.jobId,
      artifactType: "application",
      content,
      hash,
      constraintHash: hashArtifactContent({ applicationTaskId: input.applicationTaskId, jobId: input.jobId }),
      provenanceRefs: [`application-task:${input.applicationTaskId}`],
      evidenceRefs: [`application-task:${input.applicationTaskId}`],
    })
  } catch (error: unknown) {
    if (!isUniqueViolation(error)) throw error
    const existing = await repository.find(input.userId, `application:${input.applicationTaskId}`)
    if (existing && sameArtifact(existing, input, hash)) return existing
    throw new SubmissionArtifactError("conflict", "A different immutable submission artifact already exists for this task.")
  }
}

/** Idempotently creates the submission manifest on a caller-owned transaction. */
export async function ensureSubmissionArtifactWithClient(client: Pick<PoolClient, "query">, input: SubmissionArtifactInput): Promise<AgentArtifactRow> {
  assertInput(input)
  const content = manifestFor(input)
  const hash = hashArtifactContent(content)
  const row = await insertAgentArtifactBaseWithClient(client, {
    id: `application:${input.applicationTaskId}`, userId: input.userId, jobId: input.jobId, artifactType: "application", content, hash,
    constraintHash: hashArtifactContent({ applicationTaskId: input.applicationTaskId, jobId: input.jobId }),
    provenanceRefs: [`application-task:${input.applicationTaskId}`], evidenceRefs: [`application-task:${input.applicationTaskId}`],
  })
  if (!sameArtifact(row, input, hash)) throw new SubmissionArtifactError("conflict", "A different immutable submission artifact already exists for this task.")
  return row
}
