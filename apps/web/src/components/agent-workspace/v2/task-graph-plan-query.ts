import type { TimelineItem } from './timeline-reducer'
import { parseTaskGraphSnapshot, TASK_GRAPH_MAX_IDENTIFIER_LENGTH } from './task-graph-plan-snapshot'

const MAX_REFERENCED_TASK_IDS = 9

export interface TaskGraphIdentity {
  readonly sessionId: string
  readonly graphItemId: string
  readonly turnId: string
  readonly rootTaskId: string
  readonly revision: number
}

export function latestTaskGraphItem(items: readonly TimelineItem[], sessionId: string): TimelineItem | null {
  let latest: TimelineItem | null = null
  let latestTimestamp = Number.NEGATIVE_INFINITY
  for (const item of items) {
    if (item.type !== 'task_graph' || item.sessionId !== sessionId) continue
    const updatedAt = timestamp(item.updatedAt)
    const itemTimestamp = Number.isFinite(updatedAt) ? updatedAt : timestamp(item.createdAt)
    // Timeline items are ordered; later entries win equal or unavailable times.
    if (!latest || itemTimestamp >= latestTimestamp) {
      latest = item
      latestTimestamp = itemTimestamp
    }
  }
  return latest
}

export function selectedTaskGraphIdentity(items: readonly TimelineItem[], sessionId: string): TaskGraphIdentity | null {
  if (!sessionId.trim()) return null
  const item = latestTaskGraphItem(items, sessionId)
  const snapshot = item ? parseTaskGraphSnapshot(item.content) : null
  if (!item || !snapshot || snapshot.nodes.length === 0 || !Number.isSafeInteger(item.revision) || item.revision < 1
    || !boundedIdentifier(item.id) || !boundedIdentifier(item.turnId) || !boundedIdentifier(item.taskId)) return null
  return { sessionId, graphItemId: item.id, turnId: item.turnId, rootTaskId: item.taskId, revision: item.revision }
}

export function selectCurrentTaskGraphTaskIds(items: readonly TimelineItem[], sessionId: string): string[] {
  const identity = selectedTaskGraphIdentity(items, sessionId)
  if (!identity) return []
  const item = latestTaskGraphItem(items, sessionId)
  const snapshot = item ? parseTaskGraphSnapshot(item.content) : null
  if (!snapshot) return []

  const ids = new Set<string>()
  ids.add(identity.rootTaskId)
  for (const node of snapshot.nodes) ids.add(node.taskId)
  return ids.size <= MAX_REFERENCED_TASK_IDS ? [...ids] : []
}

export function buildTaskGraphTaskLookupUrl(sessionId: string | null, items: readonly TimelineItem[]): string | null {
  if (!sessionId) return null
  const identity = selectedTaskGraphIdentity(items, sessionId)
  if (!identity) return null
  const ids = selectCurrentTaskGraphTaskIds(items, sessionId)
  if (ids.length === 0) return null
  const query = new URLSearchParams()
  for (const taskId of ids) query.append('taskId', taskId)
  query.set('graphItemId', identity.graphItemId)
  query.set('graphTurnId', identity.turnId)
  query.set('rootTaskId', identity.rootTaskId)
  query.set('graphRevision', String(identity.revision))
  return `/api/agent/sessions/${encodeURIComponent(sessionId)}/tasks?${query.toString()}`
}

function boundedIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= TASK_GRAPH_MAX_IDENTIFIER_LENGTH && value.trim() === value
}

function timestamp(value: unknown): number {
  if (typeof value !== 'string' || value.length > 128) return Number.NEGATIVE_INFINITY
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY
}
