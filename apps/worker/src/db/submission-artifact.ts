import type { Pool } from "pg"

import { hashArtifactContent } from "../runtime/subagents/artifact-adapters.js"
import { createAgentArtifactRepository, type AgentArtifactRow } from "./agent-artifact-repo.js"

export type SubmissionArtifactInput = {
  readonly applicationTaskId: string
  readonly userId: string
  readonly jobId: string
  readonly resumeId: string | null
  readonly coverLetterId: string | null
  readonly answersHash: string
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

function sameArtifact(row: AgentArtifactRow, input: SubmissionArtifactInput, hash: string): boolean {
  return row.id === `application:${input.applicationTaskId}` && row.userId === input.userId && row.jobId === input.jobId &&
    row.artifactType === "application" && row.lifecycle === "base" && row.hash === hash
}

/** Creates an immutable, non-sensitive manifest consumed by application.submit. */
export async function ensureSubmissionArtifact(pool: Pool, input: SubmissionArtifactInput): Promise<AgentArtifactRow> {
  assertInput(input)
  const content = {
    schemaVersion: "agent-harness.application-submission.v1",
    applicationTaskId: input.applicationTaskId,
    jobId: input.jobId,
    resumeId: input.resumeId,
    coverLetterId: input.coverLetterId,
    answersHash: input.answersHash,
  }
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
