import type { ArtifactItemData, ArtifactReview, ArtifactSummary } from './types'

/** Safe typed Item payload: refs and hashes only, never raw resume/letter text. */
export function artifactItemData(artifact: ArtifactSummary, review?: ArtifactReview): ArtifactItemData {
  return {
    artifactId: artifact.id,
    artifactType: artifact.kind,
    lifecycle: artifact.lifecycle,
    version: artifact.version,
    hash: artifact.hash,
    baseHash: artifact.baseHash,
    constraintHash: artifact.constraintHash,
    provenanceRefs: artifact.provenance.map(item => item.sourceRef),
    ...(review ? { reviewHash: review.artifactHash, reviewStatus: review.status } : {}),
  }
}
