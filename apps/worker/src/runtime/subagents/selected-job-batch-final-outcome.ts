import { isSelectedJobBatchTemplateId, selectedJobBatchTemplatesForSlot } from "@jobcopilot/agent-protocol"
import type { SelectedJobBatchCompletionWitness } from "../multi-selected-job-completion-gate.js"
import { TASK_GRAPH_RESULT_PROJECTION_SCHEMA } from "./task-graph-command-port.js"
import { SELECTED_JOB_BATCH_SLOT_IDS, pairSelectedJobBatchPlan } from "./selected-job-batch-plan.js"
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
  if (!binding || binding.selectedJobBatchFinalOutcome !== undefined || !baseBindingIsCurrent(binding)) return null
  const projection = projectReadyWitness(readyWitness)
  return projection && projection.graphRevision === binding.graphRevision && matchesBinding(binding, projection)
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
  return outcome && matchesBinding(binding, outcome) ? outcome : null
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
    for (const member of [slot.writer, slot.reviewer]) {
      if (tasks.has(member.taskId) || keys.has(member.nodeKey) || indices.has(member.nodeIndex)) return null
      tasks.add(member.taskId); keys.add(member.nodeKey); indices.add(member.nodeIndex)
    }
    parsed.push(slot)
  }
  const orderedIndices = [...indices].sort((left, right) => left - right)
  if (indices.size !== slots.length * 2 || orderedIndices.some((value, index) => value !== index)) return null
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
  const outcomes = witness && dense(witness.slots, 3), nodes = graph && dense(graph.nodes, 6)
  if (!witness || !exactKeys(witness, "graph,slots") || !graph || !exactKeys(graph, "nodes,revision")
    || !Number.isSafeInteger(graph.revision) || Number(graph.revision) < 1 || !outcomes || outcomes.length < 2
    || !nodes || nodes.length !== outcomes.length * 2) return null
  let pairs: ReturnType<typeof pairSelectedJobBatchPlan>
  try { pairs = pairSelectedJobBatchPlan(nodes, outcomes.map(slotIdentity)) } catch { return null }
  if (pairs.length !== outcomes.length) return null
  const byKey = new Map<string, { node: Record<string, unknown>; index: number }>()
  for (let index = 0; index < nodes.length; index++) {
    const node = record(nodes[index])
    if (!node || typeof node.key !== "string" || byKey.has(node.key)) return null
    byKey.set(node.key, { node, index })
  }
  const slots: SelectedJobBatchFinalSlot[] = []
  for (let index = 0; index < pairs.length; index++) {
    const pair = pairs[index]!, outcome = record(outcomes[index])
    const writer = byKey.get(pair.writerNodeKey), reviewer = byKey.get(pair.reviewerNodeKey)
    if (!outcome || !writer || !reviewer || outcome.slotId !== pair.slotId || outcome.jobId !== pair.jobId) return null
    const writerMember = member(writer, pair.writerTemplateId, "writer"), reviewerMember = member(reviewer, pair.reviewerTemplateId, "reviewer")
    if (!writerMember || !reviewerMember) return null
    if (outcome.status === "completed") {
      if (!exactKeys(outcome, "evidence,jobId,reviewerTaskId,slotId,status,writerTaskId")
        || writerMember.status !== "completed" || reviewerMember.status !== "completed"
        || outcome.writerTaskId !== writerMember.taskId || outcome.reviewerTaskId !== reviewerMember.taskId) return null
      const evidence = completedEvidence(outcome.evidence, reviewerMember.taskId, writer.node.resultProjection, reviewer.node.resultProjection)
      if (!evidence) return null
      slots.push({ slotId: pair.slotId, jobId: pair.jobId, status: "completed", writer: writerMember, reviewer: reviewerMember,
        artifactRef: evidence.artifactRef, reviewStatus: evidence.reviewStatus, reviewHash: evidence.reviewHash })
    } else if (outcome.status === "failed") {
      if (!exactKeys(outcome, "jobId,reviewerTaskId,slotId,status,writerTaskId")
        || !failedBranch(writerMember.status, reviewerMember.status)
        || outcome.writerTaskId !== writerMember.taskId || outcome.reviewerTaskId !== reviewerMember.taskId) return null
      slots.push({ slotId: pair.slotId, jobId: pair.jobId, status: "failed", writer: writerMember, reviewer: reviewerMember })
    } else return null
  }
  const projection = { schemaVersion: SCHEMA, graphRevision: Number(graph.revision), slots }
  return readSelectedJobBatchFinalOutcome(projection, projection.graphRevision)
}

function completedEvidence(value: unknown, reviewerTaskId: string, writerProjection: unknown, reviewerProjection: unknown) {
  const evidence = record(value), artifactRef = evidence && readArtifactRef(evidence.artifactRef)
  const receipt = evidence && record(evidence.reviewReceipt)
  if (!evidence || !exactKeys(evidence, "artifactRef,reviewReceipt") || !artifactRef || !receipt
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

function matchesBinding(binding: TaskGraphFinalSummaryBinding, outcome: SelectedJobBatchFinalOutcome): boolean {
  const members = binding.members
  if (!baseBindingIsCurrent(binding) || binding.graphRevision !== outcome.graphRevision || !members
    || members.length !== outcome.slots.length * 2) return false
  const seen = new Set<number>()
  for (const slot of outcome.slots) for (const task of [slot.writer, slot.reviewer]) {
    const member = members[task.nodeIndex]
    if (!member || seen.has(task.nodeIndex) || task.nodeIndex >= members.length || member.nodeIndex !== task.nodeIndex
      || member.nodeKey !== task.nodeKey || member.templateId !== task.templateId || member.taskId !== task.taskId
      || member.taskType !== task.taskType || member.role !== task.role || member.taskStatus !== task.status || member.kind !== "business") return false
    seen.add(task.nodeIndex)
  }
  return seen.size === members.length
}

function baseBindingIsCurrent(binding: TaskGraphFinalSummaryBinding): boolean {
  return safeNodeId(binding.rootTaskId) && safeNodeId(binding.graphItemId)
    && Number.isSafeInteger(binding.graphRevision) && binding.graphRevision > 0
    && binding.summary?.graphRevision === binding.graphRevision
}

function parseSlot(value: unknown, index: number): SelectedJobBatchFinalSlot | null {
  const slot = record(value), expectedSlot = SELECTED_JOB_BATCH_SLOT_IDS[index]
  const templates = selectedJobBatchTemplatesForSlot(expectedSlot)
  if (!slot || !expectedSlot || slot.slotId !== expectedSlot || !safeId(slot.jobId)
    || !templates || !exactTask(slot.writer, templates.writerTemplateId, "cover_letter_draft", "writer")
    || !exactTask(slot.reviewer, templates.reviewerTemplateId, "cover_letter_review", "reviewer")) return null
  if (slot.status === "completed" && exactKeys(slot, "artifactRef,jobId,reviewHash,reviewStatus,reviewer,slotId,status,writer")) {
    const artifactRef = readArtifactRef(slot.artifactRef)
    return artifactRef && slot.writer.status === "completed" && slot.reviewer.status === "completed"
      && isReview(slot.reviewStatus) && hash(slot.reviewHash)
      ? { slotId: expectedSlot, jobId: slot.jobId, status: "completed", writer: slot.writer, reviewer: slot.reviewer,
        artifactRef, reviewStatus: slot.reviewStatus, reviewHash: slot.reviewHash } : null
  }
  return slot.status === "failed" && exactKeys(slot, "jobId,reviewer,slotId,status,writer")
    && failedBranch(slot.writer.status, slot.reviewer.status)
    ? { slotId: expectedSlot, jobId: slot.jobId, status: "failed", writer: slot.writer, reviewer: slot.reviewer } : null
}

function exactTask(value: unknown, templateId: string, taskType: "cover_letter_draft" | "cover_letter_review", role: "writer" | "reviewer"): value is SelectedJobBatchFinalMember {
  const task = record(value)
  return !!task && exactKeys(task, "nodeIndex,nodeKey,role,status,taskId,taskType,templateId")
    && Number.isSafeInteger(task.nodeIndex) && Number(task.nodeIndex) >= 0 && safeNodeId(task.nodeKey)
    && safeTaskId(task.taskId) && task.role === role && task.taskType === taskType && task.templateId === templateId && isStatus(task.status)
}

function slotIdentity(value: unknown): unknown {
  const row = record(value)
  return row ? { slotId: row.slotId, jobId: row.jobId } : value
}
function readArtifactRef(value: unknown) {
  const row = record(value)
  return row && exactKeys(row, "artifactId,contentHash,sourceDigest,version") && safeId(row.artifactId)
    && Number.isSafeInteger(row.version) && Number(row.version) > 0 && hash(row.contentHash) && hash(row.sourceDigest)
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
