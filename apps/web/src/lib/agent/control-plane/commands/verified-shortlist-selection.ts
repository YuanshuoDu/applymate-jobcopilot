import { TurnIntentSchema, parseTaskGraphSnapshot, validate } from "@jobcopilot/agent-protocol"

import { projectInteractiveDiscoveryShortlist } from "@/app/api/agent/sessions/[id]/tasks/interactive-discovery-shortlist"
import { canonicalTaskGraphItemId } from "@/lib/agent/session/final-task-graph-source-detail"
import type { CommandTransaction } from "./transaction"

export const VERIFIED_SHORTLIST_SELECTION_SCHEMA = "agent-harness.v2.verified-shortlist-selection.v1" as const

export type VerifiedShortlistSourceIdentity = Readonly<{
  sessionId: string
  sourceTurnId: string
  rootTaskId: string
  graphItemId: string
  graphRevision: number
}>

export type VerifiedShortlistSelectionBinding = Readonly<{
  schemaVersion: typeof VERIFIED_SHORTLIST_SELECTION_SCHEMA
  source: VerifiedShortlistSourceIdentity
  selectedJobIds: readonly string[]
}>

type LockedOwnerSession = Readonly<{ id: string; userId: string }>
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/
const SOURCE_KEYS = ["sessionId", "sourceTurnId", "rootTaskId", "graphItemId", "graphRevision"] as const
const BINDING_KEYS = ["schemaVersion", "source", "selectedJobIds"] as const

/** Rechecks source proof and owned Jobs inside the caller's locked Session transaction. */
export async function verifyVerifiedShortlistSelection(
  tx: CommandTransaction,
  owner: LockedOwnerSession,
  sourceValue: unknown,
  selectionValue: unknown,
): Promise<VerifiedShortlistSelectionBinding | null> {
  if (!safeId(owner.id) || !safeId(owner.userId)) return null
  const source = parseSource(sourceValue)
  const selected = parseSelectedJobIds(selectionValue)
  if (!source || source.sessionId !== owner.id || !selected) return null

  const turn = await tx.agentTurn.findFirst({
    where: { id: source.sourceTurnId, sessionId: owner.id, userId: owner.userId, source: "user", status: "completed", rootTaskId: source.rootTaskId },
    select: { id: true, sessionId: true, userId: true, source: true, status: true, rootTaskId: true, executionMode: true, input: true },
  })
  // The discovery entry persists its exact typed intent with a null mode; terminal Root and graph proof establish canonical execution.
  if (!turn || turn.id !== source.sourceTurnId || turn.sessionId !== owner.id || turn.userId !== owner.userId
    || turn.source !== "user" || turn.status !== "completed" || turn.rootTaskId !== source.rootTaskId
    || (turn.executionMode !== null && turn.executionMode !== "canonical_task_graph") || !hasDiscoveryIntent(turn.input)) return null

  const root = await tx.subAgentTask.findFirst({
    where: { id: source.rootTaskId, sessionId: owner.id, turnId: source.sourceTurnId, rootTaskId: source.rootTaskId,
      parentTaskId: null, role: "orchestrator", taskType: "root", status: "completed", failureReason: null },
    select: { id: true, sessionId: true, turnId: true, rootTaskId: true, parentTaskId: true, role: true, taskType: true,
      status: true, failureReason: true, result: true },
  })
  const rootResult = dataRecord(root?.result)
  const shortlist = root && root.id === source.rootTaskId && root.sessionId === owner.id && root.turnId === source.sourceTurnId
    && root.rootTaskId === source.rootTaskId && root.parentTaskId === null && root.role === "orchestrator"
    && root.taskType === "root" && root.status === "completed" && root.failureReason === null && rootResult?.status === "completed"
    ? projectInteractiveDiscoveryShortlist(root.result) : null
  if (!shortlist || shortlist.status !== "completed") return null

  const graph = await tx.agentItem.findFirst({
    where: { id: source.graphItemId, sessionId: owner.id, turnId: source.sourceTurnId, taskId: source.rootTaskId,
      type: "task_graph", revision: source.graphRevision },
    select: { id: true, sessionId: true, turnId: true, taskId: true, type: true, revision: true, content: true },
  })
  const snapshot = graph ? parseTaskGraphSnapshot(graph.content) : null
  if (!graph || graph.id !== source.graphItemId || graph.sessionId !== owner.id || graph.turnId !== source.sourceTurnId
    || graph.taskId !== source.rootTaskId || graph.type !== "task_graph" || graph.revision !== source.graphRevision
    || !snapshot || snapshot.nodes.length === 0) return null

  const selectedSet = new Set(selected)
  const selectedJobIds = shortlist.items.map(item => item.jobId).filter(jobId => selectedSet.has(jobId))
  if (selectedJobIds.length !== selected.length) return null
  const jobs = await tx.job.findMany({ where: { userId: owner.userId, id: { in: selectedJobIds } }, select: { id: true } })
  const ownedJobs = new Set(jobs.map(job => job.id))
  if (jobs.length !== selectedJobIds.length || ownedJobs.size !== selectedJobIds.length
    || selectedJobIds.some(id => !ownedJobs.has(id))) return null

  return freezeBinding(source, selectedJobIds)
}

/** Compares the persisted command intent to a fresh, canonicalized source/selection binding. */
export function sameVerifiedShortlistSelectionBinding(persisted: unknown, expected: VerifiedShortlistSelectionBinding): boolean {
  const left = parseBinding(persisted)
  const right = parseBinding(expected)
  return Boolean(left && right && sameSource(left.source, right.source)
    && left.selectedJobIds.length === right.selectedJobIds.length
    && left.selectedJobIds.every((id, index) => id === right.selectedJobIds[index]))
}

function hasDiscoveryIntent(value: unknown): boolean {
  const input = dataRecord(value)
  const intent = dataRecord(input?.intent, ["kind", "version"])
  return Boolean(intent && validate(TurnIntentSchema, intent)
    && intent.kind === "interactive_discovery_shortlist" && intent.version === 1)
}

function parseSource(value: unknown): VerifiedShortlistSourceIdentity | null {
  const source = dataRecord(value, SOURCE_KEYS)
  if (!source || !safeId(source.sessionId) || !safeId(source.sourceTurnId) || !safeId(source.rootTaskId)
    || !safeId(source.graphItemId) || !Number.isSafeInteger(source.graphRevision) || Number(source.graphRevision) < 1) return null
  if (source.graphItemId !== canonicalTaskGraphItemId(source.rootTaskId)) return null
  return Object.freeze({ sessionId: source.sessionId, sourceTurnId: source.sourceTurnId, rootTaskId: source.rootTaskId,
    graphItemId: source.graphItemId, graphRevision: Number(source.graphRevision) })
}

function parseSelectedJobIds(value: unknown): string[] | null {
  const rows = denseValues(value, 3)
  if (!rows || rows.length < 2 || rows.some(id => typeof id !== "string" || id.trim() !== id || !JOB_ID.test(id))
    || new Set(rows).size !== rows.length) return null
  return rows as string[]
}

function parseBinding(value: unknown): VerifiedShortlistSelectionBinding | null {
  const binding = dataRecord(value, BINDING_KEYS)
  if (!binding || binding.schemaVersion !== VERIFIED_SHORTLIST_SELECTION_SCHEMA) return null
  const source = parseSource(binding.source), selectedJobIds = parseSelectedJobIds(binding.selectedJobIds)
  return source && selectedJobIds ? freezeBinding(source, selectedJobIds) : null
}

function freezeBinding(source: VerifiedShortlistSourceIdentity, selectedJobIds: readonly string[]): VerifiedShortlistSelectionBinding {
  return Object.freeze({ schemaVersion: VERIFIED_SHORTLIST_SELECTION_SCHEMA, source,
    selectedJobIds: Object.freeze([...selectedJobIds]) })
}

function sameSource(left: VerifiedShortlistSourceIdentity, right: VerifiedShortlistSourceIdentity): boolean {
  return SOURCE_KEYS.every(key => left[key] === right[key])
}

function safeId(value: unknown): value is string { return typeof value === "string" && value.trim() === value && ID.test(value) }

function dataRecord(value: unknown, exactKeys?: readonly string[]): Record<string, unknown> | null {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null
    const prototype = Object.getPrototypeOf(value), keys = Reflect.ownKeys(value)
    if ((prototype !== Object.prototype && prototype !== null) || keys.some(key => typeof key !== "string")
      || (exactKeys && (keys.length !== exactKeys.length || keys.some(key => !exactKeys.includes(key as string))))) return null
    const descriptors = Object.getOwnPropertyDescriptors(value), result: Record<string, unknown> = Object.create(null) as Record<string, unknown>
    for (const key of keys as string[]) {
      const descriptor = descriptors[key]
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) return null
      result[key] = descriptor.value
    }
    return result
  } catch { return null }
}

function denseValues(value: unknown, maximum: number): unknown[] | null {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum) return null
    const keys = Reflect.ownKeys(value), descriptors = Object.getOwnPropertyDescriptors(value)
    if (keys.length !== value.length + 1 || keys.some(key => key !== "length" && (typeof key !== "string"
      || !/^\d+$/.test(key) || String(Number(key)) !== key || Number(key) >= value.length))) return null
    const rows: unknown[] = []
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = descriptors[String(index)]
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) return null
      rows.push(descriptor.value)
    }
    return rows
  } catch { return null }
}
