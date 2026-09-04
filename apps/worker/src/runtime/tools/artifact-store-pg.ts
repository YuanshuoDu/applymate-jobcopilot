import type { Pool } from "pg"
import { hashArtifactContent } from "../subagents/artifact-adapters.js"
import { createAgentArtifactRepository, AgentArtifactRepositoryError, type AgentArtifactRow } from "../../db/agent-artifact-repo.js"
import { ArtifactToolError, type ArtifactBaseInput, type ArtifactToolRecord, type ArtifactToolStore, type ArtifactToolDraftInput } from "./artifact-tools.js"

function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "23505")
}

function mapError(error: unknown): never {
  if (error instanceof AgentArtifactRepositoryError) throw new ArtifactToolError(error.code, error.message)
  if (isUniqueViolation(error)) throw new ArtifactToolError("stale_hash", "A base artifact cannot be overwritten.")
  throw error
}

function toRecord(row: AgentArtifactRow): ArtifactToolRecord {
  if (row.artifactType !== "resume" && row.artifactType !== "cover_letter") {
    throw new ArtifactToolError("precondition_failed", "The database returned an unsupported artifact type.")
  }
  return {
    id: row.id,
    type: row.artifactType,
    lifecycle: row.lifecycle,
    version: row.version,
    hash: row.hash,
    baseArtifactId: row.baseId ?? row.id,
    baseHash: row.baseHash ?? row.hash,
    constraintHash: row.constraintHash,
    provenanceRefs: [...row.provenanceRefs],
    content: row.content,
    ownerUserId: row.userId,
    jobId: row.jobId,
  }
}

export class PgArtifactToolStore implements ArtifactToolStore {
  private readonly repository

  constructor(pool: Pool) {
    this.repository = createAgentArtifactRepository(pool)
  }

  async read(userId: string, artifactId: string): Promise<ArtifactToolRecord | null> {
    const row = await this.repository.find(userId, artifactId)
    return row ? toRecord(row) : null
  }

  async registerBase(input: ArtifactBaseInput): Promise<ArtifactToolRecord> {
    if (!input.id.trim() || !input.userId.trim() || !input.jobId.trim()) throw new ArtifactToolError("precondition_failed", "Base artifact identity is required.")
    if (input.type !== "resume" && input.type !== "cover_letter") throw new ArtifactToolError("precondition_failed", "Unsupported artifact type.")
    try {
      const hash = hashArtifactContent(input.content)
      const row = await this.repository.insertBase({
        id: input.id,
        userId: input.userId,
        jobId: input.jobId,
        artifactType: input.type,
        content: input.content,
        hash,
        constraintHash: input.constraintHash ?? hash,
        provenanceRefs: [`${input.type}:${input.id}`],
        evidenceRefs: [`${input.type}:${input.id}`],
      })
      return toRecord(row)
    } catch (error: unknown) {
      return mapError(error)
    }
  }

  async writeDraft(userId: string, input: ArtifactToolDraftInput & { type: ArtifactToolRecord["type"] }): Promise<ArtifactToolRecord> {
    const base = await this.read(userId, input.baseArtifactId)
    if (!base) throw new ArtifactToolError("not_found", "Artifact is not available in the current tenant.")
    if (base.lifecycle !== "base" || base.hash !== input.baseHash || base.type !== input.type) throw new ArtifactToolError("stale_hash", "Draft base hash is stale or unavailable.")
    if (input.evidence.length === 0) throw new ArtifactToolError("invalid_provenance", "Draft requires evidence.")
    const id = input.artifactId ?? `${input.type}:${input.baseArtifactId}`
    const previous = await this.read(userId, id)
    if (previous?.lifecycle === "base") throw new ArtifactToolError("precondition_failed", "A base artifact cannot be replaced by a draft.")
    if (previous && input.expectedPreviousHash !== undefined && input.expectedPreviousHash !== previous.hash) throw new ArtifactToolError("precondition_failed", "Draft update has a stale previous hash.")
    if (!base.jobId) throw new ArtifactToolError("precondition_failed", "Base artifact is missing its job scope.")
    try {
      const row = await this.repository.saveDraft({
        id,
        userId,
        jobId: base.jobId,
        artifactType: input.type,
        content: input.content,
        hash: hashArtifactContent(input.content),
        constraintHash: hashArtifactContent(input.constraints),
        provenanceRefs: input.evidence.map(entry => entry.sourceRef),
        evidenceRefs: input.evidence.map(entry => entry.sourceRef),
        baseId: input.baseArtifactId,
        baseHash: input.baseHash,
        previousHash: previous?.hash ?? null,
        expectedPreviousHash: input.expectedPreviousHash,
      })
      return toRecord(row)
    } catch (error: unknown) {
      return mapError(error)
    }
  }

  async listForUser(userId: string, jobId: string): Promise<ArtifactToolRecord[]> {
    const rows = await this.repository.list(userId, jobId)
    return rows.map(toRecord)
  }
}
