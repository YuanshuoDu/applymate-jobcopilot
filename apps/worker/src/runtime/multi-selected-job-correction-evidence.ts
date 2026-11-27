import type { AgentArtifactReviewReceipt, AgentArtifactReviewReceiptScope } from "../db/agent-artifact-repo.js"
import type { TaskGraphArtifactProjectionReference, TaskGraphCurrentNode } from "./subagents/task-graph-command-port.js"
import { writerReviewDependencyFromTaskContext } from "./subagents/task-graph-writer-review-feedback.js"

const SHA256 = /^sha256:[a-f0-9]{64}$/
export type SelectedJobBatchArtifactVersion = Readonly<{
  artifactId: string; artifactType: "cover_letter"; taskId: string; version: number
  contentHash: string; sourceDigest: string; previousHash: string | null
}>
export type SelectedJobBatchCorrectionPriorEvidence = Readonly<{
  writerTaskId: string; reviewerTaskId: string; artifactRef: TaskGraphArtifactProjectionReference
  artifactVersion: SelectedJobBatchArtifactVersion; reviewStatus: "needs_revision"; reviewHash: string
  reviewReceipt: Readonly<Pick<AgentArtifactReviewReceipt, "taskId" | "artifactId" | "version" | "contentHash" | "sourceDigest" | "currentSourceDigest" | "status" | "reviewHash">>
}>
export type SelectedJobBatchArtifactVersionScope = Readonly<{
  userId: string; sessionId: string; jobId: string; artifactId: string; taskId: string; version: number
}>

/** Validates the exact prior Reviewer receipt and the correction Writer's private dependency context. */
export async function readSelectedJobBatchCorrectionPriorEvidence(input: Readonly<{
  userId: string; sessionId: string; jobId: string; writer: TaskGraphCurrentNode; reviewer: TaskGraphCurrentNode
  correctionWriterContext: unknown; requireWriterDependency: boolean
  readCurrentSourceDigest(jobId: string): Promise<string | null>
  readArtifactVersion(scope: SelectedJobBatchArtifactVersionScope): Promise<SelectedJobBatchArtifactVersion | null>
  readCurrentReviewReceipt(scope: AgentArtifactReviewReceiptScope): Promise<AgentArtifactReviewReceipt | null>
}>): Promise<SelectedJobBatchCorrectionPriorEvidence | undefined> {
  try {
    const artifactRef = projection(input.writer, "writer"), reviewerRef = projection(input.reviewer, "reviewer")
    const review = input.reviewer.resultProjection
    if (!artifactRef || !reviewerRef || !sameArtifact(artifactRef, reviewerRef) || !review || review.availability !== "available" || review.role !== "reviewer"
      || review.reviewStatus !== "needs_revision" || !SHA256.test(review.reviewHash)
      || !input.writer.taskId || !input.reviewer.taskId) return undefined
    if (input.requireWriterDependency || hasDependencyContext(input.correctionWriterContext)) {
      const dependency = writerReviewDependencyFromTaskContext(input.correctionWriterContext, input.jobId)
      if (!dependency || dependency.dependencyTaskId !== input.reviewer.taskId || dependency.reviewHash !== review.reviewHash
        || !sameArtifact(dependency.artifactRef, artifactRef)) return undefined
    }
    const source = await input.readCurrentSourceDigest(input.jobId)
    if (source !== artifactRef.sourceDigest) return undefined
    const versionScope: SelectedJobBatchArtifactVersionScope = {
      userId: input.userId, sessionId: input.sessionId, jobId: input.jobId,
      artifactId: artifactRef.artifactId, taskId: input.writer.taskId, version: artifactRef.version,
    }
    const artifactVersion = await input.readArtifactVersion(versionScope)
    if (!sameVersion(artifactVersion, artifactRef, input.writer.taskId)) return undefined
    const scope: AgentArtifactReviewReceiptScope = {
      ...versionScope, contentHash: artifactRef.contentHash, sourceDigest: artifactRef.sourceDigest,
      currentSourceDigest: source, status: "needs_revision", taskId: input.reviewer.taskId, reviewHash: review.reviewHash,
    }
    const reviewReceipt = receipt(await input.readCurrentReviewReceipt(scope), scope)
    return reviewReceipt && await input.readCurrentSourceDigest(input.jobId) === source
      ? { writerTaskId: input.writer.taskId, reviewerTaskId: input.reviewer.taskId, artifactRef, artifactVersion,
        reviewStatus: "needs_revision", reviewHash: review.reviewHash, reviewReceipt }
      : undefined
  } catch { return undefined }
}

/** A correction must extend the exact prior version, not replace its artifact or source. */
export function isSelectedJobBatchCorrectionSuccessor(
  prior: SelectedJobBatchCorrectionPriorEvidence, current: SelectedJobBatchArtifactVersion,
): boolean {
  return current.artifactId === prior.artifactRef.artifactId && current.sourceDigest === prior.artifactRef.sourceDigest
    && current.artifactType === "cover_letter" && !!current.taskId && current.taskId !== prior.writerTaskId
    && current.version === prior.artifactRef.version + 1 && current.previousHash === prior.artifactRef.contentHash
}

function projection(node: TaskGraphCurrentNode, role: "writer" | "reviewer"): TaskGraphArtifactProjectionReference | undefined {
  const value = node.resultProjection
  if (node.status !== "completed" || !value || value.availability !== "available" || value.role !== role) return undefined
  const ref = value.artifactRef
  return ref && typeof ref.artifactId === "string" && ref.artifactId.trim() && Number.isSafeInteger(ref.version) && ref.version > 0
    && SHA256.test(ref.contentHash) && SHA256.test(ref.sourceDigest) ? ref : undefined
}
function sameArtifact(left: TaskGraphArtifactProjectionReference, right: TaskGraphArtifactProjectionReference): boolean {
  return left.artifactId === right.artifactId && left.version === right.version
    && left.contentHash === right.contentHash && left.sourceDigest === right.sourceDigest
}
function sameVersion(version: SelectedJobBatchArtifactVersion | null, ref: TaskGraphArtifactProjectionReference, taskId: string): version is SelectedJobBatchArtifactVersion {
  return !!version && version.artifactId === ref.artifactId && version.version === ref.version
    && version.artifactType === "cover_letter" && version.taskId === taskId
    && version.contentHash === ref.contentHash && version.sourceDigest === ref.sourceDigest
    && (version.previousHash === null || SHA256.test(version.previousHash))
}
function hasDependencyContext(value: unknown): boolean {
  if (typeof value === "string") { try { value = JSON.parse(value) as unknown } catch { return true } }
  return !!value && typeof value === "object" && !Array.isArray(value) && Object.hasOwn(value, "taskGraphDependencyResults")
}
function receipt(value: AgentArtifactReviewReceipt | null, scope: AgentArtifactReviewReceiptScope) {
  if (!value || value.userId !== scope.userId || value.sessionId !== scope.sessionId || value.jobId !== scope.jobId
    || value.artifactId !== scope.artifactId || value.version !== scope.version || value.contentHash !== scope.contentHash
    || value.sourceDigest !== scope.sourceDigest || value.currentSourceDigest !== scope.currentSourceDigest
    || value.status !== scope.status || value.taskId !== scope.taskId || value.reviewHash !== scope.reviewHash) return undefined
  return { taskId: value.taskId, artifactId: value.artifactId, version: value.version, contentHash: value.contentHash,
    sourceDigest: value.sourceDigest, currentSourceDigest: value.currentSourceDigest, status: value.status, reviewHash: value.reviewHash }
}
