import { CanonicalJsonError, hashContent } from "@jobcopilot/shared"

export type ArtifactRef = {
  readonly id: string
  readonly type: string
  readonly version: number
  readonly hash: string
}

export type ArtifactRecord = ArtifactRef & {
  readonly content: unknown
  readonly sourceHash: string | null
  readonly writerTaskId: string
}

export type ArtifactEvidence = {
  readonly artifactHash: string
  readonly path: string
  readonly summary: string
}

export type ArtifactFinding = {
  readonly id: string
  readonly code: string
  readonly severity: "info" | "warning" | "error"
  readonly message: string
  readonly artifactHash: string
  readonly evidence: readonly ArtifactEvidence[]
}

export type ArtifactDraftInput = {
  readonly artifactId?: string
  readonly artifactType: string
  readonly content: unknown
  readonly sourceHash?: string | null
  readonly writerTaskId: string
  readonly expectedPreviousHash?: string | null
}

export interface ArtifactReader {
  read(id: string): Promise<ArtifactRecord | null>
}

export interface ArtifactDraftWriter extends ArtifactReader {
  writeDraft(input: ArtifactDraftInput): Promise<ArtifactRecord>
}

export class ArtifactAdapterError extends Error {
  constructor(readonly code: "invalid_artifact" | "not_found" | "stale_artifact", message: string) {
    super(message)
    this.name = "ArtifactAdapterError"
  }
}

export function hashArtifactContent(value: unknown): string {
  try {
    return hashContent(value)
  } catch (error: unknown) {
    if (error instanceof CanonicalJsonError) throw new ArtifactAdapterError("invalid_artifact", error.message)
    throw error
  }
}

export function artifactRef(record: ArtifactRecord): ArtifactRef {
  return { id: record.id, type: record.type, version: record.version, hash: record.hash }
}

export function validateFinding(finding: ArtifactFinding, expectedHash: string): void {
  if (!finding.id || !finding.code || !finding.message) throw new ArtifactAdapterError("invalid_artifact", "Artifact finding requires id, code, and message")
  if (finding.artifactHash !== expectedHash) throw new ArtifactAdapterError("stale_artifact", "Finding references a stale artifact hash")
  if (finding.evidence.length === 0) throw new ArtifactAdapterError("invalid_artifact", `Finding ${finding.id} has no evidence`)
  for (const evidence of finding.evidence) {
    if (evidence.artifactHash !== expectedHash || !evidence.path || !evidence.summary) {
      throw new ArtifactAdapterError("stale_artifact", `Finding ${finding.id} contains invalid evidence`)
    }
  }
}

export class InMemoryArtifactAdapter implements ArtifactDraftWriter {
  private readonly records = new Map<string, ArtifactRecord>()

  async read(id: string): Promise<ArtifactRecord | null> {
    return this.records.get(id) ?? null
  }

  async writeDraft(input: ArtifactDraftInput): Promise<ArtifactRecord> {
    if (!input.artifactType.trim() || !input.writerTaskId.trim()) throw new ArtifactAdapterError("invalid_artifact", "Artifact type and writer task are required")
    const id = input.artifactId?.trim() || `artifact-${this.records.size + 1}`
    const previous = this.records.get(id)
    if (previous && input.expectedPreviousHash !== undefined && input.expectedPreviousHash !== previous.hash) {
      throw new ArtifactAdapterError("stale_artifact", "Draft update was based on a stale artifact hash")
    }
    const record: ArtifactRecord = {
      id,
      type: input.artifactType,
      version: (previous?.version ?? 0) + 1,
      hash: hashArtifactContent(input.content),
      content: input.content,
      sourceHash: input.sourceHash ?? null,
      writerTaskId: input.writerTaskId,
    }
    this.records.set(id, record)
    return record
  }
}
