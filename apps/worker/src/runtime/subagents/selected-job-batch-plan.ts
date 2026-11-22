import { TASK_GRAPH_LIMITS } from "../planning/task-graph.js"
import {
  isSelectedJobBatchTemplateId,
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

/** Requires one immediately runnable Writer and its sole same-slot Reviewer per admitted Job. */
export function pairSelectedJobBatchPlan(nodesValue: unknown, slotsValue: unknown): readonly SelectedJobBatchPair[] {
  const slots = parseSlots(slotsValue)
  if (!Array.isArray(nodesValue) || nodesValue.length !== slots.length * 2
    || nodesValue.length > TASK_GRAPH_LIMITS.maxNodes) throw new SelectedJobBatchPlanError("invalid_plan")
  const nodes = nodesValue.map(readPlanNode)
  const byTemplate = new Map<string, PlanNode>()
  const keys = new Set<string>()
  for (const node of nodes) {
    if (keys.has(node.key) || byTemplate.has(node.templateId)) throw new SelectedJobBatchPlanError("invalid_plan")
    keys.add(node.key)
    byTemplate.set(node.templateId, node)
  }
  return Object.freeze(slots.map(slot => {
    const ids = templateIds(slot.slotId), writer = byTemplate.get(ids.writer), reviewer = byTemplate.get(ids.reviewer)
    if (!writer || !reviewer || writer.dependsOn.length !== 0
      || reviewer.dependsOn.length !== 1 || reviewer.dependsOn[0] !== writer.key) {
      throw new SelectedJobBatchPlanError("invalid_plan")
    }
    return Object.freeze({ slotId: slot.slotId, jobId: slot.jobId, writerTemplateId: ids.writer,
      writerNodeKey: writer.key, reviewerTemplateId: ids.reviewer, reviewerNodeKey: reviewer.key })
  }))
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
