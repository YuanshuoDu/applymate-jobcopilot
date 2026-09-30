import type { TaskGraphArtifactProjectionReference, TaskGraphCommandPort, TaskGraphCurrentState, TaskGraphReadScope } from "./subagents/task-graph-command-port.js"
import { TASK_GRAPH_RESULT_PROJECTION_SCHEMA } from "./subagents/task-graph-command-port.js"
import type { SubagentTaskRecord } from "./subagents/types.js"
import type { TurnLease } from "./turns/lease.js"
import type { TurnEngineCompletionGateResult } from "./turns/turn-execution-types.js"
import type {
  AgentArtifactDraftHead, AgentArtifactDraftHeadScope, AgentArtifactReviewReceipt, AgentArtifactReviewReceiptScope,
} from "../db/agent-artifact-repo.js"

const WRITER_TEMPLATE_ID = "cover_letter_writer"
const REVIEWER_TEMPLATE_ID = "cover_letter_reviewer"
const ARTIFACT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const SHA256 = /^sha256:[a-f0-9]{64}$/
const BLOCKED: Extract<TurnEngineCompletionGateResult, { ok: false }> = Object.freeze({
  ok: false,
  blocker: "selected_job_draft_review_required",
  feedback: "Complete and review the selected job's latest cover-letter draft before finishing.",
})

type ArtifactReference = TaskGraphArtifactProjectionReference
export type SelectedJobCompletionGraphWitness = Readonly<Pick<TaskGraphCurrentState, "revision" | "nodes">>
type GraphNode = Readonly<{
  key: string; taskId: string; templateId: string; status: string
  dependsOn: readonly string[]; resultProjection?: unknown
}>
type WriterNode = Readonly<{ key: string; artifactRef: ArtifactReference }>
type ReviewerNode = Readonly<{
  key: string; taskId: string; dependsOn: readonly string[]; artifactRef: ArtifactReference
  reviewStatus: AgentArtifactReviewReceipt["status"]; reviewHash: string
}>
type ReviewedDraftState = Readonly<{ references: readonly ArtifactReference[]; reviewers: readonly ReviewerNode[] }>

export type SelectedJobArtifactCompletionGateWithWitnessResult = Readonly<{ ok: true; witness: SelectedJobCompletionGraphWitness }> | Extract<TurnEngineCompletionGateResult, { ok: false }>

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
  const taskIds = new Set<string>()
  for (const item of state.nodes) {
    const row = plainRecord(item)
    if (!row || typeof row.key !== "string" || !row.key.trim() || row.key.length > 128
      || typeof row.taskId !== "string" || !row.taskId.trim() || row.taskId.length > 256
      || typeof row.templateId !== "string" || !row.templateId.trim() || row.templateId.length > 128
      || typeof row.status !== "string" || !Array.isArray(row.dependsOn)
      || row.dependsOn.some(key => typeof key !== "string" || !key.trim() || key.length > 128)
      || keys.has(row.key) || taskIds.has(row.taskId)) return undefined
    keys.add(row.key)
    taskIds.add(row.taskId)
    nodes.push({ key: row.key, taskId: row.taskId, templateId: row.templateId, status: row.status, dependsOn: row.dependsOn as string[], resultProjection: row.resultProjection })
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
    || !["passed", "needs_revision", "rejected"].includes(String(row.reviewStatus))) return undefined
  const artifactRef = artifactReference(row.artifactRef)
  return artifactRef ? {
    key: node.key,
    taskId: node.taskId,
    artifactRef,
    reviewStatus: String(row.reviewStatus) as AgentArtifactReviewReceipt["status"],
    reviewHash: row.reviewHash,
  } : undefined
}

function latestReviewedDraftState(value: unknown): ReviewedDraftState | undefined {
  const nodes = graphNodes(value)
  if (!nodes) return undefined
  const writers: WriterNode[] = []
  const reviewers: ReviewerNode[] = []

  for (const node of nodes) {
    const projectionRole = plainRecord(node.resultProjection)?.role
    const writerCandidate = node.templateId === WRITER_TEMPLATE_ID || projectionRole === "writer"
    const reviewerCandidate = node.templateId === REVIEWER_TEMPLATE_ID || projectionRole === "reviewer"
    if (writerCandidate && reviewerCandidate) return undefined
    if (node.status !== "completed") { if (writerCandidate || reviewerCandidate) return undefined; continue }
    if (writerCandidate) {
      const artifactRef = writerProjection(node)
      if (node.templateId !== WRITER_TEMPLATE_ID || !artifactRef) return undefined
      writers.push({ key: node.key, artifactRef })
    }
    if (reviewerCandidate) {
      const projection = reviewerProjection(node)
      if (node.templateId !== REVIEWER_TEMPLATE_ID || !projection || projection.reviewStatus === "stale") return undefined
      reviewers.push({ ...projection, dependsOn: node.dependsOn })
    }
  }
  if (writers.length === 0 || reviewers.length === 0) return undefined

  const latestByArtifact = new Map<string, WriterNode[]>()
  for (const writer of writers) {
    const current = latestByArtifact.get(writer.artifactRef.artifactId) ?? []
    const maxVersion = current[0]?.artifactRef.version ?? 0
    if (writer.artifactRef.version > maxVersion) latestByArtifact.set(writer.artifactRef.artifactId, [writer])
    else if (writer.artifactRef.version === maxVersion) {
      if (current.some(existing => !sameArtifact(existing.artifactRef, writer.artifactRef))) return undefined
      current.push(writer)
      latestByArtifact.set(writer.artifactRef.artifactId, current)
    }
  }

  const latestWriters = [...latestByArtifact.values()].flat()
  const requiredReviewers = new Map<string, ReviewerNode>()
  for (const writer of latestWriters) {
    const matches = reviewers.filter(reviewer =>
      reviewer.dependsOn.includes(writer.key) && sameArtifact(reviewer.artifactRef, writer.artifactRef))
    if (matches.length === 0) return undefined
    for (const reviewer of matches) requiredReviewers.set(reviewer.taskId, reviewer)
  }

  const latestGraphReferenceByArtifact = new Map<string, ArtifactReference>()
  for (const reference of [...writers.map(writer => writer.artifactRef), ...reviewers.map(reviewer => reviewer.artifactRef)]) {
    const current = latestGraphReferenceByArtifact.get(reference.artifactId)
    if (!current || reference.version > current.version) latestGraphReferenceByArtifact.set(reference.artifactId, reference)
    else if (reference.version === current.version && !sameArtifact(reference, current)) return undefined
  }
  return { references: [...latestGraphReferenceByArtifact.values()], reviewers: [...requiredReviewers.values()] }
}

function parsedReviewReceipt(value: unknown): AgentArtifactReviewReceipt | undefined {
  const row = plainRecord(value)
  if (!row || !exactKeys(row, "artifactId,contentHash,currentSourceDigest,jobId,reviewHash,sessionId,sourceDigest,status,taskId,toolCallId,userId,version")
    || typeof row.userId !== "string" || !row.userId.trim() || typeof row.sessionId !== "string" || !row.sessionId.trim()
    || typeof row.jobId !== "string" || !row.jobId.trim() || typeof row.artifactId !== "string" || !ARTIFACT_ID.test(row.artifactId)
    || !Number.isSafeInteger(row.version) || Number(row.version) < 1
    || typeof row.contentHash !== "string" || !SHA256.test(row.contentHash)
    || typeof row.sourceDigest !== "string" || !SHA256.test(row.sourceDigest)
    || typeof row.currentSourceDigest !== "string" || !SHA256.test(row.currentSourceDigest)
    || typeof row.reviewHash !== "string" || !SHA256.test(row.reviewHash)
    || typeof row.taskId !== "string" || !row.taskId.trim()
    || typeof row.toolCallId !== "string" || !row.toolCallId.trim()
    || !["passed", "needs_revision", "rejected"].includes(String(row.status))) return undefined
  return {
    userId: row.userId, sessionId: row.sessionId, jobId: row.jobId, artifactId: row.artifactId,
    version: Number(row.version), contentHash: row.contentHash, sourceDigest: row.sourceDigest,
    currentSourceDigest: row.currentSourceDigest, status: String(row.status) as AgentArtifactReviewReceipt["status"],
    taskId: row.taskId, toolCallId: row.toolCallId, reviewHash: row.reviewHash,
  }
}

/** Requires every latest selected-job draft, current source digest, and exact persisted review receipt to match. */
export async function selectedJobArtifactCompletionGateWithWitness(input: {
  readonly commandPort: Pick<TaskGraphCommandPort, "readCurrent"> | undefined
  readonly lease: TurnLease
  readonly root: Pick<SubagentTaskRecord, "id" | "attemptCount">
  readonly selectedJobId: string | undefined
  readonly readCurrentDraftHead: ((scope: AgentArtifactDraftHeadScope) => Promise<AgentArtifactDraftHead | null>) | undefined
  readonly readCurrentSourceDigest: (() => Promise<string | null>) | undefined
  readonly readCurrentReviewReceipt: ((scope: AgentArtifactReviewReceiptScope) => Promise<AgentArtifactReviewReceipt | null>) | undefined
}): Promise<SelectedJobArtifactCompletionGateWithWitnessResult> {
  if (!input.commandPort || typeof input.selectedJobId !== "string" || !input.selectedJobId.trim()
    || input.selectedJobId.length > 256 || !input.readCurrentDraftHead || !input.readCurrentSourceDigest || !input.readCurrentReviewReceipt) return BLOCKED
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
    const graph = await input.commandPort.readCurrent(scope)
    const latestState = latestReviewedDraftState(graph)
    if (!latestState) return BLOCKED
    const currentSourceDigest = await input.readCurrentSourceDigest()
    if (typeof currentSourceDigest !== "string" || !SHA256.test(currentSourceDigest)
      || latestState.references.some(reference => reference.sourceDigest !== currentSourceDigest)) return BLOCKED
    for (const reference of latestState.references) {
      const persistedHead = await input.readCurrentDraftHead({
        userId: input.lease.userId,
        sessionId: input.lease.sessionId,
        jobId: input.selectedJobId,
        artifactId: reference.artifactId,
      })
      const parsedHead = artifactReference(persistedHead)
      if (!parsedHead || !sameArtifact(reference, parsedHead)) return BLOCKED
    }
    for (const reviewer of latestState.reviewers) {
      const expected: AgentArtifactReviewReceiptScope = {
        userId: input.lease.userId, sessionId: input.lease.sessionId, jobId: input.selectedJobId,
        artifactId: reviewer.artifactRef.artifactId, version: reviewer.artifactRef.version,
        contentHash: reviewer.artifactRef.contentHash, sourceDigest: reviewer.artifactRef.sourceDigest,
        currentSourceDigest, status: reviewer.reviewStatus, taskId: reviewer.taskId, reviewHash: reviewer.reviewHash,
      }
      const receipt = parsedReviewReceipt(await input.readCurrentReviewReceipt(expected))
      if (!receipt || receipt.userId !== expected.userId || receipt.sessionId !== expected.sessionId || receipt.jobId !== expected.jobId
        || receipt.artifactId !== expected.artifactId || receipt.version !== expected.version || receipt.contentHash !== expected.contentHash
        || receipt.sourceDigest !== expected.sourceDigest || receipt.currentSourceDigest !== expected.currentSourceDigest
        || receipt.status !== expected.status || receipt.taskId !== expected.taskId || receipt.reviewHash !== expected.reviewHash) return BLOCKED
    }
    if (await input.readCurrentSourceDigest() !== currentSourceDigest) return BLOCKED
    return { ok: true, witness: { revision: graph.revision, nodes: graph.nodes } }
  } catch {
    return BLOCKED
  }
}

export async function selectedJobArtifactCompletionGate(
  input: Parameters<typeof selectedJobArtifactCompletionGateWithWitness>[0],
): Promise<TurnEngineCompletionGateResult> {
  const result = await selectedJobArtifactCompletionGateWithWitness(input)
  return result.ok ? { ok: true } : result
}
