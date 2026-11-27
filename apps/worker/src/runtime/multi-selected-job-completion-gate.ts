import type {
  AgentArtifactDraftHead, AgentArtifactDraftHeadScope, AgentArtifactReviewReceipt,
  AgentArtifactReviewReceiptScope,
} from "../db/agent-artifact-repo.js"
import { parseSelectedJobBatchGraph, SELECTED_JOB_BATCH_SLOT_IDS } from "@jobcopilot/agent-protocol"
import {
  isSelectedJobBatchCorrectionSuccessor, readSelectedJobBatchCorrectionPriorEvidence,
  type SelectedJobBatchArtifactVersion, type SelectedJobBatchArtifactVersionScope,
  type SelectedJobBatchCorrectionPriorEvidence,
} from "./multi-selected-job-correction-evidence.js"
import {
  selectedJobArtifactCompletionGateWithWitness,
  type SelectedJobCompletionGraphWitness,
} from "./selected-job-completion-gate.js"
import type {
  TaskGraphArtifactProjectionReference, TaskGraphCurrentNode, TaskGraphCurrentState,
} from "./subagents/task-graph-command-port.js"
import type { SelectedJobBatchPair } from "./subagents/selected-job-batch-plan.js"
import { writerArtifactReferenceFromTaskContext } from "./subagents/task-graph-dependency-context.js"
import type { SubagentTaskRecord } from "./subagents/types.js"
import type { TurnLease } from "./turns/lease.js"
import { canonicalTaskGraphJson } from "./subagents/task-graph-snapshot.js"

const WRITER_TEMPLATE_ID = "cover_letter_writer"
const REVIEWER_TEMPLATE_ID = "cover_letter_reviewer"
const TERMINAL_FAILURES = new Set(["failed", "interrupted", "cancelled", "closed"])
const RUNNING_STATUSES = new Set(["queued", "running", "retrying", "waiting", "waiting_for_user"])
const DISPATCHED_STATUSES = new Set(["queued", "running", "retrying", "completed"])

export type SelectedJobBatchTaskContext = Readonly<{ taskId: string; role: string; context: unknown }>
export type SelectedJobBatchVerifiedEvidence = Readonly<{
  artifactRef: TaskGraphArtifactProjectionReference
  artifactVersion: SelectedJobBatchArtifactVersion
  reviewReceipt: Readonly<{
    taskId: string; artifactId: string; version: number; contentHash: string; sourceDigest: string
    currentSourceDigest: string; status: AgentArtifactReviewReceipt["status"]; reviewHash: string
  }>
}>
export type SelectedJobBatchPriorEvidence = SelectedJobBatchCorrectionPriorEvidence
export type SelectedJobBatchJobOutcome =
  | Readonly<{ slotId: SelectedJobBatchPair["slotId"]; jobId: string; status: "completed"; writerTaskId: string; reviewerTaskId: string; evidence: SelectedJobBatchVerifiedEvidence; priorEvidence?: SelectedJobBatchPriorEvidence }>
  | Readonly<{ slotId: SelectedJobBatchPair["slotId"]; jobId: string; status: "pending" | "failed"; writerTaskId: string; reviewerTaskId: string; priorEvidence?: SelectedJobBatchPriorEvidence }>
  | Readonly<{ slotId: SelectedJobBatchPair["slotId"]; jobId: string; status: "invalid" }>
export type SelectedJobBatchCompletionWitness = Readonly<{
  graph: SelectedJobCompletionGraphWitness
  slots: readonly SelectedJobBatchJobOutcome[]
}>
export type SelectedJobBatchCompletionResult =
  | Readonly<{ status: "ready"; outcomes: readonly SelectedJobBatchJobOutcome[]; witness: SelectedJobBatchCompletionWitness }>
  | Readonly<{ status: "pending" | "blocked"; outcomes: readonly SelectedJobBatchJobOutcome[] }>

/** Supply the graph, task contexts, and all evidence readers from one owner-fenced transaction. */
export type VerifySelectedJobBatchCompletionInput = Readonly<{
  graph: TaskGraphCurrentState
  pairs: readonly SelectedJobBatchPair[]
  taskContexts: readonly SelectedJobBatchTaskContext[]
  expectedWitness?: SelectedJobBatchCompletionWitness
  lease: TurnLease
  root: Pick<SubagentTaskRecord, "id" | "attemptCount">
  readCurrentDraftHead(scope: AgentArtifactDraftHeadScope): Promise<AgentArtifactDraftHead | null>
  readArtifactVersion(scope: SelectedJobBatchArtifactVersionScope): Promise<SelectedJobBatchArtifactVersion | null>
  readCurrentSourceDigest(jobId: string): Promise<string | null>
  readCurrentReviewReceipt(scope: AgentArtifactReviewReceiptScope): Promise<AgentArtifactReviewReceipt | null>
}>

type BoundPair = Readonly<{
  pair: SelectedJobBatchPair
  initial: Readonly<{ writer: TaskGraphCurrentNode; reviewer: TaskGraphCurrentNode }>
  effective: Readonly<{ writer: TaskGraphCurrentNode; reviewer: TaskGraphCurrentNode }>
  correction: boolean
  correctionWriterContext?: unknown
}>

/** Verifies independent Job evidence while preserving explicit branch failures and pending work. */
export async function verifySelectedJobBatchCompletion(input: VerifySelectedJobBatchCompletionInput): Promise<SelectedJobBatchCompletionResult> {
  const bindings = bindPairs(input)
  if (!bindings) return { status: "blocked", outcomes: invalidOutcomes(input.pairs) }
  const outcomes: SelectedJobBatchJobOutcome[] = []
  for (const binding of bindings) {
    const { pair, initial, effective } = binding
    const priorEvidence = binding.correction ? await readSelectedJobBatchCorrectionPriorEvidence({
      userId: input.lease.userId, sessionId: input.lease.sessionId, jobId: pair.jobId,
      writer: initial.writer, reviewer: initial.reviewer, correctionWriterContext: binding.correctionWriterContext,
      requireWriterDependency: DISPATCHED_STATUSES.has(effective.writer.status),
      readCurrentSourceDigest: input.readCurrentSourceDigest, readArtifactVersion: input.readArtifactVersion,
      readCurrentReviewReceipt: input.readCurrentReviewReceipt,
    }) : undefined
    if (binding.correction && !priorEvidence) { outcomes.push(invalid(pair)); continue }
    const { writer, reviewer } = effective
    const progress = branchProgress(writer.status, reviewer.status)
    if (progress === "failed") {
      outcomes.push({ slotId: pair.slotId, jobId: pair.jobId, status: "failed", writerTaskId: writer.taskId!, reviewerTaskId: reviewer.taskId!, ...(priorEvidence ? { priorEvidence } : {}) })
      continue
    }
    if (progress === "pending") {
      outcomes.push({ slotId: pair.slotId, jobId: pair.jobId, status: "pending", writerTaskId: writer.taskId!, reviewerTaskId: reviewer.taskId!, ...(priorEvidence ? { priorEvidence } : {}) })
      continue
    }
    if (progress === "invalid") {
      outcomes.push({ slotId: pair.slotId, jobId: pair.jobId, status: "invalid" })
      continue
    }
    const projected = slotProjection(input.graph, effective)
    let receipt: AgentArtifactReviewReceipt | null = null
    const result = await selectedJobArtifactCompletionGateWithWitness({
      commandPort: { readCurrent: async () => projected }, lease: input.lease, root: input.root, selectedJobId: pair.jobId,
      readCurrentDraftHead: input.readCurrentDraftHead,
      readCurrentSourceDigest: () => input.readCurrentSourceDigest(pair.jobId),
      readCurrentReviewReceipt: async scope => { receipt = await input.readCurrentReviewReceipt(scope); return receipt },
    })
    const evidence = result.ok ? await verifiedEvidence(input, pair, effective, receipt, priorEvidence) : undefined
    outcomes.push(evidence
      ? { slotId: pair.slotId, jobId: pair.jobId, status: "completed", writerTaskId: writer.taskId!, reviewerTaskId: reviewer.taskId!, evidence, ...(priorEvidence ? { priorEvidence } : {}) }
      : invalid(pair))
  }
  if (outcomes.some(outcome => outcome.status === "invalid")) return { status: "blocked", outcomes }
  if (outcomes.some(outcome => outcome.status === "pending")) return { status: input.expectedWitness ? "blocked" : "pending", outcomes }
  const witness: SelectedJobBatchCompletionWitness = {
    graph: { revision: input.graph.revision, nodes: input.graph.nodes }, slots: outcomes,
  }
  return input.expectedWitness && !sameWitness(witness, input.expectedWitness)
    ? { status: "blocked", outcomes }
    : { status: "ready", outcomes, witness }
}

function bindPairs(input: VerifySelectedJobBatchCompletionInput): BoundPair[] | undefined {
  const { graph, pairs, taskContexts } = input
  if (!Number.isSafeInteger(graph.revision) || graph.revision < 0 || pairs.length < 2 || pairs.length > SELECTED_JOB_BATCH_SLOT_IDS.length
    || taskContexts.length !== graph.nodes.length || new Set(pairs.map(pair => pair.jobId)).size !== pairs.length) return undefined
  const parsed = parseSelectedJobBatchGraph(graph.nodes, pairs.map(pair => pair.slotId))
  if (!parsed) return undefined
  const tasks = new Map(taskContexts.map(task => [task.taskId, task]))
  const taskIds = graph.nodes.map(node => node.taskId)
  if (new Set(taskIds).size !== graph.nodes.length || tasks.size !== graph.nodes.length
    || taskIds.some(id => !id || !tasks.has(id))) return undefined
  const bindings: BoundPair[] = []
  for (const [index, chain] of parsed.entries()) {
    const pair = pairs[index], initial = chain.initial, effective = chain.effective
    if (!pair || pair.slotId !== chain.slotId || !pair.jobId.trim() || pair.writerNodeKey !== initial.writer.key
      || pair.reviewerNodeKey !== initial.reviewer.key || pair.writerTemplateId !== initial.writer.templateId
      || pair.reviewerTemplateId !== initial.reviewer.templateId) return undefined
    const writerTask = tasks.get(initial.writer.taskId!), reviewerTask = tasks.get(initial.reviewer.taskId!)
    if (!contextMatches(writerTask, "writer", pair.jobId)
      || !reviewerContextMatches(reviewerTask, pair.jobId, initial.writer, initial.reviewer.status)) return undefined
    let correctionWriterContext: unknown
    if (chain.correction) {
      const correctionWriter = tasks.get(chain.correction.writer.taskId!), correctionReviewer = tasks.get(chain.correction.reviewer.taskId!)
      if (!reviewerContextMatches(correctionReviewer, pair.jobId, chain.correction.writer, chain.correction.reviewer.status)
        || !correctionWriter || correctionWriter.role !== "writer" || !selectedJobMatches(contextRecord(correctionWriter.context) ?? {}, pair.jobId)) return undefined
      correctionWriterContext = correctionWriter.context
    }
    bindings.push({ pair, initial, effective, correction: Boolean(chain.correction), ...(chain.correction ? { correctionWriterContext } : {}) })
  }
  return bindings
}

function branchProgress(writer: string, reviewer: string): "completed" | "pending" | "failed" | "invalid" {
  const writerFailed = TERMINAL_FAILURES.has(writer), reviewerFailed = TERMINAL_FAILURES.has(reviewer)
  const writerRunning = RUNNING_STATUSES.has(writer), reviewerRunning = RUNNING_STATUSES.has(reviewer)
  if (writer === "completed" && reviewer === "completed") return "completed"
  if (writerFailed && reviewerFailed || writer === "completed" && reviewerFailed) return "failed"
  if (writer === "completed" && reviewerRunning || writerRunning && reviewerRunning || writerFailed && reviewerRunning) return "pending"
  return "invalid"
}

function contextMatches(task: SelectedJobBatchTaskContext | undefined, role: string, jobId: string): boolean {
  const context = task?.role === role ? contextRecord(task.context) : undefined
  return !!context && selectedJobMatches(context, jobId) && !Object.hasOwn(context, "taskGraphDependencyResults")
}

function reviewerContextMatches(task: SelectedJobBatchTaskContext | undefined, jobId: string, writer: TaskGraphCurrentNode, status: string): boolean {
  const context = task?.role === "reviewer" ? contextRecord(task.context) : undefined
  if (!context || !selectedJobMatches(context, jobId)) return false
  if (!Object.hasOwn(context, "taskGraphDependencyResults")) return !DISPATCHED_STATUSES.has(status) || writer.status !== "completed"
  try { return sameArtifact(writerArtifactReferenceFromTaskContext(context, jobId), projectionRef(writer, "writer")) }
  catch { return false }
}

function contextRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "string") { try { value = JSON.parse(value) as unknown } catch { return undefined } }
  return plainRecord(value)
}
function selectedJobMatches(context: Record<string, unknown>, jobId: string): boolean {
  const selected = plainRecord(context.selectedJobPreparation)
  return !!selected && Object.keys(selected).sort().join(",") === "jobId" && selected.jobId === jobId
}
function slotProjection(graph: TaskGraphCurrentState, pair: BoundPair["effective"]): TaskGraphCurrentState {
  return { revision: graph.revision, nodes: [
    { ...pair.writer, templateId: WRITER_TEMPLATE_ID, dependsOn: [] },
    { ...pair.reviewer, templateId: REVIEWER_TEMPLATE_ID, dependsOn: [pair.writer.key] },
  ] }
}
function projectionRef(node: TaskGraphCurrentNode, role: "writer" | "reviewer"): TaskGraphArtifactProjectionReference {
  const projection = node.resultProjection
  if (node.status !== "completed" || !projection || !("role" in projection) || projection.availability !== "available" || projection.role !== role) {
    throw new Error("batch_result_projection_invalid")
  }
  return projection.artifactRef
}
function sameArtifact(left: TaskGraphArtifactProjectionReference, right: TaskGraphArtifactProjectionReference): boolean {
  return left.artifactId === right.artifactId && left.version === right.version
    && left.contentHash === right.contentHash && left.sourceDigest === right.sourceDigest
}
function invalid(pair: SelectedJobBatchPair): SelectedJobBatchJobOutcome {
  return { slotId: pair.slotId, jobId: pair.jobId, status: "invalid" }
}
async function verifiedEvidence(
  input: VerifySelectedJobBatchCompletionInput, pair: SelectedJobBatchPair,
  effective: BoundPair["effective"], receipt: AgentArtifactReviewReceipt | null, prior?: SelectedJobBatchPriorEvidence,
): Promise<SelectedJobBatchVerifiedEvidence | undefined> {
  try {
    const artifactRef = projectionRef(effective.writer, "writer"), reviewerRef = projectionRef(effective.reviewer, "reviewer")
    if (!sameArtifact(artifactRef, reviewerRef)) return undefined
    const source = artifactRef.sourceDigest
    const reviewProjection = effective.reviewer.resultProjection
    if (!reviewProjection || !("role" in reviewProjection) || reviewProjection.role !== "reviewer" || !receipt) return undefined
    const reviewReceipt = { taskId: receipt.taskId, artifactId: receipt.artifactId, version: receipt.version,
      contentHash: receipt.contentHash, sourceDigest: receipt.sourceDigest, currentSourceDigest: receipt.currentSourceDigest,
      status: receipt.status, reviewHash: receipt.reviewHash }
    const versionScope = { userId: input.lease.userId, sessionId: input.lease.sessionId, jobId: pair.jobId,
      artifactId: artifactRef.artifactId, taskId: effective.writer.taskId!, version: artifactRef.version }
    const artifactVersion = await input.readArtifactVersion(versionScope)
    if (!artifactVersion || artifactVersion.artifactId !== artifactRef.artifactId
      || artifactVersion.artifactType !== "cover_letter" || artifactVersion.taskId !== effective.writer.taskId
      || artifactVersion.version !== artifactRef.version || artifactVersion.contentHash !== artifactRef.contentHash
      || artifactVersion.sourceDigest !== artifactRef.sourceDigest || await input.readCurrentSourceDigest(pair.jobId) !== source) return undefined
    if (prior && !isSelectedJobBatchCorrectionSuccessor(prior, artifactVersion)) return undefined
    return { artifactRef, artifactVersion, reviewReceipt }
  } catch { return undefined }
}

function invalidOutcomes(pairs: readonly SelectedJobBatchPair[]): SelectedJobBatchJobOutcome[] {
  return Array.isArray(pairs) ? pairs.map(pair => ({ slotId: pair.slotId, jobId: pair.jobId, status: "invalid" as const })) : []
}

function sameWitness(left: SelectedJobBatchCompletionWitness, right: SelectedJobBatchCompletionWitness): boolean {
  try { return canonicalTaskGraphJson(left) === canonicalTaskGraphJson(right) } catch { return false }
}

function plainRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  try {
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return undefined
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (typeof key !== "string" || !descriptor || !descriptor.enumerable || !("value" in descriptor)) return undefined
    }
    return value as Record<string, unknown>
  } catch { return undefined }
}
