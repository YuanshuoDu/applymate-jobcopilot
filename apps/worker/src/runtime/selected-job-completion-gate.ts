import type { TaskGraphArtifactProjectionReference, TaskGraphCommandPort, TaskGraphReadScope } from "./subagents/task-graph-command-port.js"
import { TASK_GRAPH_RESULT_PROJECTION_SCHEMA } from "./subagents/task-graph-command-port.js"
import type { SubagentTaskRecord } from "./subagents/types.js"
import type { TurnLease } from "./turns/lease.js"
import type { TurnEngineCompletionGateResult } from "./turns/turn-execution-types.js"

const WRITER_TEMPLATE_ID = "cover_letter_writer"
const REVIEWER_TEMPLATE_ID = "cover_letter_reviewer"
const ARTIFACT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const SHA256 = /^sha256:[a-f0-9]{64}$/
const BLOCKED: TurnEngineCompletionGateResult = Object.freeze({
  ok: false,
  blocker: "selected_job_draft_review_required",
  feedback: "Complete and review the selected job's latest cover-letter draft before finishing.",
})

type ArtifactReference = TaskGraphArtifactProjectionReference
type GraphNode = Readonly<{
  key: string
  templateId: string
  status: string
  dependsOn: readonly string[]
  resultProjection?: unknown
}>
type WriterNode = Readonly<{ key: string; artifactRef: ArtifactReference }>
type ReviewerNode = Readonly<{ dependsOn: readonly string[]; artifactRef: ArtifactReference; reviewStatus: string }>

function plainRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  try {
    const prototype = Object.getPrototypeOf(value)
    return (prototype === Object.prototype || prototype === null) && Object.getOwnPropertySymbols(value).length === 0
      ? value as Record<string, unknown>
      : undefined
  } catch { return undefined }
}

function exactKeys(value: Record<string, unknown>, expected: string): boolean {
  const keys = Reflect.ownKeys(value)
  return keys.every((key): key is string => typeof key === "string") && keys.sort().join(",") === expected
}

function artifactReference(value: unknown): ArtifactReference | undefined {
  const row = plainRecord(value)
  if (!row || !exactKeys(row, "artifactId,contentHash,sourceDigest,version")
    || typeof row.artifactId !== "string" || !ARTIFACT_ID.test(row.artifactId)
    || !Number.isSafeInteger(row.version) || Number(row.version) < 1
    || typeof row.contentHash !== "string" || !SHA256.test(row.contentHash)
    || typeof row.sourceDigest !== "string" || !SHA256.test(row.sourceDigest)) return undefined
  return { artifactId: row.artifactId, version: Number(row.version), contentHash: row.contentHash, sourceDigest: row.sourceDigest }
}

function sameArtifact(left: ArtifactReference, right: ArtifactReference): boolean {
  return left.artifactId === right.artifactId && left.version === right.version
    && left.contentHash === right.contentHash && left.sourceDigest === right.sourceDigest
}

function graphNodes(value: unknown): GraphNode[] | undefined {
  const state = plainRecord(value)
  if (!state || !Number.isSafeInteger(state.revision) || Number(state.revision) < 0
    || !Array.isArray(state.nodes) || state.nodes.length > 16) return undefined
  const nodes: GraphNode[] = []
  const keys = new Set<string>()
  for (const item of state.nodes) {
    const row = plainRecord(item)
    if (!row || typeof row.key !== "string" || !row.key.trim() || row.key.length > 128
      || typeof row.templateId !== "string" || !row.templateId.trim() || row.templateId.length > 128
      || typeof row.status !== "string" || !Array.isArray(row.dependsOn)
      || row.dependsOn.some(key => typeof key !== "string" || !key.trim() || key.length > 128)
      || keys.has(row.key)) return undefined
    keys.add(row.key)
    nodes.push({ key: row.key, templateId: row.templateId, status: row.status, dependsOn: row.dependsOn as string[], resultProjection: row.resultProjection })
  }
  if (nodes.some(node => node.dependsOn.some(key => !keys.has(key)))) return undefined
  return nodes
}

function writerProjection(node: GraphNode): ArtifactReference | undefined {
  const row = plainRecord(node.resultProjection)
  if (!row || !exactKeys(row, "artifactRef,availability,role,schemaVersion,status,trust")
    || row.schemaVersion !== TASK_GRAPH_RESULT_PROJECTION_SCHEMA || row.trust !== "untrusted"
    || row.availability !== "available" || row.role !== "writer" || row.status !== "completed") return undefined
  return artifactReference(row.artifactRef)
}

function reviewerProjection(node: GraphNode): Omit<ReviewerNode, "dependsOn"> | undefined {
  const row = plainRecord(node.resultProjection)
  if (!row || !exactKeys(row, "artifactRef,availability,reviewHash,reviewStatus,role,schemaVersion,status,trust")
    || row.schemaVersion !== TASK_GRAPH_RESULT_PROJECTION_SCHEMA || row.trust !== "untrusted"
    || row.availability !== "available" || row.role !== "reviewer" || row.status !== "completed"
    || typeof row.reviewHash !== "string" || !SHA256.test(row.reviewHash)
    || !["passed", "needs_revision", "rejected", "stale"].includes(String(row.reviewStatus))) return undefined
  const artifactRef = artifactReference(row.artifactRef)
  return artifactRef ? { artifactRef, reviewStatus: String(row.reviewStatus) } : undefined
}

function hasLatestReviewedDraft(value: unknown): boolean {
  const nodes = graphNodes(value)
  if (!nodes) return false
  const writers: WriterNode[] = []
  const reviewers: ReviewerNode[] = []

  for (const node of nodes) {
    const projectionRole = plainRecord(node.resultProjection)?.role
    const writerCandidate = node.templateId === WRITER_TEMPLATE_ID || projectionRole === "writer"
    const reviewerCandidate = node.templateId === REVIEWER_TEMPLATE_ID || projectionRole === "reviewer"
    if (writerCandidate && reviewerCandidate) return false
    if (node.status !== "completed") continue
    if (writerCandidate) {
      const artifactRef = writerProjection(node)
      if (node.templateId !== WRITER_TEMPLATE_ID || !artifactRef) return false
      writers.push({ key: node.key, artifactRef })
    }
    if (reviewerCandidate) {
      const projection = reviewerProjection(node)
      if (node.templateId !== REVIEWER_TEMPLATE_ID || !projection || projection.reviewStatus === "stale") return false
      reviewers.push({ ...projection, dependsOn: node.dependsOn })
    }
  }
  if (writers.length === 0 || reviewers.length === 0) return false

  const latestByArtifact = new Map<string, WriterNode[]>()
  for (const writer of writers) {
    const current = latestByArtifact.get(writer.artifactRef.artifactId) ?? []
    const maxVersion = current[0]?.artifactRef.version ?? 0
    if (writer.artifactRef.version > maxVersion) latestByArtifact.set(writer.artifactRef.artifactId, [writer])
    else if (writer.artifactRef.version === maxVersion) {
      if (current.some(existing => !sameArtifact(existing.artifactRef, writer.artifactRef))) return false
      current.push(writer)
      latestByArtifact.set(writer.artifactRef.artifactId, current)
    }
  }

  return [...latestByArtifact.values()].flat().every(writer => reviewers.some(reviewer =>
    reviewer.dependsOn.includes(writer.key) && sameArtifact(reviewer.artifactRef, writer.artifactRef)))
}

/** Requires a persisted, exact-version review for every latest selected-job draft. */
export async function selectedJobArtifactCompletionGate(input: {
  readonly commandPort: TaskGraphCommandPort | undefined
  readonly lease: TurnLease
  readonly root: Pick<SubagentTaskRecord, "id" | "attemptCount">
}): Promise<TurnEngineCompletionGateResult> {
  if (!input.commandPort) return BLOCKED
  const scope: TaskGraphReadScope = {
    userId: input.lease.userId,
    sessionId: input.lease.sessionId,
    turnId: input.lease.turnId,
    rootTaskId: input.root.id,
    parentTaskId: input.root.id,
    turnLeaseOwner: input.lease.ownerId,
    turnLeaseVersion: input.lease.leaseVersion,
    parentLeaseOwner: input.lease.ownerId,
    parentAttemptCount: input.root.attemptCount,
  }
  try {
    return hasLatestReviewedDraft(await input.commandPort.readCurrent(scope)) ? { ok: true } : BLOCKED
  } catch {
    return BLOCKED
  }
}
