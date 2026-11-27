import { selectedJobBatchTemplatesForSlot, type SelectedJobBatchSlotId } from "@jobcopilot/agent-protocol"
import type { SelectedJobBatchPriorEvidence } from "../multi-selected-job-completion-gate.js"
import { TASK_GRAPH_RESULT_PROJECTION_SCHEMA, type TaskGraphCurrentNode } from "./task-graph-command-port.js"
import type { SelectedJobBatchFinalOutcome } from "./selected-job-batch-final-outcome.js"
import type { TaskGraphFinalSummaryBinding } from "./task-graph-final-summary-binding.js"
import type { SubagentTaskStatus } from "./types.js"

const SHA256 = /^sha256:[a-f0-9]{64}$/
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const SAFE_TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/

export type SelectedJobBatchCorrectionMember = Readonly<{
  nodeIndex: number; nodeKey: string; templateId: string; taskId: string; taskType: "cover_letter_draft" | "cover_letter_review"
  role: "writer" | "reviewer"; status: SubagentTaskStatus
}>
export type SelectedJobBatchFinalCorrection = Readonly<{
  writer: SelectedJobBatchCorrectionMember; reviewer: SelectedJobBatchCorrectionMember; evidence: SelectedJobBatchPriorEvidence
}>

/** Builds the private prior pair only from the initial graph nodes and its exact immutable receipt. */
export function projectSelectedJobBatchFinalCorrection(input: Readonly<{
  slotId: SelectedJobBatchSlotId; value: unknown; writer: TaskGraphCurrentNode; reviewer: TaskGraphCurrentNode
  writerIndex: number; reviewerIndex: number
}>): SelectedJobBatchFinalCorrection | null {
  const templates = selectedJobBatchTemplatesForSlot(input.slotId), evidence = readEvidence(input.value)
  const writer = member(input.writer, input.writerIndex, templates?.writerTemplateId, "writer")
  const reviewer = member(input.reviewer, input.reviewerIndex, templates?.reviewerTemplateId, "reviewer")
  if (!templates || !evidence || !writer || !reviewer || evidence.writerTaskId !== writer.taskId
    || evidence.reviewerTaskId !== reviewer.taskId || !sameProjection(input.writer.resultProjection, evidence, "writer")
    || !sameProjection(input.reviewer.resultProjection, evidence, "reviewer")) return null
  return { writer, reviewer, evidence }
}

/** Parses a persisted private prior pair and its complete historical receipt/version witness. */
export function readSelectedJobBatchFinalCorrection(
  value: unknown, slotId: SelectedJobBatchSlotId,
): SelectedJobBatchFinalCorrection | null {
  const row = record(value), templates = selectedJobBatchTemplatesForSlot(slotId)
  if (!row || !templates || !exactKeys(row, "evidence,reviewer,writer")) return null
  const writer = readMember(row.writer, templates.writerTemplateId, "writer")
  const reviewer = readMember(row.reviewer, templates.reviewerTemplateId, "reviewer")
  const evidence = readEvidence(row.evidence)
  return writer && reviewer && evidence && evidence.writerTaskId === writer.taskId && evidence.reviewerTaskId === reviewer.taskId
    ? { writer, reviewer, evidence } : null
}

export function finalCorrectionReferenceFollowsPrior(
  prior: SelectedJobBatchFinalCorrection, current: Readonly<{ artifactId: string; version: number; sourceDigest: string }>,
): boolean {
  return current.artifactId === prior.evidence.artifactRef.artifactId && current.sourceDigest === prior.evidence.artifactRef.sourceDigest
    && current.version === prior.evidence.artifactRef.version + 1
}

/** Rebinds current and prior pair members to the complete private final-summary member list. */
export function selectedJobBatchFinalBindingMatches(binding: TaskGraphFinalSummaryBinding, outcome: SelectedJobBatchFinalOutcome): boolean {
  const members = binding.members
  if (!currentBinding(binding) || binding.graphRevision !== outcome.graphRevision || !members
    || members.length !== outcome.slots.reduce((count, slot) => count + (slot.priorPair ? 4 : 2), 0)) return false
  const seen = new Set<number>(), tasks = outcome.slots.flatMap(slot => [slot.writer, slot.reviewer,
    ...(slot.priorPair ? [slot.priorPair.writer, slot.priorPair.reviewer] : [])])
  for (const task of tasks) {
    const member = members[task.nodeIndex]
    if (!member || seen.has(task.nodeIndex) || task.nodeIndex >= members.length || member.nodeIndex !== task.nodeIndex
      || member.nodeKey !== task.nodeKey || member.templateId !== task.templateId || member.taskId !== task.taskId
      || member.taskType !== task.taskType || member.role !== task.role || member.taskStatus !== task.status || member.kind !== "business") return false
    seen.add(task.nodeIndex)
  }
  return seen.size === members.length
}

function currentBinding(binding: TaskGraphFinalSummaryBinding): boolean {
  return safeId(binding.rootTaskId) && safeId(binding.graphItemId) && Number.isSafeInteger(binding.graphRevision)
    && binding.graphRevision > 0 && binding.summary?.graphRevision === binding.graphRevision
}

function readEvidence(value: unknown): SelectedJobBatchPriorEvidence | null {
  const row = record(value), ref = row && record(row.artifactRef), version = row && record(row.artifactVersion)
  const receipt = row && record(row.reviewReceipt)
  if (!row || !exactKeys(row, "artifactRef,artifactVersion,reviewHash,reviewReceipt,reviewStatus,reviewerTaskId,writerTaskId")
    || !ref || !exactKeys(ref, "artifactId,contentHash,sourceDigest,version") || !safeId(ref.artifactId)
    || !Number.isSafeInteger(ref.version) || Number(ref.version) < 1 || !hash(ref.contentHash) || !hash(ref.sourceDigest)
    || !version || !exactKeys(version, "artifactId,artifactType,contentHash,previousHash,sourceDigest,taskId,version")
    || version.artifactType !== "cover_letter" || !safeTask(version.taskId) || version.taskId !== row.writerTaskId
    || version.artifactId !== ref.artifactId || version.version !== ref.version || version.contentHash !== ref.contentHash
    || version.sourceDigest !== ref.sourceDigest || version.previousHash !== null && !hash(version.previousHash)
    || !receipt || !exactKeys(receipt, "artifactId,contentHash,currentSourceDigest,reviewHash,sourceDigest,status,taskId,version")
    || receipt.taskId !== row.reviewerTaskId || receipt.artifactId !== ref.artifactId || receipt.version !== ref.version
    || receipt.contentHash !== ref.contentHash || receipt.sourceDigest !== ref.sourceDigest
    || receipt.currentSourceDigest !== ref.sourceDigest || receipt.status !== "needs_revision"
    || row.reviewStatus !== "needs_revision" || !hash(row.reviewHash) || receipt.reviewHash !== row.reviewHash
    || !safeTask(row.writerTaskId) || !safeTask(row.reviewerTaskId)) return null
  return row as unknown as SelectedJobBatchPriorEvidence
}

function sameProjection(value: unknown, evidence: SelectedJobBatchPriorEvidence, role: "writer" | "reviewer"): boolean {
  const row = record(value), keys = role === "writer" ? "artifactRef,availability,role,schemaVersion,status,trust"
    : "artifactRef,availability,reviewHash,reviewStatus,role,schemaVersion,status,trust"
  const ref = row && record(row.artifactRef), prior = evidence.artifactRef
  return !!row && exactKeys(row, keys) && row.schemaVersion === TASK_GRAPH_RESULT_PROJECTION_SCHEMA
    && row.trust === "untrusted" && row.availability === "available" && row.role === role && row.status === "completed"
    && !!ref && exactKeys(ref, "artifactId,contentHash,sourceDigest,version") && ref.artifactId === prior.artifactId
    && ref.version === prior.version && ref.contentHash === prior.contentHash && ref.sourceDigest === prior.sourceDigest
    && (role === "writer" || row.reviewStatus === "needs_revision" && row.reviewHash === evidence.reviewHash)
}

function member(node: TaskGraphCurrentNode, index: number, templateId: string | undefined, role: "writer" | "reviewer"): SelectedJobBatchCorrectionMember | null {
  if (!templateId || node.templateId !== templateId || node.status !== "completed" || !safeId(node.key) || !safeTask(node.taskId)) return null
  return { nodeIndex: index, nodeKey: node.key, templateId, taskId: node.taskId,
    taskType: role === "writer" ? "cover_letter_draft" : "cover_letter_review", role, status: node.status }
}

function readMember(value: unknown, templateId: string, role: "writer" | "reviewer"): SelectedJobBatchCorrectionMember | null {
  const row = record(value)
  return row && exactKeys(row, "nodeIndex,nodeKey,role,status,taskId,taskType,templateId")
    && Number.isSafeInteger(row.nodeIndex) && Number(row.nodeIndex) >= 0 && row.templateId === templateId
    && row.role === role && row.taskType === (role === "writer" ? "cover_letter_draft" : "cover_letter_review")
    && row.status === "completed" && safeId(row.nodeKey) && safeTask(row.taskId)
    ? row as unknown as SelectedJobBatchCorrectionMember : null
}

function hash(value: unknown): value is string { return typeof value === "string" && SHA256.test(value) }
function safeId(value: unknown): value is string { return typeof value === "string" && SAFE_ID.test(value) }
function safeTask(value: unknown): value is string { return typeof value === "string" && SAFE_TASK_ID.test(value) }
function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  try { return (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null) && Object.getOwnPropertySymbols(value).length === 0 ? value as Record<string, unknown> : null }
  catch { return null }
}
function exactKeys(value: Record<string, unknown>, expected: string): boolean {
  const keys = Reflect.ownKeys(value)
  return keys.every((key): key is string => typeof key === "string") && keys.sort().join(",") === expected
}
