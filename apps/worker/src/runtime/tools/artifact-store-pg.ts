import type { Pool } from "pg"
import { hashArtifactContent } from "../subagents/artifact-adapters.js"
import { createAgentArtifactRepository, AgentArtifactRepositoryError, type AgentArtifactRow, type AgentArtifactVersionRow, type AgentArtifactReviewRow, type AgentArtifactReviewWrite } from "../../db/agent-artifact-repo.js"
import { ArtifactToolError, type ArtifactBaseInput, type ArtifactToolRecord, type ArtifactToolStore, type ArtifactToolDraftInput, type ArtifactToolScope, type ArtifactVersionRef } from "./artifact-tools.js"

function isUniqueViolation(error: unknown): boolean { return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "23505") }
function mapError(error: unknown): never {
  if (error instanceof AgentArtifactRepositoryError) throw new ArtifactToolError(error.code, error.message)
  if (isUniqueViolation(error)) throw new ArtifactToolError("stale_hash", "A base artifact cannot be overwritten.")
  throw error
}
function toRecord(row: AgentArtifactRow): ArtifactToolRecord {
  if (row.artifactType !== "resume" && row.artifactType !== "cover_letter" && row.artifactType !== "application") throw new ArtifactToolError("precondition_failed", "The database returned an unsupported artifact type.")
  return { id: row.id, type: row.artifactType, lifecycle: row.lifecycle, version: row.version, hash: row.hash, baseArtifactId: row.baseId ?? row.id, baseHash: row.baseHash ?? row.hash, constraintHash: row.constraintHash, provenanceRefs: [...row.provenanceRefs], content: row.content, ownerUserId: row.userId, jobId: row.jobId }
}

export class PgArtifactToolStore implements ArtifactToolStore {
  private readonly repository
  constructor(pool: Pool) { this.repository = createAgentArtifactRepository(pool) }

  async read(userId: string, artifactId: string): Promise<ArtifactToolRecord | null> {
    const row = await this.repository.find(userId, artifactId)
    return row ? toRecord(row) : null
  }

  async registerBase(input: ArtifactBaseInput): Promise<ArtifactToolRecord> {
    if (!input.id.trim() || !input.userId.trim() || !input.jobId.trim() || (input.type !== "resume" && input.type !== "cover_letter")) throw new ArtifactToolError("precondition_failed", "Base artifact identity is invalid.")
    try {
      const hash = hashArtifactContent(input.content)
      const row = await this.repository.insertBase({ id: input.id, userId: input.userId, jobId: input.jobId, artifactType: input.type, content: input.content, hash, constraintHash: input.constraintHash ?? hash, provenanceRefs: [input.id], evidenceRefs: [input.id] })
      return toRecord(row)
    } catch (error: unknown) { return mapError(error) }
  }

  async writeDraft(scope: ArtifactToolScope, input: ArtifactToolDraftInput & { requestHash: string }): Promise<AgentArtifactVersionRow> {
    const base = await this.read(scope.userId, input.baseArtifactId)
    if (!base || base.lifecycle !== "base" || base.type !== "cover_letter" || base.hash !== input.baseHash || base.jobId !== scope.jobId) throw new ArtifactToolError("stale_hash", "Selected-job cover-letter base is stale or unavailable.")
    if (scope.evidenceRefs.length === 0) throw new ArtifactToolError("invalid_provenance", "Draft requires source evidence.")
    const id = `cover-letter:${hashArtifactContent({ userId: scope.userId, jobId: scope.jobId }).slice(7)}`
    const previous = await this.read(scope.userId, id)
    try {
      return await this.repository.saveDraft({
        id, userId: scope.userId, jobId: scope.jobId, artifactType: "cover_letter", sessionId: scope.sessionId,
        content: input.content, hash: hashArtifactContent(input.content), constraintHash: hashArtifactContent(input.constraints),
        provenanceRefs: [...scope.evidenceRefs], evidenceRefs: [...scope.evidenceRefs], baseId: base.id, baseHash: base.hash,
        previousHash: previous?.hash ?? null, sourceDigest: scope.sourceDigest, taskId: scope.taskId, toolCallId: scope.toolCallId,
        requestHash: input.requestHash, taskFence: scope.taskFence, expectedPreviousHash: input.expectedPreviousHash,
      })
    } catch (error: unknown) { return mapError(error) }
  }

  async readVersion(scope: Pick<ArtifactToolScope, "userId" | "sessionId" | "jobId">, ref: ArtifactVersionRef): Promise<AgentArtifactVersionRow | null> {
    return this.repository.findVersion({ ...scope, artifactId: ref.artifactId, version: ref.version })
  }

  async saveReview(input: Omit<AgentArtifactReviewRow, "id" | "artifactVersionId" | "createdAt"> & { readonly taskFence: AgentArtifactReviewWrite["taskFence"] }): Promise<AgentArtifactReviewRow> {
    try { return await this.repository.saveReview(input as AgentArtifactReviewWrite) } catch (error: unknown) { return mapError(error) }
  }

  async findReview(scope: Pick<ArtifactToolScope, "userId" | "sessionId" | "jobId">, ref: ArtifactVersionRef): Promise<AgentArtifactReviewRow | null> {
    return this.repository.findReview({ ...scope, artifactId: ref.artifactId, version: ref.version, contentHash: ref.contentHash, sourceDigest: ref.sourceDigest })
  }

  async listForUser(userId: string, jobId: string): Promise<ArtifactToolRecord[]> { return (await this.repository.list(userId, jobId)).map(toRecord) }
}
