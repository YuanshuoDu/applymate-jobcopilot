import { AGENT_STREAM_SCHEMA_VERSION } from "@jobcopilot/agent-protocol"
import { SCHEDULED_AUDIT_NODE_CRITERIA, SCHEDULED_AUDIT_NODE_GOAL, SCHEDULED_AUDIT_TEMPLATE_ID } from "./scheduled-audit-contract.js"
import type { ScheduledPipelineRecoveryOwner } from "./scheduled-pipeline-recovery-step.js"
import { canonicalTaskGraphJson, parseTaskGraphSnapshot, taskGraphItemId, taskGraphProposalKey, TASK_GRAPH_ITEM_TYPE } from "./task-graph-snapshot.js"
import { projectScheduledPipelineGraph, type ScheduledPipelineGraphVersion } from "./scheduled-pipeline-graph-shape.js"

type Row = Record<string, unknown>
type RecoveryItem = Readonly<{ id?: unknown; sessionId?: unknown; turnId?: unknown; stepId?: unknown; taskId?: unknown;
  type?: unknown; status?: unknown; phase?: unknown; revision?: unknown; content?: unknown }>
type RecoveryEvent = Readonly<{ sessionId?: unknown; turnId?: unknown; taskId?: unknown; itemId?: unknown; type?: unknown;
  actor?: unknown; correlationId?: unknown; causationId?: unknown; idempotencyKey?: unknown; payload?: unknown }>

export function classifyScheduledPipelineRecoveryGraphItem(input: Readonly<{
  owner: ScheduledPipelineRecoveryOwner
  stepId: string
  items: readonly RecoveryItem[]
  events: readonly RecoveryEvent[]
}>): "absent" | "verified_plan" | "invalid" {
  const itemId = taskGraphItemId(input.owner.rootTaskId)
  const candidates = input.items.filter(item => item.id === itemId || item.type === TASK_GRAPH_ITEM_TYPE)
  const receipts = input.events.filter(event => candidateEvent(event, itemId, input.stepId))
  if (!candidates.length) return "absent"
  if (candidates.length !== 1 || receipts.length !== 1) return "invalid"
  const item = record(candidates[0]), event = record(receipts[0]), payload = record(event?.payload)
  const dto = record(payload?.item), receipt = record(payload?.receipt), receiptNodes = receipt?.nodes
  if (!item || !event || !payload || !dto || !receipt || !Array.isArray(receiptNodes) || receiptNodes.length !== 1) return "invalid"
  const graph = record(payload.content), dtoGraph = record(dto.content), rowGraph = record(item.content)
  const revision = payload.revision, nodeReceipt = record(receiptNodes[0]), taskId = nodeReceipt?.taskId
  if (!graph || !dtoGraph || !rowGraph || !nodeReceipt || typeof taskId !== "string" || !validId(taskId)
    || !exactKeys(payload, "content,fingerprint,item,kind,receipt,revision") || payload.kind !== "proposal"
    || typeof payload.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(payload.fingerprint)
    || typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 2
    || !exactKeys(receipt, "nodes,readyTaskIds,revision,status") || receipt.status !== "accepted"
    || receipt.revision !== revision || !same(receipt.readyTaskIds, [taskId])
    || !exactKeys(nodeReceipt, "key,status,taskId") || nodeReceipt.key !== SCHEDULED_AUDIT_TEMPLATE_ID || nodeReceipt.status !== "queued"
    || !exactKeys(dto, "completedAt,content,createdAt,id,phase,revision,schemaVersion,sessionId,startedAt,status,stepId,taskId,turnId,type,updatedAt")
    || dto.schemaVersion !== AGENT_STREAM_SCHEMA_VERSION || dto.id !== itemId || dto.sessionId !== input.owner.sessionId
    || dto.turnId !== input.owner.turnId || dto.stepId !== input.stepId || dto.taskId !== input.owner.rootTaskId
    || dto.type !== TASK_GRAPH_ITEM_TYPE || dto.status !== "streaming" || dto.phase !== null || dto.completedAt !== null
    || dto.revision !== revision || !validIso(dto.startedAt) || !validIso(dto.createdAt) || !validIso(dto.updatedAt)
    || item.id !== itemId || item.sessionId !== input.owner.sessionId || item.turnId !== input.owner.turnId
    || item.stepId !== input.stepId || item.taskId !== input.owner.rootTaskId || item.type !== TASK_GRAPH_ITEM_TYPE
    || item.status !== "streaming" || item.phase !== null || typeof item.revision !== "number" || !Number.isSafeInteger(item.revision)
    || Number(item.revision) < Number(revision) || event.sessionId !== input.owner.sessionId || event.turnId !== input.owner.turnId
    || event.taskId !== input.owner.rootTaskId || event.itemId !== itemId || event.type !== "item.delta"
    || event.actor !== "orchestrator" || event.correlationId !== input.owner.turnId || event.causationId !== input.stepId
    || event.idempotencyKey !== taskGraphProposalKey(input.owner.rootTaskId, Number(revision) - 1)
    || !sameCanonical(payload.content, dto.content) || !sameCanonical(payload.content, item.content)) return "invalid"
  try {
    const snapshot = parseTaskGraphSnapshot(payload.content)
    const nodes = snapshot.nodes
    const version: ScheduledPipelineGraphVersion = nodes[0]?.templateId === "scout" && nodes[1]?.templateId === "analyst" ? "v1" : "v2"
    const projection = projectScheduledPipelineGraph(nodes, version, "audit")
    if (!sameCanonical(payload.content, snapshot) || !projection
      || nodes.some(node => !validId(node.taskId) || node.taskId === input.owner.rootTaskId)
      || new Set(nodes.map(node => node.taskId)).size !== nodes.length) return "invalid"
    const audits = nodes.filter(node => node.key === SCHEDULED_AUDIT_TEMPLATE_ID)
    const audit = projection.audit
    if (audits.length !== 1 || !audit || audit.key !== SCHEDULED_AUDIT_TEMPLATE_ID
      || audit.templateId !== SCHEDULED_AUDIT_TEMPLATE_ID || audit.taskId !== taskId || audit.depth !== 5
      || audit.goal !== SCHEDULED_AUDIT_NODE_GOAL || !same(audit.successCriteria, SCHEDULED_AUDIT_NODE_CRITERIA)
      || !same(audit.dependsOn, ["gate"]) || audit.verificationDisposition !== "specialized") return "invalid"
  } catch { return "invalid" }
  return "verified_plan"
}

function candidateEvent(event: RecoveryEvent, itemId: string, stepId: string): boolean {
  const payload = record(event.payload), dto = record(payload?.item)
  return event.itemId === itemId || dto?.id === itemId
    || typeof event.idempotencyKey === "string" && event.idempotencyKey.startsWith(`${itemId}:proposal:`)
    || event.type === "item.delta" && event.causationId === stepId && payload?.kind === "proposal"
}
function record(value: unknown): Row | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null ? value as Row : null
}
function exactKeys(value: Row, expected: string): boolean {
  return Object.keys(value).sort().join(",") === expected
}
function validId(value: unknown): value is string {
  return typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= 256
    && !/[\u0000-\u001f\u007f]/.test(value)
}
function validIso(value: unknown): value is string {
  if (typeof value !== "string") return false
  const date = new Date(value)
  return Number.isFinite(date.getTime()) && date.toISOString() === value
}
function same(left: unknown, right: unknown): boolean {
  return sameCanonical(left, right)
}
function sameCanonical(left: unknown, right: unknown): boolean {
  try { return canonicalTaskGraphJson(left) === canonicalTaskGraphJson(right) } catch { return false }
}
