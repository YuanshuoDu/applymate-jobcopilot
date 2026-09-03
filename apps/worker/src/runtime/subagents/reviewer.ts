import { artifactRef, validateFinding, type ArtifactEvidence, type ArtifactFinding, type ArtifactReader, type ArtifactRef } from "./artifact-adapters.js"
import { assertRoleAction, assertTaskRole } from "./role-contracts.js"
import { roleProfile, type SubagentRoleProfile } from "./role-profiles.js"

export type ReviewDecision = "passed" | "needs_revision" | "rejected"
export type ReviewStatus = ReviewDecision | "stale"

export type ArtifactReview = {
  readonly artifact: ArtifactRef
  readonly status: ReviewStatus
  readonly findings: readonly ArtifactFinding[]
  readonly evidence: readonly ArtifactEvidence[]
  readonly reviewerTaskId: string
  readonly artifactHash: string
}

export type ReviewerTaskInput = {
  readonly task: { readonly id: string; readonly rootTaskId: string; readonly role: string }
  readonly artifactId: string
  readonly expectedArtifactHash?: string
  readonly decision: ReviewDecision
  readonly findings: readonly ArtifactFinding[]
  readonly evidence: readonly ArtifactEvidence[]
}

export type ReviewerResult = {
  readonly role: "reviewer"
  readonly taskId: string
  readonly rootTaskId: string
  readonly review: ArtifactReview
  readonly profile: SubagentRoleProfile
  readonly reviewOnly: true
}

export class ReviewContractError extends Error {
  constructor(readonly code: "artifact_not_found" | "stale_review" | "missing_evidence" | "invalid_review", message: string) {
    super(message)
    this.name = "ReviewContractError"
  }
}

export class ReviewerTaskHandler {
  constructor(private readonly artifacts: ArtifactReader) {}

  async run(input: ReviewerTaskInput): Promise<ReviewerResult> {
    assertTaskRole(input.task.role, "reviewer")
    assertRoleAction("reviewer", "artifact.review")
    if (!isReviewDecision(input.decision)) throw new ReviewContractError("invalid_review", "Reviewer returned an unsupported decision")
    const artifact = await this.artifacts.read(input.artifactId)
    if (!artifact) throw new ReviewContractError("artifact_not_found", `Artifact is unavailable: ${input.artifactId}`)
    if (input.expectedArtifactHash && input.expectedArtifactHash !== artifact.hash) {
      return this.result(input, artifactRef(artifact), "stale", [], [])
    }
    for (const finding of input.findings) validateFinding(finding, artifact.hash)
    if (input.evidence.length === 0) throw new ReviewContractError("missing_evidence", "A review requires artifact evidence")
    for (const evidence of input.evidence) {
      if (evidence.artifactHash !== artifact.hash || !evidence.path || !evidence.summary) {
        throw new ReviewContractError("invalid_review", "Review evidence does not match the artifact hash")
      }
    }
    if (input.decision === "passed" && input.findings.some(finding => finding.severity === "error")) {
      throw new ReviewContractError("invalid_review", "A review with error findings cannot pass")
    }
    if (input.decision === "needs_revision" && input.findings.length === 0) {
      throw new ReviewContractError("invalid_review", "A revision decision requires findings")
    }
    return this.result(input, artifactRef(artifact), input.decision, input.findings, input.evidence)
  }

  private result(input: ReviewerTaskInput, artifact: ArtifactRef, status: ReviewStatus, findings: readonly ArtifactFinding[], evidence: readonly ArtifactEvidence[]): ReviewerResult {
    return {
      role: "reviewer",
      taskId: input.task.id,
      rootTaskId: input.task.rootTaskId,
      review: { artifact, status, findings, evidence, reviewerTaskId: input.task.id, artifactHash: artifact.hash },
      profile: roleProfile("reviewer"),
      reviewOnly: true,
    }
  }
}

function isReviewDecision(value: string): value is ReviewDecision {
  return value === "passed" || value === "needs_revision" || value === "rejected"
}
