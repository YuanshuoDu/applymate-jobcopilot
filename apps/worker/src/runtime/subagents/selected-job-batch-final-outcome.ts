import { isSelectedJobBatchTemplateId, parseSelectedJobBatchGraph, selectedJobBatchTemplatesForSlot, type SelectedJobBatchSlotId } from "@jobcopilot/agent-protocol"
import type { SelectedJobBatchCompletionWitness } from "../multi-selected-job-completion-gate.js"
import {
  finalCorrectionReferenceFollowsPrior, projectSelectedJobBatchFinalCorrection, readSelectedJobBatchFinalCorrection, selectedJobBatchFinalBindingMatches,
  type SelectedJobBatchFinalCorrection,
} from "./selected-job-batch-final-correction.js"
import { TASK_GRAPH_RESULT_PROJECTION_SCHEMA, type TaskGraphCurrentNode } from "./task-graph-command-port.js"
import { SELECTED_JOB_BATCH_SLOT_IDS } from "./selected-job-batch-plan.js"
import type { TaskGraphFinalSummaryBinding, TaskGraphFinalSummaryMember } from "./task-graph-final-summary-binding.js"
import type { SubagentTaskStatus } from "./types.js"

const SCHEMA = "agent-harness.v2.selected-job-batch-final-outcome.v1"
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const SAFE_TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/
const SHA256 = /^sha256:[a-f0-9]{64}$/
const STATUSES = new Set<SubagentTaskStatus>(["queued", "running", "retrying", "waiting", "waiting_for_user", "completed", "failed", "interrupted", "cancelled", "closed"])
const FAILED = new Set<SubagentTaskStatus>(["failed", "interrupted", "cancelled", "closed"])
const REVIEWS = new Set(["passed", "needs_revision", "rejected"] as const)

export type SelectedJobBatchFinalMember = Readonly<{
  nodeIndex: number; nodeKey: string; templateId: string; taskId: string; taskType: "cover_letter_draft" | "cover_letter_review"
  role: "writer" | "reviewer"; status: SubagentTaskStatus
}>
export type SelectedJobBatchFinalSlot = Readonly<{
  slotId: typeof SELECTED_JOB_BATCH_SLOT_IDS[number]; jobId: string; status: "completed" | "failed"
  writer: SelectedJobBatchFinalMember; reviewer: SelectedJobBatchFinalMember
  priorPair?: SelectedJobBatchFinalCorrection
  artifactRef?: Readonly<{ artifactId: string; version: number; contentHash: string; sourceDigest: string }>
  reviewStatus?: "passed" | "needs_revision" | "rejected"; reviewHash?: string
}>
export type SelectedJobBatchFinalOutcome = Readonly<{
  schemaVersion: typeof SCHEMA; graphRevision: number; slots: readonly SelectedJobBatchFinalSlot[]
}>

/** Attaches only an exact, ready-gate witness that matches the existing private graph binding. */
export function attachSelectedJobBatchFinalOutcome(
  binding: TaskGraphFinalSummaryBinding | null | undefined,
  readyWitness: SelectedJobBatchCompletionWitness,
): TaskGraphFinalSummaryBinding | null {
  if (!binding || binding.selectedJobBatchFinalOutcome !== undefined) return null
  const projection = projectReadyWitness(readyWitness)
  return projection && selectedJobBatchFinalBindingMatches(binding, projection)
    ? { ...binding, selectedJobBatchFinalOutcome: projection } : null
}

/** Detects the closed finite batch templates without changing ordinary graph bindings. */
export function hasSelectedJobBatchMembers(binding: TaskGraphFinalSummaryBinding | null | undefined): boolean {
  return !!binding && Array.isArray(binding.members) && binding.members.some(member => !!member
    && typeof member === "object" && isSelectedJobBatchTemplateId(member.templateId))
}

/** Parses and rebinds the private projection to the exact current summary members. */
export function readBoundSelectedJobBatchFinalOutcome(
  binding: TaskGraphFinalSummaryBinding,
): SelectedJobBatchFinalOutcome | null {
  const outcome = readSelectedJobBatchFinalOutcome(binding.selectedJobBatchFinalOutcome, binding.graphRevision)
  return outcome && selectedJobBatchFinalBindingMatches(binding, outcome) ? outcome : null
}

export function readSelectedJobBatchFinalOutcome(value: unknown, graphRevision: number): SelectedJobBatchFinalOutcome | null {
  const row = record(value), slots = row && dense(row.slots, 3)
  if (!row || !exactKeys(row, "graphRevision,schemaVersion,slots") || row.schemaVersion !== SCHEMA
    || !Number.isSafeInteger(graphRevision) || graphRevision < 1 || row.graphRevision !== graphRevision
    || !slots || slots.length < 2) return null
  const parsed: SelectedJobBatchFinalSlot[] = [], jobs = new Set<string>(), tasks = new Set<string>(), keys = new Set<string>(), indices = new Set<number>()
  for (let index = 0; index < slots.length; index++) {
    const slot = parseSlot(slots[index], index)
    if (!slot || jobs.has(slot.jobId)) return null
    jobs.add(slot.jobId)
    for (const member of [slot.writer, slot.reviewer, ...(slot.priorPair ? [slot.priorPair.writer, slot.priorPair.reviewer] : [])]) {
      if (tasks.has(member.taskId) || keys.has(member.nodeKey) || indices.has(member.nodeIndex)) return null
      tasks.add(member.taskId); keys.add(member.nodeKey); indices.add(member.nodeIndex)
    }
    parsed.push(slot)
  }
  const orderedIndices = [...indices].sort((left, right) => left - right)
  const memberCount = parsed.reduce((count, slot) => count + (slot.priorPair ? 4 : 2), 0)
  if (memberCount > 8 || indices.size !== memberCount || orderedIndices.some((value, index) => value !== index)) return null
  return { schemaVersion: SCHEMA, graphRevision, slots: parsed }
}

/** Static, bounded text; it never renders job IDs, artifacts, receipts, findings, or model prose. */
export function renderSelectedJobBatchFinalOutcome(binding: TaskGraphFinalSummaryBinding): string[] {
  const hasBatch = hasSelectedJobBatchMembers(binding), hasProjection = binding.selectedJobBatchFinalOutcome !== undefined
  if (!hasBatch && !hasProjection) return []
  const outcome = hasBatch ? readBoundSelectedJobBatchFinalOutcome(binding) : null
  if (!outcome) return ["Per-Job preparation outcomes: unavailable (current verified batch proof is missing)."]
  return ["Per-Job preparation outcomes:", ...outcome.slots.map((slot, index) => slot.status === "completed"
    ? `Job ${index + 1}: Writer completed; Reviewer completed; review ${reviewLabel(slot.reviewStatus)}.`
    : `Job ${index + 1}: preparation failed; Writer ${slot.writer.status}; Reviewer ${slot.reviewer.status}.`)]
}

function projectReadyWitness(value: unknown): SelectedJobBatchFinalOutcome | null {
  const witness = record(value), graph = witness && record(witness.graph)
  const outcomes = witness && dense(witness.slots, 3), nodes = graph && dense(graph.nodes, 8)
  if (!witness || !exactKeys(witness, "graph,slots") || !graph || !exactKeys(graph, "nodes,revision")
    || !Number.isSafeInteger(graph.revision) || Number(graph.revision) < 1 || !outcomes || outcomes.length < 2
    || !nodes || nodes.length < outcomes.length * 2 || nodes.length > Math.min(outcomes.length * 4, 8)) return null
  const slotIds = outcomes.map(value => record(value)?.slotId)
  if (slotIds.some((slot, index) => slot !== SELECTED_JOB_BATCH_SLOT_IDS[index])) return null
  const chains = parseSelectedJobBatchGraph(nodes as TaskGraphCurrentNode[], slotIds as SelectedJobBatchSlotId[])
  if (!chains || chains.length !== outcomes.length) return null
  const byKey = new Map<string, { node: Record<string, unknown>; index: number }>()
  for (let index = 0; index < nodes.length; index++) {
    const node = record(nodes[index])
    if (!node || typeof node.key !== "string" || byKey.has(node.key)) return null
    byKey.set(node.key, { node, index })
  }
  const slots: SelectedJobBatchFinalSlot[] = []
  for (let index = 0; index < chains.length; index++) {
    const chain = chains[index]!, outcome = record(outcomes[index])
    const writer = byKey.get(chain.effective.writer.key), reviewer = byKey.get(chain.effective.reviewer.key)
    if (!outcome || !writer || !reviewer || outcome.slotId !== chain.slotId || !safeId(outcome.jobId)) return null
    const writerMember = member(writer, chain.effective.writer.templateId, "writer"), reviewerMember = member(reviewer, chain.effective.reviewer.templateId, "reviewer")
    if (!writerMember || !reviewerMember) return null
    const priorPair = chain.correction ? projectSelectedJobBatchFinalCorrection({
      slotId: chain.slotId, value: outcome.priorEvidence, writer: chain.initial.writer, reviewer: chain.initial.reviewer,
      writerIndex: byKey.get(chain.initial.writer.key)?.index ?? -1, reviewerIndex: byKey.get(chain.initial.reviewer.key)?.index ?? -1,
    }) : undefined
    if (chain.correction && !priorPair || !chain.correction && Object.hasOwn(outcome, "priorEvidence")) return null
    if (outcome.status === "completed") {
      const expected = chain.correction ? "evidence,jobId,priorEvidence,reviewerTaskId,slotId,status,writerTaskId" : "evidence,jobId,reviewerTaskId,slotId,status,writerTaskId"
      if (!exactKeys(outcome, expected)
        || writerMember.status !== "completed" || reviewerMember.status !== "completed"
        || outcome.writerTaskId !== writerMember.taskId || outcome.reviewerTaskId !== reviewerMember.taskId) return null
      const evidence = completedEvidence(outcome.evidence, writerMember.taskId, reviewerMember.taskId, writer.node.resultProjection, reviewer.node.resultProjection)
      if (!evidence) return null
      slots.push({ slotId: chain.slotId, jobId: String(outcome.jobId), status: "completed", writer: writerMember, reviewer: reviewerMember,
        artifactRef: evidence.artifactRef, reviewStatus: evidence.reviewStatus, reviewHash: evidence.reviewHash, ...(priorPair ? { priorPair } : {}) })
    } else if (outcome.status === "failed") {
      const expected = chain.correction ? "jobId,priorEvidence,reviewerTaskId,slotId,status,writerTaskId" : "jobId,reviewerTaskId,slotId,status,writerTaskId"
      if (!exactKeys(outcome, expected)
        || !failedBranch(writerMember.status, reviewerMember.status)
        || outcome.writerTaskId !== writerMember.taskId || outcome.reviewerTaskId !== reviewerMember.taskId) return null
      slots.push({ slotId: chain.slotId, jobId: String(outcome.jobId), status: "failed", writer: writerMember, reviewer: reviewerMember,
        ...(priorPair ? { priorPair } : {}) })
    } else return null
  }
  const projection = { schemaVersion: SCHEMA, graphRevision: Number(graph.revision), slots }
  return readSelectedJobBatchFinalOutcome(projection, projection.graphRevision)
}

function completedEvidence(value: unknown, writerTaskId: string, reviewerTaskId: string, writerProjection: unknown, reviewerProjection: unknown) {
  const evidence = record(value), artifactRef = evidence && readArtifactRef(evidence.artifactRef)
  const version = evidence && record(evidence.artifactVersion), receipt = evidence && record(evidence.reviewReceipt)
  if (!evidence || !exactKeys(evidence, "artifactRef,artifactVersion,reviewReceipt") || !artifactRef || !version || !receipt
    || !exactKeys(version, "artifactId,artifactType,contentHash,previousHash,sourceDigest,taskId,version")
    || version.artifactType !== "cover_letter" || version.taskId !== writerTaskId || version.artifactId !== artifactRef.artifactId
    || version.version !== artifactRef.version || version.contentHash !== artifactRef.contentHash || version.sourceDigest !== artifactRef.sourceDigest
    || version.previousHash !== null && !hash(version.previousHash)
    || !exactKeys(receipt, "artifactId,contentHash,currentSourceDigest,reviewHash,sourceDigest,status,taskId,version")
    || receipt.taskId !== reviewerTaskId || receipt.artifactId !== artifactRef.artifactId || receipt.version !== artifactRef.version
    || receipt.contentHash !== artifactRef.contentHash || receipt.sourceDigest !== artifactRef.sourceDigest
    || receipt.currentSourceDigest !== artifactRef.sourceDigest || !isReview(receipt.status) || !hash(receipt.reviewHash)) return null
  const writer = projectionReference(writerProjection, "writer"), reviewer = projectionReference(reviewerProjection, "reviewer")
  return writer && reviewer && sameArtifact(artifactRef, writer) && sameArtifact(artifactRef, reviewer)
    && reviewer.status === receipt.status && reviewer.reviewHash === receipt.reviewHash
    ? { artifactRef, reviewStatus: receipt.status, reviewHash: receipt.reviewHash } : null
}

function projectionReference(value: unknown, role: "writer" | "reviewer") {
  const row = record(value)
  const keys = role === "writer" ? "artifactRef,availability,role,schemaVersion,status,trust"
    : "artifactRef,availability,reviewHash,reviewStatus,role,schemaVersion,status,trust"
  if (!row || !exactKeys(row, keys) || row.schemaVersion !== TASK_GRAPH_RESULT_PROJECTION_SCHEMA
    || row.trust !== "untrusted" || row.availability !== "available" || row.role !== role || row.status !== "completed") return null
  const artifactRef = readArtifactRef(row.artifactRef)
  if (!artifactRef || role === "reviewer" && (!isReview(row.reviewStatus) || !hash(row.reviewHash))) return null
  return { ...artifactRef, ...(role === "reviewer" ? { status: row.reviewStatus, reviewHash: row.reviewHash } : {}) }
}

function member(value: { node: Record<string, unknown>; index: number }, templateId: string, role: "writer" | "reviewer"): SelectedJobBatchFinalMember | null {
  const node = value.node
  if (node.templateId !== templateId || !safeNodeId(node.key) || !safeTaskId(node.taskId) || !isStatus(node.status)) return null
  return { nodeIndex: value.index, nodeKey: node.key, templateId, taskId: node.taskId,
    taskType: role === "writer" ? "cover_letter_draft" : "cover_letter_review", role, status: node.status }
}

function parseSlot(value: unknown, index: number): SelectedJobBatchFinalSlot | null {
  const slot = record(value), expectedSlot = SELECTED_JOB_BATCH_SLOT_IDS[index]
  const templates = selectedJobBatchTemplatesForSlot(expectedSlot)
  if (!slot || !expectedSlot || slot.slotId !== expectedSlot || !safeId(slot.jobId)
    || !templates || !exactTask(slot.writer, templates.writerTemplateId, "cover_letter_draft", "writer")
    || !exactTask(slot.reviewer, templates.reviewerTemplateId, "cover_letter_review", "reviewer")) return null
  const priorPair = Object.hasOwn(slot, "priorPair") ? readSelectedJobBatchFinalCorrection(slot.priorPair, expectedSlot) : undefined
  if (Object.hasOwn(slot, "priorPair") && (!priorPair || priorPair.writer.taskId === slot.writer.taskId
    || priorPair.reviewer.taskId === slot.reviewer.taskId)) return null
  if (slot.status === "completed" && exactKeys(slot, priorPair
    ? "artifactRef,jobId,priorPair,reviewHash,reviewStatus,reviewer,slotId,status,writer"
    : "artifactRef,jobId,reviewHash,reviewStatus,reviewer,slotId,status,writer")) {
    const artifactRef = readArtifactRef(slot.artifactRef)
    return artifactRef && slot.writer.status === "completed" && slot.reviewer.status === "completed"
      && isReview(slot.reviewStatus) && hash(slot.reviewHash) && (!priorPair || finalCorrectionReferenceFollowsPrior(priorPair, artifactRef))
      ? { slotId: expectedSlot, jobId: slot.jobId, status: "completed", writer: slot.writer, reviewer: slot.reviewer,
        artifactRef, reviewStatus: slot.reviewStatus, reviewHash: slot.reviewHash, ...(priorPair ? { priorPair } : {}) } : null
  }
  return slot.status === "failed" && exactKeys(slot, priorPair
    ? "jobId,priorPair,reviewer,slotId,status,writer" : "jobId,reviewer,slotId,status,writer")
    && failedBranch(slot.writer.status, slot.reviewer.status)
    ? { slotId: expectedSlot, jobId: slot.jobId, status: "failed", writer: slot.writer, reviewer: slot.reviewer,
      ...(priorPair ? { priorPair } : {}) } : null
}

function exactTask(value: unknown, templateId: string, taskType: "cover_letter_draft" | "cover_letter_review", role: "writer" | "reviewer"): value is SelectedJobBatchFinalMember {
  const task = record(value)
  return !!task && exactKeys(task, "nodeIndex,nodeKey,role,status,taskId,taskType,templateId")
    && Number.isSafeInteger(task.nodeIndex) && Number(task.nodeIndex) >= 0 && safeNodeId(task.nodeKey)
    && safeTaskId(task.taskId) && task.role === role && task.taskType === taskType && task.templateId === templateId && isStatus(task.status)
}

function readArtifactRef(value: unknown) {
  const row = record(value)
  return row && exactKeys(row, "artifactId,contentHash,sourceDigest,version") && safeId(row.artifactId) && Number.isSafeInteger(row.version)
    && Number(row.version) > 0 && hash(row.contentHash) && hash(row.sourceDigest)
    ? { artifactId: row.artifactId, version: Number(row.version), contentHash: row.contentHash, sourceDigest: row.sourceDigest } : null
}
function sameArtifact(left: NonNullable<ReturnType<typeof readArtifactRef>>, right: NonNullable<ReturnType<typeof readArtifactRef>>): boolean {
  return left.artifactId === right.artifactId && left.version === right.version && left.contentHash === right.contentHash && left.sourceDigest === right.sourceDigest
}
function failedBranch(writer: SubagentTaskStatus, reviewer: SubagentTaskStatus): boolean {
  return FAILED.has(reviewer) && (FAILED.has(writer) || writer === "completed")
}
function isStatus(value: unknown): value is SubagentTaskStatus { return typeof value === "string" && STATUSES.has(value as SubagentTaskStatus) }
function isReview(value: unknown): value is "passed" | "needs_revision" | "rejected" { return typeof value === "string" && REVIEWS.has(value as "passed" | "needs_revision" | "rejected") }
function reviewLabel(value: SelectedJobBatchFinalSlot["reviewStatus"]): string { return value === "needs_revision" ? "needs revision" : value ?? "unavailable" }
function hash(value: unknown): value is string { return typeof value === "string" && SHA256.test(value) }
function safeId(value: unknown): value is string { return typeof value === "string" && SAFE_ID.test(value) }
function safeTaskId(value: unknown): value is string { return typeof value === "string" && SAFE_TASK_ID.test(value) }
function safeNodeId(value: unknown): value is string { return typeof value === "string" && value.length <= 128 && value.trim() === value && SAFE_ID.test(value) }
function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  try { return (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null) && Object.getOwnPropertySymbols(value).length === 0 ? value as Record<string, unknown> : null }
  catch { return null }
}
function exactKeys(value: Record<string, unknown>, expected: string): boolean {
  const keys = Reflect.ownKeys(value)
  return keys.every((key): key is string => typeof key === "string") && keys.sort().join(",") === expected
}
function dense(value: unknown, maximum: number): unknown[] | null {
  if (!Array.isArray(value) || value.length > maximum || Reflect.ownKeys(value).length !== value.length + 1) return null
  return Reflect.ownKeys(value).every(key => key === "length" || typeof key === "string" && /^(0|[1-9][0-9]*)$/.test(key) && Number(key) < value.length) ? value : null
}
