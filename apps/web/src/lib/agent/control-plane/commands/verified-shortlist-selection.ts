import {
  VERIFIED_SHORTLIST_SELECTION_SCHEMA,
  TurnIntentSchema,
  parseTaskGraphSnapshot,
  parseVerifiedShortlistJobIds,
  parseVerifiedShortlistSelectionBinding,
  parseVerifiedShortlistSourceIdentity,
  validate,
  type VerifiedShortlistSelectionBinding,
  type VerifiedShortlistSourceIdentity,
} from "@jobcopilot/agent-protocol"

import { projectInteractiveDiscoveryShortlist } from "@/app/api/agent/sessions/[id]/tasks/interactive-discovery-shortlist"
import { canonicalTaskGraphItemId } from "@/lib/agent/session/final-task-graph-source-detail"
import type { CommandTransaction } from "./transaction"

export { VERIFIED_SHORTLIST_SELECTION_SCHEMA, sameVerifiedShortlistSelectionBinding } from "@jobcopilot/agent-protocol"
export type { VerifiedShortlistSelectionBinding, VerifiedShortlistSourceIdentity } from "@jobcopilot/agent-protocol"

type LockedOwnerSession = Readonly<{ id: string; userId: string }>
const OWNER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

/** Rechecks source proof and owned Jobs inside the caller's locked Session transaction. */
export async function verifyVerifiedShortlistSelection(
  tx: CommandTransaction,
  owner: LockedOwnerSession,
  sourceValue: unknown,
  selectionValue: unknown,
): Promise<VerifiedShortlistSelectionBinding | null> {
  if (!safeOwnerId(owner.id) || !safeOwnerId(owner.userId)) return null
  const source = parseSource(sourceValue)
  const selected = parseVerifiedShortlistJobIds(selectionValue)
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

  return parseVerifiedShortlistSelectionBinding({ schemaVersion: VERIFIED_SHORTLIST_SELECTION_SCHEMA, source, selectedJobIds })
}

function hasDiscoveryIntent(value: unknown): boolean {
  const input = dataRecord(value)
  const intent = dataRecord(input?.intent, ["kind", "version"])
  return Boolean(intent && validate(TurnIntentSchema, intent)
    && intent.kind === "interactive_discovery_shortlist" && intent.version === 1)
}

function parseSource(value: unknown): VerifiedShortlistSourceIdentity | null {
  const source = parseVerifiedShortlistSourceIdentity(value)
  if (!source || source.graphItemId !== canonicalTaskGraphItemId(source.rootTaskId)) return null
  return source
}

function safeOwnerId(value: unknown): value is string {
  return typeof value === "string" && value.trim() === value && OWNER_ID.test(value)
}

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
