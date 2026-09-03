import { assertValidProvenance, buildArtifactProvenance, type EvidenceInput } from './provenance'
import type { ArtifactReview, ArtifactSummary, ArtifactReviewStatus } from './types'

export class ArtifactReviewError extends Error {
  readonly code: 'stale_hash' | 'invalid_review'

  constructor(code: ArtifactReviewError['code'], message: string) {
    super(message)
    this.name = 'ArtifactReviewError'
    this.code = code
  }
}

export type ArtifactPreflight = { readonly ok: boolean; readonly issues: readonly string[] }

export function preflightArtifact(artifact: ArtifactSummary, constraintHash: string): ArtifactPreflight {
  const issues: string[] = []
  if (artifact.lifecycle !== 'draft') issues.push('artifact_not_draft')
  if (artifact.constraintHash !== constraintHash) issues.push('stale_constraints')
  if (!/^sha256:[a-f0-9]{64}$/.test(artifact.hash)) issues.push('invalid_artifact_hash')
  if (!/^sha256:[a-f0-9]{64}$/.test(artifact.baseHash)) issues.push('invalid_base_hash')
  if (artifact.provenance.length === 0) issues.push('missing_provenance')
  return { ok: issues.length === 0, issues }
}

export function reviewArtifact(input: {
  readonly artifact: ArtifactSummary
  readonly expectedHash: string
  readonly reviewerId: string
  readonly decision: Exclude<ArtifactReviewStatus, 'stale'>
  readonly evidence: readonly EvidenceInput[]
  readonly constraintHash: string
  readonly findings?: readonly string[]
}): ArtifactReview {
  if (input.artifact.hash !== input.expectedHash) throw new ArtifactReviewError('stale_hash', 'Review is bound to a stale artifact hash.')
  if (input.artifact.constraintHash !== input.constraintHash) throw new ArtifactReviewError('stale_hash', 'Review is bound to stale tailoring constraints.')
  const reviewEvidence = input.evidence.length ? buildArtifactProvenance(input.evidence) : input.artifact.provenance
  assertValidProvenance(reviewEvidence)
  if (input.evidence.length && reviewEvidence.some(item => !input.artifact.provenance.some(ref => ref.sourceRef === item.sourceRef && ref.evidenceHash === item.evidenceHash))) {
    throw new ArtifactReviewError('invalid_review', 'Review evidence is not part of the artifact provenance chain.')
  }
  if (input.decision === 'passed' && (input.findings ?? []).some(finding => /unsupported|stale|invalid/i.test(finding))) {
    throw new ArtifactReviewError('invalid_review', 'A passing review cannot contain an unresolved provenance or stale finding.')
  }
  return {
    id: `review:${input.artifact.id}:${input.artifact.version}:${input.expectedHash.slice(-12)}`,
    artifactId: input.artifact.id,
    artifactHash: input.expectedHash,
    status: input.decision,
    reviewerId: input.reviewerId,
    evidence: reviewEvidence,
    constraintHash: input.constraintHash,
    findings: [...(input.findings ?? [])],
  }
}

export function reviewIsCurrent(review: ArtifactReview, artifact: ArtifactSummary, constraintHash: string): boolean {
  return review.artifactId === artifact.id && review.artifactHash === artifact.hash && review.constraintHash === constraintHash && review.status !== 'stale'
}
