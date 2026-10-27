import { Buffer } from "node:buffer"
import type { RootTaskVerificationRequirementsResolution } from "./root-task-objective.js"
import { validateTaskGraphCurrentVerificationGraph, parseTaskGraphCurrentVerificationMetadata } from "../canonical-turn-task-graph-verification-context.js"
import { selectTaskGraphObjectiveRequirementLineage } from "../planning/task-graph-objective-lineage.js"
import type { TaskGraphCurrentNode, TaskGraphCurrentState } from "../subagents/task-graph-command-port.js"
import type { ContextSeedBlock } from "./step-context-builder.js"

export const TASK_GRAPH_OBJECTIVE_PROGRESS_OBSERVATION_ID = "task-graph-objective-progress"
const SCHEMA_VERSION = "agent-harness.v2.objective-progress.v1"
const MAX_REQUIREMENTS = 8
const MAX_NODES = 16
const MAX_PACKET_BYTES = 4 * 1024
const MAX_OBSERVATIONS = 512
const NODE_STATUSES = new Set(["queued", "running", "retrying", "waiting", "waiting_for_user", "completed", "failed", "interrupted", "cancelled", "closed"])
const READINESS = new Set(["ready", "waiting_for_dependencies", "blocked_dependency", "active", "terminal"])

export type TaskGraphObjectiveProgressStatus = "missing" | "active" | "failed" | "unverified" | "reported_passed" | "unknown"

type Requirement = Extract<RootTaskVerificationRequirementsResolution, { status: "valid" }>["requirements"][number]
type ProjectionNode = TaskGraphCurrentNode & Readonly<{ verificationDisposition: "typed" | "legacy_unverified" }>

type Input = Readonly<{
  resolution: RootTaskVerificationRequirementsResolution
  observations: readonly ContextSeedBlock[]
  taskGraphRevision?: number
  rootTaskId: string
  taskGraphTemplateRoles?: Readonly<Record<string, string>>
}>

function record(value: unknown): Record<string, unknown> | undefined {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
      ? Reflect.ownKeys(value).every(key => typeof key === "string") ? value as Record<string, unknown> : undefined
      : undefined
  } catch { return undefined }
}

function field(row: Record<string, unknown>, key: string): Readonly<{ ok: true; value: unknown }> | Readonly<{ ok: false }> {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(row, key)
    if (!descriptor) return { ok: true, value: undefined }
    return descriptor.enumerable && Object.hasOwn(descriptor, "value")
      ? { ok: true, value: descriptor.value }
      : { ok: false }
  } catch { return { ok: false } }
}

function denseArray(value: unknown, max: number): unknown[] | undefined {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > max) return undefined
    const descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<string, PropertyDescriptor>
    if (!Number.isSafeInteger(descriptors.length?.value) || Reflect.ownKeys(value).length !== value.length + 1) return undefined
    const output: unknown[] = []
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = descriptors[String(index)]
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) return undefined
      output.push(descriptor.value)
    }
    return output
  } catch { return undefined }
}

function boundedText(value: unknown, max: number, allowEmpty = false): value is string {
  return typeof value === "string" && value.trim() === value && value.length <= max && (allowEmpty || value.length > 0)
}

function activeTemplateRole(roles: Readonly<Record<string, string>> | undefined, templateId: string): string | undefined {
  const registry = record(roles), value = registry && field(registry, templateId)
  return value?.ok && boundedText(value.value, 128) ? value.value : undefined
}

function textList(value: unknown, maxItems: number, maxText: number): string[] | undefined {
  const rows = denseArray(value, maxItems)
  if (!rows) return undefined
  return rows.every(item => boundedText(item, maxText)) ? rows as string[] : undefined
}

function currentNode(value: unknown): ProjectionNode | undefined {
  const row = record(value)
  if (!row) return undefined
  const keyField = field(row, "key"), taskIdField = field(row, "taskId")
  const templateField = field(row, "templateId"), goalField = field(row, "goal")
  const statusField = field(row, "status"), readinessField = field(row, "readiness")
  const criteriaField = field(row, "successCriteria"), dependsOnField = field(row, "dependsOn")
  if (!keyField.ok || !taskIdField.ok || !templateField.ok || !goalField.ok || !statusField.ok || !readinessField.ok
    || !criteriaField.ok || !dependsOnField.ok) return undefined
  const key = keyField.value, taskId = taskIdField.value, templateId = templateField.value, goal = goalField.value
  const status = statusField.value, readiness = readinessField.value
  const successCriteria = textList(criteriaField.value, 8, 320)
  const dependsOn = textList(dependsOnField.value, MAX_NODES, 128)
  if (!boundedText(key, 128) || !boundedText(taskId, 128) || !boundedText(templateId, 128)
    || !boundedText(goal, 1_200) || typeof status !== "string" || !NODE_STATUSES.has(status)
    || typeof readiness !== "string" || !READINESS.has(readiness) || !successCriteria || !dependsOn) return undefined
  const metadata = parseTaskGraphCurrentVerificationMetadata(row, templateId, key, taskId)
  if (!metadata) return undefined
  const node: ProjectionNode = {
    key, taskId, templateId, goal, successCriteria, dependsOn,
    status: status as TaskGraphCurrentNode["status"], readiness: readiness as TaskGraphCurrentNode["readiness"],
    resultSummary: null, failureReason: null, ...metadata,
    verificationDisposition: metadata.verification ? "typed" : "legacy_unverified",
  }
  return node
}

function currentGraph(input: Input): Readonly<{ revision: number; nodes: readonly ProjectionNode[] }> | undefined {
  if (!Number.isSafeInteger(input.taskGraphRevision) || Number(input.taskGraphRevision) < 0
    || !boundedText(input.rootTaskId, 128)) return undefined
  const observations = denseArray(input.observations, MAX_OBSERVATIONS)
  if (!observations) return undefined
  const candidates: Array<Readonly<{ id: unknown; content: unknown }>> = []
  for (const value of observations) {
    const observation = record(value)
    if (!observation) return undefined
    const id = field(observation, "id"), content = field(observation, "content")
    if (!id.ok || !content.ok) return undefined
    const body = record(content.value)
    const kind = body && field(body, "kind")
    if (id.value === "task-graph-current" || kind?.ok && kind.value === "task_graph_current") {
      candidates.push({ id: id.value, content: content.value })
    }
  }
  if (candidates.length !== 1 || candidates[0]?.id !== "task-graph-current") return undefined
  const body = record(candidates[0].content)
  if (!body) return undefined
  const kind = field(body, "kind"), revision = field(body, "revision"), rawNodes = field(body, "nodes")
  if (!kind.ok || kind.value !== "task_graph_current" || !revision.ok || !rawNodes.ok
    || !Number.isSafeInteger(revision.value) || Number(revision.value) < 0
    || revision.value !== input.taskGraphRevision) return undefined
  const values = denseArray(rawNodes.value, MAX_NODES)
  if (!values) return undefined
  const nodes = values.map(currentNode)
  if (nodes.some(node => !node)) return undefined
  const currentNodes = nodes as ProjectionNode[]
  if (!validateTaskGraphCurrentVerificationGraph(currentNodes)) return undefined
  return { revision: Number(revision.value), nodes: currentNodes }
}

function statusFor(requirement: Requirement, nodes: readonly ProjectionNode[], rootTaskId: string,
  templateRoles: Readonly<Record<string, string>> | undefined): TaskGraphObjectiveProgressStatus {
  const selected = selectTaskGraphObjectiveRequirementLineage(requirement, nodes, rootTaskId)
  if (selected.status === "missing") return nodes.some(node => node.verificationCriterionIds?.includes(requirement.id)) ? "unknown" : "missing"
  if (selected.status !== "selected") return "unknown"
  const node = selected.node
  const role = requirement.kind === "candidate_count_gte" ? "scout" : "analyst"
  const check = selected.criterion.check
  if (node.verification?.role !== role || activeTemplateRole(templateRoles, node.templateId) !== role
    || check.kind !== requirement.kind) return "unknown"
  if (check.kind === "candidate_count_gte" || check.kind === "finding_count_gte") {
    if (check.minimum < requirement.minimum) return "unknown"
  } else return "unknown"
  if (["queued", "running", "retrying", "waiting", "waiting_for_user"].includes(node.status)) return "active"
  const report = node.verificationReport
  const criterion = report?.criteria.find(item => item.criterionId === requirement.id)
  if (node.status === "failed" && report?.status === "failed" && criterion?.status === "failed") return "failed"
  if (["failed", "completed"].includes(node.status) && report?.status === "unverified" && criterion?.status === "unverified") return "unverified"
  if (node.status === "completed" && report?.status === "passed" && report.reasonCode === "criteria_met"
    && criterion?.status === "passed" && criterion.reasonCode === "criteria_met") return "reported_passed"
  return "unknown"
}

/** Projects only bounded advisory progress for already-resolved structured requirements and a current owner-read graph. */
export function taskGraphObjectiveProgressObservation(input: Input): ContextSeedBlock | undefined {
  if (input.resolution.status !== "valid" || input.resolution.requirements.length > MAX_REQUIREMENTS) return undefined
  const graph = currentGraph(input)
  const content = {
    schemaVersion: SCHEMA_VERSION, advisory: true, revision: graph?.revision ?? null,
    requirements: input.resolution.requirements.map(requirement => ({
      id: requirement.id, kind: requirement.kind, minimum: requirement.minimum,
      status: graph ? statusFor(requirement, graph.nodes, input.rootTaskId, input.taskGraphTemplateRoles) : "unknown" as const,
    })),
  }
  const observation = { id: TASK_GRAPH_OBJECTIVE_PROGRESS_OBSERVATION_ID, content }
  if (Buffer.byteLength(JSON.stringify(observation), "utf8") > MAX_PACKET_BYTES) return undefined
  return observation
}
