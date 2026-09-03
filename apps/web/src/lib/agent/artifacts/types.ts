export type ArtifactKind = 'resume' | 'cover_letter'
export type ArtifactLifecycle = 'base' | 'draft' | 'approved' | 'stale'
export type ArtifactReviewStatus = 'passed' | 'needs_revision' | 'rejected' | 'stale'

export type ArtifactProvenance = {
  readonly sourceType: 'resume' | 'persona_fact' | 'persona_evidence'
  readonly sourceRef: string
  readonly evidenceHash: string
}

export type ArtifactSummary = {
  readonly id: string
  readonly kind: ArtifactKind
  readonly lifecycle: ArtifactLifecycle
  readonly version: number
  readonly hash: string
  readonly baseArtifactId: string
  readonly baseHash: string
  readonly constraintHash: string
  readonly provenance: readonly ArtifactProvenance[]
}

export type VersionedArtifact<T = unknown> = ArtifactSummary & {
  readonly content: T
  readonly createdBy: string
  readonly parentArtifactId: string | null
  readonly staleReason: string | null
}

export type ArtifactReview = {
  readonly id: string
  readonly artifactId: string
  readonly artifactHash: string
  readonly status: ArtifactReviewStatus
  readonly reviewerId: string
  readonly evidence: readonly ArtifactProvenance[]
  readonly constraintHash: string
  readonly findings: readonly string[]
}

export type ArtifactConstraintSet = {
  readonly jobId: string
  readonly role: string
  readonly company: string
  readonly targetRoles?: readonly string[]
  readonly targetLocations?: readonly string[]
  readonly excludeCompanies?: readonly string[]
  readonly priorityCompanies?: readonly string[]
  readonly minMatchScore?: number
  readonly coverTone?: string
}

export type ArtifactItemData = {
  readonly artifactId: string
  readonly artifactType: ArtifactKind
  readonly lifecycle: ArtifactLifecycle
  readonly version: number
  readonly hash: string
  readonly baseHash: string
  readonly constraintHash: string
  readonly provenanceRefs: readonly string[]
  readonly reviewHash?: string
  readonly reviewStatus?: ArtifactReviewStatus
}
