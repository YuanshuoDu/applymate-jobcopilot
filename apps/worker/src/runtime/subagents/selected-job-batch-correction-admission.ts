import type pg from "pg"
import {
  isSelectedJobBatchTemplateId,
  parseSelectedJobBatchGraph,
  selectedJobBatchTemplatesForSlot,
} from "@jobcopilot/agent-protocol"
import { findCurrentDraftHeadWithClient, findReviewReceiptWithClient } from "../../db/agent-artifact-repo.js"
import { readSelectedJobSourceDigestWithClient } from "./selected-job-artifact-context.js"
import { projectTaskGraphResult } from "./task-graph-result-projection.js"
import type { TaskGraphNodeProposal, TaskGraphState } from "../planning/task-graph.js"
import type { TaskGraphExecutionScope, TaskGraphTaskTemplate } from "./task-graph-schedule-input.js"
import {
  pairSelectedJobBatchCorrectionProposal, pairSelectedJobBatchPlan, selectedJobBatchSlotsFromTemplates,
  type SelectedJobBatchCorrectionProposal, type SelectedJobBatchSlot,
} from "./selected-job-batch-plan.js"

export class SelectedJobBatchCorrectionAdmissionError extends Error {
  readonly code = "selected_job_batch_review_unverified"
  constructor() {
    super("Selected-job correction requires current same-slot Reviewer evidence")
    this.name = "SelectedJobBatchCorrectionAdmissionError"
  }
}

type Input = Readonly<{
  client: Pick<pg.PoolClient, "query">
  scope: TaskGraphExecutionScope
  current: TaskGraphState
  slots: readonly SelectedJobBatchSlot[]
  corrections: readonly SelectedJobBatchCorrectionProposal[]
  priorTaskIds: ReadonlyMap<string, string>
}>
type TaskRow = Readonly<Record<string, unknown> & {
  id: string; userId: string; sessionId: string; turnId: string; rootTaskId: string; parentTaskId: string
  role: string; taskType: string; status: string; failureReason: string | null; context: unknown; result: unknown
}>
function fail(): never { throw new SelectedJobBatchCorrectionAdmissionError() }

type PlanInput = Readonly<{
  client: Pick<pg.PoolClient, "query">
  scope: TaskGraphExecutionScope
  current: TaskGraphState
  proposedState: TaskGraphState
  proposedNodes: readonly TaskGraphNodeProposal[]
  templates: Readonly<Record<string, TaskGraphTaskTemplate>>
  priorTaskIds: ReadonlyMap<string, string>
  hasReplacementMode: boolean
  hasRootSuccessCriteria: boolean
}>

/** Fail-closes batch catalog usage at the persistence boundary, including internal callers. */
export async function assertSelectedJobBatchPlanAdmission(input: PlanInput): Promise<void> {
  const nodes = [...input.current.nodes, ...input.proposedState.nodes]
  const batchMode = Object.keys(input.templates).some(isSelectedJobBatchTemplateId)
    || nodes.some(node => isSelectedJobBatchTemplateId(node.templateId))
  if (!batchMode) return
  const slots = selectedJobBatchSlotsFromTemplates(input.templates)
  if (input.hasReplacementMode || (input.current.nodes.length > 0 && input.hasRootSuccessCriteria)
    || nodes.some(hasUnsupportedMode)
    || !slots || !nodes.some(node => isSelectedJobBatchTemplateId(node.templateId))
    || !parseSelectedJobBatchGraph(input.proposedState.nodes, slots.map(slot => slot.slotId))) fail()
  if (input.current.nodes.length === 0) {
    try { pairSelectedJobBatchPlan(input.proposedNodes, slots) } catch { fail() }
    return
  }
  let corrections: readonly SelectedJobBatchCorrectionProposal[]
  try { corrections = pairSelectedJobBatchCorrectionProposal(input.proposedNodes, slots) } catch { fail() }
  await assertSelectedJobBatchCorrectionsAuthorized({ ...input, slots, corrections })
}

function hasUnsupportedMode(node: TaskGraphNodeProposal): boolean {
  return Object.hasOwn(node, "repairOf") || Object.hasOwn(node, "verification") || Object.hasOwn(node, "packageRefs")
}

/** Revalidates only newly proposed correction pairs against the same transaction's durable task and artifact proof. */
export async function assertSelectedJobBatchCorrectionsAuthorized(input: Input): Promise<void> {
  if (!input.corrections.length) return
  const slotIds = input.slots.map(slot => slot.slotId)
  const parsed = parseSelectedJobBatchGraph(input.current.nodes, slotIds)
  if (!parsed) fail()
  for (const correction of input.corrections) {
    const slotIndex = input.slots.findIndex(slot => slot.slotId === correction.slotId)
    const slot = input.slots[slotIndex], graphSlot = parsed[slotIndex]
    const catalog = selectedJobBatchTemplatesForSlot(correction.slotId)
    if (!slot || !graphSlot || graphSlot.correction || !catalog
      || correction.previousReviewerNodeKey !== graphSlot.initial.reviewer.key) fail()
    const writerTaskId = input.priorTaskIds.get(graphSlot.initial.writer.key)
    const reviewerTaskId = input.priorTaskIds.get(graphSlot.initial.reviewer.key)
    if (!writerTaskId || !reviewerTaskId || writerTaskId === reviewerTaskId) fail()
    const tasks = await readTasks(input.client, input.scope, writerTaskId, reviewerTaskId)
    const writer = tasks.get(writerTaskId), reviewer = tasks.get(reviewerTaskId)
    if (!writer || !reviewer || !taskMatches(writer, input.scope, slot.jobId, "writer", "cover_letter_draft")
      || !taskMatches(reviewer, input.scope, slot.jobId, "reviewer", "cover_letter_review")
      || writer.status !== "completed" || reviewer.status !== "completed"
      || writer.failureReason !== null || reviewer.failureReason !== null
      || graphSlot.initial.writer.status !== "completed" || graphSlot.initial.reviewer.status !== "completed") fail()
    const writerResult = projectTaskGraphResult(writer.role, writer.status, writer.result)
    const reviewerResult = projectTaskGraphResult(reviewer.role, reviewer.status, reviewer.result)
    if (writerResult.availability !== "available" || writerResult.role !== "writer") fail()
    if (reviewerResult.availability !== "available" || reviewerResult.role !== "reviewer") fail()
    if (reviewerResult.reviewStatus !== "needs_revision" || !sameRef(writerResult.artifactRef, reviewerResult.artifactRef)) fail()
    const ref = reviewerResult.artifactRef
    const versionRows = await input.client.query<Record<string, unknown>>(
      `SELECT "taskId" FROM "agent_artifact_version"
       WHERE "userId"=$1 AND "sessionId"=$2 AND "jobId"=$3 AND "artifactId"=$4 AND "version"=$5
         AND "contentHash"=$6 AND "sourceDigest"=$7 AND "artifactType"='cover_letter' FOR SHARE`,
      [input.scope.userId, input.scope.sessionId, slot.jobId, ref.artifactId, ref.version, ref.contentHash, ref.sourceDigest],
    )
    if (versionRows.rows.length !== 1 || versionRows.rows[0]?.taskId !== writerTaskId) fail()
    const sourceDigest = await readSelectedJobSourceDigestWithClient(input.client, input.scope.userId, slot.jobId)
    if (!sourceDigest || sourceDigest !== ref.sourceDigest) fail()
    const head = await findCurrentDraftHeadWithClient(input.client, {
      userId: input.scope.userId, sessionId: input.scope.sessionId, jobId: slot.jobId, artifactId: ref.artifactId,
    })
    if (!head || head.version !== ref.version || head.contentHash !== ref.contentHash || head.sourceDigest !== sourceDigest) fail()
    const receipt = await findReviewReceiptWithClient(input.client, {
      userId: input.scope.userId, sessionId: input.scope.sessionId, jobId: slot.jobId,
      artifactId: ref.artifactId, version: ref.version, contentHash: ref.contentHash,
      sourceDigest: ref.sourceDigest, currentSourceDigest: sourceDigest, status: "needs_revision",
      taskId: reviewerTaskId, reviewHash: reviewerResult.reviewHash,
    })
    if (!receipt || receipt.taskId !== reviewerTaskId || receipt.status !== "needs_revision"
      || receipt.toolCallId.trim() === "" || receipt.reviewHash !== reviewerResult.reviewHash) fail()
  }
}

async function readTasks(client: Pick<pg.PoolClient, "query">, scope: TaskGraphExecutionScope, writerId: string, reviewerId: string): Promise<Map<string, TaskRow>> {
  const result = await client.query<Record<string, unknown>>(
    `SELECT task."id", session."userId" AS "userId", task."sessionId", task."turnId", task."rootTaskId", task."parentTaskId",
        task."role", task."taskType", task."status", task."failureReason", task."context", task."result"
     FROM "sub_agent_tasks" AS task JOIN "agent_sessions" AS session ON session."id"=task."sessionId"
     WHERE task."id"=ANY($1::text[]) AND task."sessionId"=$2 AND task."turnId"=$3 AND task."rootTaskId"=$4
       AND task."parentTaskId"=$5 AND session."userId"=$6 FOR SHARE OF task`,
    [[writerId, reviewerId], scope.sessionId, scope.turnId, scope.rootTaskId, scope.parentTaskId, scope.userId],
  )
  if (result.rows.length !== 2) fail()
  return new Map(result.rows.map(row => [String(row.id), row as TaskRow]))
}

function taskMatches(task: TaskRow, scope: TaskGraphExecutionScope, jobId: string, role: string, taskType: string): boolean {
  const context = parseRecord(task.context), selected = context && parseRecord(context.selectedJobPreparation)
  return task.userId === scope.userId && task.sessionId === scope.sessionId && task.turnId === scope.turnId
    && task.rootTaskId === scope.rootTaskId && task.parentTaskId === scope.parentTaskId
    && task.role === role && task.taskType === taskType && selected?.jobId === jobId
    && Object.keys(selected ?? {}).sort().join(",") === "jobId"
}

function sameRef(left: Readonly<{ artifactId: string; version: number; contentHash: string; sourceDigest: string }>,
  right: Readonly<{ artifactId: string; version: number; contentHash: string; sourceDigest: string }>): boolean {
  return left.artifactId === right.artifactId && left.version === right.version
    && left.contentHash === right.contentHash && left.sourceDigest === right.sourceDigest
}
function parseRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  try { return Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null
    ? value as Record<string, unknown> : null } catch { return null }
}
