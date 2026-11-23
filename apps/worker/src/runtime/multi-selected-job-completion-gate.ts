import type {
  AgentArtifactDraftHead, AgentArtifactDraftHeadScope, AgentArtifactReviewReceipt,
  AgentArtifactReviewReceiptScope,
} from "../db/agent-artifact-repo.js"
import {
  selectedJobArtifactCompletionGateWithWitness,
  type SelectedJobCompletionGraphWitness,
} from "./selected-job-completion-gate.js"
import type {
  TaskGraphArtifactProjectionReference, TaskGraphCurrentNode, TaskGraphCurrentState,
} from "./subagents/task-graph-command-port.js"
import {
  pairSelectedJobBatchPlan,
  SELECTED_JOB_BATCH_SLOT_IDS,
  type SelectedJobBatchPair,
  type SelectedJobBatchSlotId,
} from "./subagents/selected-job-batch-plan.js"
import type { SubagentTaskRecord } from "./subagents/types.js"
import type { TurnLease } from "./turns/lease.js"
import { canonicalTaskGraphJson } from "./subagents/task-graph-snapshot.js"

const WRITER_TEMPLATE_ID = "cover_letter_writer"
const REVIEWER_TEMPLATE_ID = "cover_letter_reviewer"
const TERMINAL_FAILURES = new Set(["failed", "interrupted", "cancelled", "closed"])
const RUNNING_STATUSES = new Set(["queued", "running", "retrying", "waiting", "waiting_for_user"])

export type SelectedJobBatchTaskContext = Readonly<{ taskId: string; role: string; context: unknown }>
export type SelectedJobBatchVerifiedEvidence = Readonly<{
  artifactRef: TaskGraphArtifactProjectionReference
  reviewReceipt: Readonly<{
    taskId: string; artifactId: string; version: number; contentHash: string; sourceDigest: string
    currentSourceDigest: string; status: AgentArtifactReviewReceipt["status"]; reviewHash: string
  }>
}>
export type SelectedJobBatchJobOutcome =
  | Readonly<{ slotId: SelectedJobBatchSlotId; jobId: string; status: "completed"; writerTaskId: string; reviewerTaskId: string; evidence: SelectedJobBatchVerifiedEvidence }>
  | Readonly<{ slotId: SelectedJobBatchSlotId; jobId: string; status: "pending" | "failed"; writerTaskId: string; reviewerTaskId: string }>
  | Readonly<{ slotId: SelectedJobBatchSlotId; jobId: string; status: "invalid" }>
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
  readCurrentSourceDigest(jobId: string): Promise<string | null>
  readCurrentReviewReceipt(scope: AgentArtifactReviewReceiptScope): Promise<AgentArtifactReviewReceipt | null>
}>

type BoundPair = Readonly<{
  pair: SelectedJobBatchPair; writer: TaskGraphCurrentNode; reviewer: TaskGraphCurrentNode
}>

/** Verifies independent Job evidence while preserving explicit branch failures and pending work. */
export async function verifySelectedJobBatchCompletion(input: VerifySelectedJobBatchCompletionInput): Promise<SelectedJobBatchCompletionResult> {
  const bindings = bindPairs(input.graph, input.pairs, input.taskContexts)
  if (!bindings) return { status: "blocked", outcomes: invalidOutcomes(input.pairs) }
  const outcomes: SelectedJobBatchJobOutcome[] = []
  for (const binding of bindings) {
    const { pair, writer, reviewer } = binding
    const progress = branchProgress(writer.status, reviewer.status)
    if (progress === "failed") {
      outcomes.push({ slotId: pair.slotId, jobId: pair.jobId, status: "failed", writerTaskId: writer.taskId, reviewerTaskId: reviewer.taskId })
      continue
    }
    if (progress === "pending") {
      outcomes.push({ slotId: pair.slotId, jobId: pair.jobId, status: "pending", writerTaskId: writer.taskId, reviewerTaskId: reviewer.taskId })
      continue
    }
    if (progress === "invalid") {
      outcomes.push({ slotId: pair.slotId, jobId: pair.jobId, status: "invalid" })
      continue
    }
    const projected = slotProjection(input.graph, pair)
    let receipt: AgentArtifactReviewReceipt | null = null
    const result = await selectedJobArtifactCompletionGateWithWitness({
      commandPort: { readCurrent: async () => projected }, lease: input.lease, root: input.root, selectedJobId: pair.jobId,
      readCurrentDraftHead: input.readCurrentDraftHead,
      readCurrentSourceDigest: () => input.readCurrentSourceDigest(pair.jobId),
      readCurrentReviewReceipt: async scope => { receipt = await input.readCurrentReviewReceipt(scope); return receipt },
    })
    const evidence = result.ok ? verifiedEvidence(projected, pair, receipt) : undefined
    outcomes.push(evidence
      ? { slotId: pair.slotId, jobId: pair.jobId, status: "completed", writerTaskId: writer.taskId, reviewerTaskId: reviewer.taskId, evidence }
      : { slotId: pair.slotId, jobId: pair.jobId, status: "invalid" })
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

function bindPairs(
  graph: TaskGraphCurrentState, pairs: readonly SelectedJobBatchPair[], taskContexts: readonly SelectedJobBatchTaskContext[],
): BoundPair[] | undefined {
  if (!Number.isSafeInteger(graph.revision) || graph.revision < 0 || pairs.length < 2
    || pairs.length > SELECTED_JOB_BATCH_SLOT_IDS.length || graph.nodes.length !== pairs.length * 2
    || taskContexts.length !== graph.nodes.length) return undefined
  let validatedPairs: readonly SelectedJobBatchPair[]
  try {
    validatedPairs = pairSelectedJobBatchPlan(graph.nodes, pairs.map(({ slotId, jobId }) => ({ slotId, jobId })))
  } catch { return undefined }
  if (validatedPairs.some((pair, index) => {
    const expected = pairs[index]
    return !expected || pair.slotId !== expected.slotId || pair.jobId !== expected.jobId
      || pair.writerTemplateId !== expected.writerTemplateId || pair.writerNodeKey !== expected.writerNodeKey
      || pair.reviewerTemplateId !== expected.reviewerTemplateId || pair.reviewerNodeKey !== expected.reviewerNodeKey
  })) return undefined
  const nodes = new Map<string, TaskGraphCurrentNode>(), tasks = new Map<string, SelectedJobBatchTaskContext>()
  const taskIds = new Set<string>()
  for (const node of graph.nodes) {
    if (!node.key || !node.taskId || nodes.has(node.key) || taskIds.has(node.taskId)) return undefined
    nodes.set(node.key, node); taskIds.add(node.taskId)
  }
  for (const task of taskContexts) {
    if (!task.taskId || tasks.has(task.taskId)) return undefined
    tasks.set(task.taskId, task)
  }
  const bound: BoundPair[] = []
  for (const pair of pairs) {
    const writer = nodes.get(pair.writerNodeKey), reviewer = nodes.get(pair.reviewerNodeKey)
    if (!writer || !reviewer
      || !contextMatches(tasks.get(writer.taskId), writer.taskId, "writer", pair.jobId)
      || !contextMatches(tasks.get(reviewer.taskId), reviewer.taskId, "reviewer", pair.jobId)) return undefined
    bound.push({ pair, writer, reviewer })
  }
  return tasks.size === graph.nodes.length ? bound : undefined
}

function branchProgress(writer: string, reviewer: string): "completed" | "pending" | "failed" | "invalid" {
  const writerFailed = TERMINAL_FAILURES.has(writer), reviewerFailed = TERMINAL_FAILURES.has(reviewer)
  const writerRunning = RUNNING_STATUSES.has(writer), reviewerRunning = RUNNING_STATUSES.has(reviewer)
  if (writer === "completed" && reviewer === "completed") return "completed"
  if (writerFailed && reviewerFailed || writer === "completed" && reviewerFailed) return "failed"
  if (writer === "completed" && reviewerRunning || writerRunning && reviewerRunning || writerFailed && reviewerRunning) return "pending"
  return "invalid"
}

function contextMatches(task: SelectedJobBatchTaskContext | undefined, taskId: string, role: string, jobId: string): boolean {
  if (!task || task.taskId !== taskId || task.role !== role) return false
  let value = task.context
  if (typeof value === "string") { try { value = JSON.parse(value) as unknown } catch { return false } }
  const context = plainRecord(value), selected = context && plainRecord(context.selectedJobPreparation)
  return Boolean(selected && Object.keys(selected).sort().join(",") === "jobId" && selected.jobId === jobId)
}

function slotProjection(graph: TaskGraphCurrentState, pair: SelectedJobBatchPair): TaskGraphCurrentState {
  return { revision: graph.revision, nodes: graph.nodes.filter(node => node.key === pair.writerNodeKey || node.key === pair.reviewerNodeKey)
    .map(node => ({ ...node, templateId: node.key === pair.writerNodeKey ? WRITER_TEMPLATE_ID : REVIEWER_TEMPLATE_ID })) }
}

function verifiedEvidence(
  graph: TaskGraphCurrentState, pair: SelectedJobBatchPair, receipt: AgentArtifactReviewReceipt | null,
): SelectedJobBatchVerifiedEvidence | undefined {
  const writer = graph.nodes.find(node => node.key === pair.writerNodeKey), reviewer = graph.nodes.find(node => node.key === pair.reviewerNodeKey)
  const writerProjection = writer?.resultProjection, reviewerProjection = reviewer?.resultProjection
  if (writerProjection?.availability !== "available" || writerProjection.role !== "writer"
    || reviewerProjection?.availability !== "available" || reviewerProjection.role !== "reviewer" || !receipt) return undefined
  return {
    artifactRef: { ...writerProjection.artifactRef },
    reviewReceipt: {
      taskId: receipt.taskId, artifactId: receipt.artifactId, version: receipt.version, contentHash: receipt.contentHash,
      sourceDigest: receipt.sourceDigest, currentSourceDigest: receipt.currentSourceDigest, status: receipt.status, reviewHash: receipt.reviewHash,
    },
  }
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
