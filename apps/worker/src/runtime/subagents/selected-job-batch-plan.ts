import { TASK_GRAPH_LIMITS } from "../planning/task-graph.js"
import type { TaskGraphNodeProposal } from "../planning/task-graph.js"
import {
  isSelectedJobBatchTemplateId,
  parseSelectedJobBatchGraph,
  selectedJobBatchTemplatesForSlot,
  SELECTED_JOB_BATCH_SLOT_IDS,
} from "@jobcopilot/agent-protocol"
import type { SelectedJobBatchSlotId } from "@jobcopilot/agent-protocol"
import type { TaskGraphTaskTemplate } from "./task-graph-command-port.js"

export { SELECTED_JOB_BATCH_SLOT_IDS }
export type { SelectedJobBatchSlotId }
export type SelectedJobBatchSlot = Readonly<{ slotId: SelectedJobBatchSlotId; jobId: string }>
export type SelectedJobBatchTemplateRegistry = Readonly<{
  slots: readonly SelectedJobBatchSlot[]
  templates: Readonly<Record<string, TaskGraphTaskTemplate>>
}>
export type SelectedJobBatchPair = Readonly<{
  slotId: SelectedJobBatchSlotId
  jobId: string
  writerTemplateId: string
  writerNodeKey: string
  reviewerTemplateId: string
  reviewerNodeKey: string
}>

/** Preserves the single-consumer invariant for generic Writer/Reviewer branches. */
export function assertWriterReviewPlan(nodes: readonly TaskGraphNodeProposal[]): void {
  const byKey = new Map(nodes.map(node => [node.key, node] as const)), usedReviewers = new Set<string>()
  for (const writer of nodes) {
    if (writer.templateId !== "cover_letter_writer") continue
    const reviewers = writer.dependsOn.filter(key => byKey.get(key)?.templateId === "cover_letter_reviewer")
    if (reviewers.length > 1 || reviewers.some(key => usedReviewers.has(key))) {
      throw Object.assign(new Error("Selected-job Writer and Reviewer dependencies conflict"), { code: "task_graph_writer_review_conflict" })
    }
    reviewers.forEach(key => usedReviewers.add(key))
  }
}
export type SelectedJobBatchCorrectionProposal = Readonly<{
  slotId: SelectedJobBatchSlotId
  writerNodeKey: string
  reviewerNodeKey: string
  previousReviewerNodeKey: string
}>

export class SelectedJobBatchPlanError extends Error {
  constructor(readonly code: "invalid_slots" | "slot_capacity_exceeded" | "unknown_slot" | "duplicate_slot"
    | "duplicate_job" | "invalid_templates" | "invalid_plan") {
    super(`Selected Job batch plan rejected: ${code}`)
    this.name = "SelectedJobBatchPlanError"
  }
}

type TemplatePrototypes = Readonly<{ writer: TaskGraphTaskTemplate; reviewer: TaskGraphTaskTemplate }>
const MAX_SLOTS = Math.min(SELECTED_JOB_BATCH_SLOT_IDS.length, Math.floor(TASK_GRAPH_LIMITS.maxNodes / 2))

/** Creates only the per-slot registered templates for a trusted server-bound selection. */
export function createSelectedJobBatchTemplateRegistry(value: unknown, prototypes: TemplatePrototypes): SelectedJobBatchTemplateRegistry {
  const slots = parseSlots(value)
  if (!prototypes || prototypes.writer?.role !== "writer" || prototypes.reviewer?.role !== "reviewer") {
    throw new SelectedJobBatchPlanError("invalid_templates")
  }
  const templates: Record<string, TaskGraphTaskTemplate> = Object.create(null) as Record<string, TaskGraphTaskTemplate>
  for (const slot of slots) {
    const ids = templateIds(slot.slotId)
    templates[ids.writer] = bindJob(prototypes.writer, slot.jobId)
    templates[ids.reviewer] = bindJob(prototypes.reviewer, slot.jobId)
  }
  return Object.freeze({ slots, templates: Object.freeze(templates) })
}

/** Reads only an exact, server-built finite slot template registry. */
export function selectedJobBatchSlotsFromTemplates(value: unknown): readonly SelectedJobBatchSlot[] | null {
  if (!plainRecord(value)) return null
  const keys = Object.keys(value)
  if (keys.length < 4 || keys.some(key => !isSelectedJobBatchTemplateId(key))) return null
  const slots: SelectedJobBatchSlot[] = []
  const jobIds = new Set<string>()
  for (const entry of SELECTED_JOB_BATCH_SLOT_IDS.map(slotId => selectedJobBatchTemplatesForSlot(slotId)!)) {
    const writer = value[entry.writerTemplateId], reviewer = value[entry.reviewerTemplateId]
    if (writer === undefined && reviewer === undefined) break
    if (!validRegisteredTemplate(writer, "writer", "cover_letter_draft")
      || !validRegisteredTemplate(reviewer, "reviewer", "cover_letter_review")) return null
    const writerJob = selectedJobTemplateJobId(writer), reviewerJob = selectedJobTemplateJobId(reviewer)
    if (!writerJob || writerJob !== reviewerJob || jobIds.has(writerJob)) return null
    slots.push(Object.freeze({ slotId: entry.slotId, jobId: writerJob })); jobIds.add(writerJob)
  }
  return slots.length >= 2 && keys.length === slots.length * 2 ? Object.freeze(slots) : null
}

/** Requires one immediately runnable Writer and its sole same-slot Reviewer per admitted Job. */
export function pairSelectedJobBatchPlan(nodesValue: unknown, slotsValue: unknown): readonly SelectedJobBatchPair[] {
  const slots = parseSlots(slotsValue)
  if (!Array.isArray(nodesValue) || nodesValue.length !== slots.length * 2
    || nodesValue.length > TASK_GRAPH_LIMITS.maxNodes) throw new SelectedJobBatchPlanError("invalid_plan")
  const nodes = nodesValue.map(readPlanNode)
  const parsed = parseSelectedJobBatchGraph(nodes, slots.map(slot => slot.slotId))
  if (!parsed || parsed.some(slot => slot.correction)) throw new SelectedJobBatchPlanError("invalid_plan")
  return Object.freeze(slots.map((slot, index) => {
    const pair = parsed[index]!.initial, ids = templateIds(slot.slotId)
    return Object.freeze({ slotId: slot.slotId, jobId: slot.jobId, writerTemplateId: ids.writer,
      writerNodeKey: pair.writer.key, reviewerTemplateId: ids.reviewer, reviewerNodeKey: pair.reviewer.key })
  }))
}

/** Validates only the new correction pair; its predecessor is transaction-bound later. */
export function pairSelectedJobBatchCorrectionProposal(nodesValue: unknown, slotsValue: unknown): readonly SelectedJobBatchCorrectionProposal[] {
  const slots = parseSlots(slotsValue)
  if (!Array.isArray(nodesValue) || nodesValue.length < 2 || nodesValue.length > slots.length * 2 || nodesValue.length % 2 !== 0) {
    throw new SelectedJobBatchPlanError("invalid_plan")
  }
  const nodes = nodesValue.map(readPlanNode), keys = new Set<string>()
  const groups = new Map(slots.map(slot => [slot.slotId, { writers: [] as PlanNode[], reviewers: [] as PlanNode[] }] as const))
  for (const node of nodes) {
    if (keys.has(node.key)) throw new SelectedJobBatchPlanError("invalid_plan")
    keys.add(node.key)
    const match = slots.map(slot => ({ slot, ids: templateIds(slot.slotId) })).find(({ ids }) =>
      node.templateId === ids.writer || node.templateId === ids.reviewer)
    if (!match) throw new SelectedJobBatchPlanError("invalid_plan")
    groups.get(match.slot.slotId)![node.templateId === match.ids.writer ? "writers" : "reviewers"].push(node)
  }
  const result: SelectedJobBatchCorrectionProposal[] = []
  for (const slot of slots) {
    const group = groups.get(slot.slotId)!
    if (group.writers.length !== group.reviewers.length || group.writers.length > 1) throw new SelectedJobBatchPlanError("invalid_plan")
    if (group.writers.length === 0) continue
    const writer = group.writers[0]!, reviewer = group.reviewers[0]!
    if (writer.dependsOn.length !== 1 || keys.has(writer.dependsOn[0]!)
      || reviewer.dependsOn.length !== 1 || reviewer.dependsOn[0] !== writer.key) throw new SelectedJobBatchPlanError("invalid_plan")
    result.push(Object.freeze({ slotId: slot.slotId, writerNodeKey: writer.key, reviewerNodeKey: reviewer.key,
      previousReviewerNodeKey: writer.dependsOn[0]! }))
  }
  if (result.length === 0) throw new SelectedJobBatchPlanError("invalid_plan")
  return Object.freeze(result)
}

/** Separates revision-zero batch setup from the only later admitted proposal shape. */
export function selectedJobBatchProposalAccepted(nodesValue: unknown, revision: unknown, hasReplacementMode: boolean, slotsValue: unknown): boolean {
  if (hasReplacementMode || !Number.isSafeInteger(revision) || typeof revision !== "number" || revision < 0 || !Array.isArray(nodesValue)) return false
  if (nodesValue.some(node => !plainRecord(node) || Object.hasOwn(node, "repairOf")
    || Object.hasOwn(node, "verification") || Object.hasOwn(node, "packageRefs"))) return false
  try {
    if (revision === 0) { pairSelectedJobBatchPlan(nodesValue, slotsValue); return true }
    pairSelectedJobBatchCorrectionProposal(nodesValue, slotsValue)
    return true
  } catch { return false }
}

type PlanNode = Readonly<{ key: string; templateId: string; dependsOn: readonly string[] }>
function readPlanNode(value: unknown): PlanNode {
  if (!plainRecord(value) || typeof value.key !== "string" || !value.key.trim()
    || typeof value.templateId !== "string" || !templateIdIsKnown(value.templateId)
    || !Array.isArray(value.dependsOn) || !value.dependsOn.every(dependency => typeof dependency === "string" && dependency.trim())) {
    throw new SelectedJobBatchPlanError("invalid_plan")
  }
  return value as PlanNode
}

function parseSlots(value: unknown): readonly SelectedJobBatchSlot[] {
  if (!Array.isArray(value) || value.length < 2) throw new SelectedJobBatchPlanError("invalid_slots")
  if (value.length > MAX_SLOTS) throw new SelectedJobBatchPlanError("slot_capacity_exceeded")
  const slots: SelectedJobBatchSlot[] = [], slotIds = new Set<string>(), jobIds = new Set<string>()
  for (let index = 0; index < value.length; index++) {
    const row = value[index]
    if (!plainRecord(row) || Object.keys(row).sort().join(",") !== "jobId,slotId"
      || typeof row.slotId !== "string" || typeof row.jobId !== "string" || !row.jobId.trim() || row.jobId.length > 256) {
      throw new SelectedJobBatchPlanError("invalid_slots")
    }
    if (!isSlotId(row.slotId)) throw new SelectedJobBatchPlanError("unknown_slot")
    if (slotIds.has(row.slotId)) throw new SelectedJobBatchPlanError("duplicate_slot")
    if (jobIds.has(row.jobId)) throw new SelectedJobBatchPlanError("duplicate_job")
    if (row.slotId !== SELECTED_JOB_BATCH_SLOT_IDS[index]) throw new SelectedJobBatchPlanError("invalid_slots")
    slotIds.add(row.slotId); jobIds.add(row.jobId)
    slots.push(Object.freeze({ slotId: row.slotId, jobId: row.jobId }))
  }
  return Object.freeze(slots)
}

function templateIds(slotId: SelectedJobBatchSlotId): Readonly<{ writer: string; reviewer: string }> {
  const entry = selectedJobBatchTemplatesForSlot(slotId)
  if (!entry) throw new SelectedJobBatchPlanError("unknown_slot")
  return { writer: entry.writerTemplateId, reviewer: entry.reviewerTemplateId }
}

function templateIdIsKnown(value: string): boolean {
  return isSelectedJobBatchTemplateId(value)
}

function bindJob(template: TaskGraphTaskTemplate, jobId: string): TaskGraphTaskTemplate {
  const context = plainRecord(template.context) ? template.context : {}
  return Object.freeze({ ...template, context: Object.freeze({ ...context,
    selectedJobPreparation: Object.freeze({ jobId }) }) })
}

function validRegisteredTemplate(value: unknown, role: "writer" | "reviewer", taskType: string): value is TaskGraphTaskTemplate {
  if (!plainRecord(value) || value.role !== role || value.taskType !== taskType || !Array.isArray(value.allowedActions)) return false
  const actions = role === "writer" ? ["artifact.version.read", "cover_letter.draft"] : ["artifact.version.read", "artifact.review"]
  return value.allowedActions.every(action => typeof action === "string" && actions.includes(action))
}

function selectedJobTemplateJobId(template: TaskGraphTaskTemplate): string | null {
  const contextValue = template.context
  if (!plainRecord(contextValue)) return null
  const selectedValue = contextValue.selectedJobPreparation
  if (!plainRecord(selectedValue)) return null
  const selected = selectedValue
  return selected && Object.keys(selected).sort().join(",") === "jobId" && typeof selected.jobId === "string"
    && selected.jobId.trim() && selected.jobId.length <= 256 ? selected.jobId : null
}

function isSlotId(value: string): value is SelectedJobBatchSlotId {
  return SELECTED_JOB_BATCH_SLOT_IDS.includes(value as SelectedJobBatchSlotId)
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  try {
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
  } catch { return false }
}
