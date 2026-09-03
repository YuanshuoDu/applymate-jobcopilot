import type { ArtifactRecord, ArtifactRef } from "./artifact-adapters.js"
import { validateFinding, type ArtifactEvidence, type ArtifactFinding } from "./artifact-adapters.js"
import type { ArtifactReview, ReviewerResult } from "./reviewer.js"
import type { WriterDraftResult } from "./writer.js"

export type RootSubagentFailure = {
  readonly role: "writer" | "reviewer"
  readonly taskId: string
  readonly rootTaskId: string
  readonly status: "failed"
  readonly reason: string
}

export type RootChildResult = WriterDraftResult | ReviewerResult | RootSubagentFailure
export type RootAggregationStatus = "passed" | "needs_revision" | "blocked" | "failed"

export type EvidenceChainLink = {
  readonly artifactHash: string
  readonly writerTaskId: string
  readonly reviewerTaskId: string
  readonly evidence: readonly ArtifactEvidence[]
}

export type RootAggregation = {
  readonly rootTaskId: string
  readonly status: RootAggregationStatus
  readonly artifacts: readonly ArtifactRef[]
  readonly reviews: readonly ArtifactReview[]
  readonly findings: readonly ArtifactFinding[]
  readonly evidenceChain: readonly EvidenceChainLink[]
  readonly reasons: readonly string[]
}

export function invalidateStaleReview(review: ArtifactReview, current: ArtifactRecord): ArtifactReview {
  if (review.artifact.id !== current.id || review.artifactHash === current.hash) return review
  return {
    ...review,
    artifact: { id: current.id, type: current.type, version: current.version, hash: current.hash },
    artifactHash: current.hash,
    status: "stale",
    findings: [],
    evidence: [],
  }
}

export function aggregateRootResults(rootTaskId: string, results: readonly RootChildResult[]): RootAggregation {
  const reasons: string[] = []
  const writers = results.filter((result): result is WriterDraftResult => result.role === "writer" && "artifact" in result)
  const reviewers = results.filter((result): result is ReviewerResult => result.role === "reviewer" && "review" in result)
  const failures = results.filter((result): result is RootSubagentFailure => "status" in result && result.status === "failed")
  const artifacts = writers.map(result => result.artifact)
  const reviews = reviewers.map(result => result.review)

  if (results.some(result => result.rootTaskId !== rootTaskId)) reasons.push("A child result belongs to another root task")
  if (failures.length > 0) reasons.push(...failures.map(failure => `${failure.role} failed: ${failure.reason}`))
  if (writers.length === 0) reasons.push("No Writer draft was produced")
  if (reviewers.length === 0) reasons.push("No Reviewer result was produced")

  const writerByArtifact = new Map(writers.map(result => [result.artifact.id, result]))
  const evidenceChain: EvidenceChainLink[] = []
  const findings: ArtifactFinding[] = []
  for (const review of reviews) {
    const writer = writerByArtifact.get(review.artifact.id)
    if (!writer || writer.artifact.hash !== review.artifactHash || review.status === "stale") {
      reasons.push(`Review for ${review.artifact.id} is stale or has no matching Writer artifact`)
      continue
    }
    if (review.status === "passed" && review.evidence.length === 0) reasons.push(`Review ${review.reviewerTaskId} passed without evidence`)
    for (const finding of review.findings) {
      try { validateFinding(finding, review.artifactHash); findings.push(finding) } catch { reasons.push(`Finding ${finding.id} does not prove the reviewed artifact`) }
    }
    evidenceChain.push({ artifactHash: review.artifactHash, writerTaskId: writer.taskId, reviewerTaskId: review.reviewerTaskId, evidence: review.evidence })
  }

  const status: RootAggregationStatus = reasons.length > 0 || failures.length > 0
    ? failures.length > 0 ? "failed" : "blocked"
    : reviews.some(review => review.status === "needs_revision" || review.status === "rejected") ? "needs_revision" : "passed"
  return { rootTaskId, status, artifacts, reviews, findings, evidenceChain, reasons }
}
