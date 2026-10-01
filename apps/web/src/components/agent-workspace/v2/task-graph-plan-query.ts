import type { TimelineItem } from './timeline-reducer'
import { parseTaskGraphSnapshot, TASK_GRAPH_MAX_IDENTIFIER_LENGTH } from './task-graph-plan-snapshot'
import { SELECTED_JOB_PREPARATION_MESSAGE_TEXT } from './selected-job-preparation-action'

const MAX_REFERENCED_TASK_IDS = 9

export interface TaskGraphIdentity {
  readonly sessionId: string
  readonly graphItemId: string
  readonly turnId: string
  readonly rootTaskId: string
  readonly revision: number
}

export interface SelectedJobPreparationIntent {
  readonly turnId: string
  readonly sequence: string | null
}

/** Reads the latest durable selected-job intent so old graphs stay hidden after reconnect. */
export function latestSelectedJobPreparationIntent(items: readonly TimelineItem[], sessionId: string): SelectedJobPreparationIntent | null {
  if (!sessionId.trim()) return null
  let latest: TimelineItem | null = null
  let latestTimestamp = Number.NEGATIVE_INFINITY
  for (const item of items) {
    if (item.type !== 'user_message' || item.sessionId !== sessionId || !hasSelectedPreparationText(item.content)
      || !boundedIdentifier(item.turnId)) continue
    if (latest && isSequence(item.sequence) && isSequence(latest.sequence)) {
      if (BigInt(item.sequence) < BigInt(latest.sequence)) continue
      latest = item
      continue
    }
    if (latest && isSequence(latest.sequence) && !isSequence(item.sequence)) continue
    if (latest && isSequence(item.sequence) && !isSequence(latest.sequence)) {
      latest = item
      continue
    }
    const createdAt = timestamp(item.createdAt)
    const itemTimestamp = Number.isFinite(createdAt) ? createdAt : timestamp(item.updatedAt)
    if (!latest || itemTimestamp >= latestTimestamp) {
      latest = item
      latestTimestamp = itemTimestamp
    }
  }
  return latest ? { turnId: latest.turnId, sequence: isSequence(latest.sequence) ? latest.sequence : null } : null
}

export function latestSelectedJobPreparationTurnId(items: readonly TimelineItem[], sessionId: string): string | null {
  return latestSelectedJobPreparationIntent(items, sessionId)?.turnId ?? null
}

/** Resolves a selected saved-job ID only from the matching session and preparation Turn. */
export function selectedJobIdForTurn(
  turns: readonly { readonly id: string; readonly sessionId: string; readonly selectedJobId?: string }[],
  sessionId: string,
  turnId: string | null,
): string | null {
  if (!sessionId.trim() || !boundedIdentifier(turnId)) return null
  const turn = turns.find(candidate => candidate.sessionId === sessionId && candidate.id === turnId && boundedIdentifier(candidate.selectedJobId))
  return turn?.selectedJobId ?? null
}

/** Keeps an accepted request visible before its durable timeline item arrives; later replay wins by sequence. */
export function selectedJobPreparationTurnId(
  items: readonly TimelineItem[],
  sessionId: string,
  accepted?: SelectedJobPreparationIntent | null,
): string | null {
  const persisted = latestSelectedJobPreparationIntent(items, sessionId)
  if (!accepted || !boundedIdentifier(accepted.turnId)) return persisted?.turnId ?? null
  if (persisted?.turnId === accepted.turnId) return persisted.turnId
  if (isAtOrAfterSequence(persisted?.sequence, accepted.sequence)) return persisted?.turnId ?? null
  return accepted.turnId
}

function isAtOrAfterSequence(left: string | null | undefined, right: string | null | undefined): boolean {
  return isSequence(left) && isSequence(right) && BigInt(left) >= BigInt(right)
}

function isSequence(value: unknown): value is string {
  return typeof value === 'string' && /^\d{1,39}$/.test(value)
}

export function latestTaskGraphItem(items: readonly TimelineItem[], sessionId: string, requiredTurnId?: string | null): TimelineItem | null {
  const targetTurnId = requiredTurnId === undefined ? latestSelectedJobPreparationTurnId(items, sessionId) : requiredTurnId
  let latest: TimelineItem | null = null
  let latestTimestamp = Number.NEGATIVE_INFINITY
  for (const item of items) {
    if (item.type !== 'task_graph' || item.sessionId !== sessionId || (targetTurnId && item.turnId !== targetTurnId)) continue
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

export function selectedTaskGraphIdentity(items: readonly TimelineItem[], sessionId: string, requiredTurnId?: string | null): TaskGraphIdentity | null {
  if (!sessionId.trim()) return null
  const item = latestTaskGraphItem(items, sessionId, requiredTurnId)
  const snapshot = item ? parseTaskGraphSnapshot(item.content) : null
  if (!item || !snapshot || snapshot.nodes.length === 0 || !Number.isSafeInteger(item.revision) || item.revision < 1
    || !boundedIdentifier(item.id) || !boundedIdentifier(item.turnId) || !boundedIdentifier(item.taskId)) return null
  return { sessionId, graphItemId: item.id, turnId: item.turnId, rootTaskId: item.taskId, revision: item.revision }
}

export function selectCurrentTaskGraphTaskIds(items: readonly TimelineItem[], sessionId: string, requiredTurnId?: string | null): string[] {
  const identity = selectedTaskGraphIdentity(items, sessionId, requiredTurnId)
  if (!identity) return []
  const item = latestTaskGraphItem(items, sessionId, requiredTurnId)
  const snapshot = item ? parseTaskGraphSnapshot(item.content) : null
  if (!snapshot) return []

  const ids = new Set<string>()
  ids.add(identity.rootTaskId)
  for (const node of snapshot.nodes) ids.add(node.taskId)
  return ids.size <= MAX_REFERENCED_TASK_IDS ? [...ids] : []
}

export function buildTaskGraphTaskLookupUrl(sessionId: string | null, items: readonly TimelineItem[], requiredTurnId?: string | null): string | null {
  if (!sessionId) return null
  const identity = selectedTaskGraphIdentity(items, sessionId, requiredTurnId)
  if (!identity) return null
  const ids = selectCurrentTaskGraphTaskIds(items, sessionId, requiredTurnId)
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

function hasSelectedPreparationText(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const parts = (value as Record<string, unknown>).parts
  if (!Array.isArray(parts) || parts.length !== 1) return false
  const part = parts[0]
  return Boolean(part && typeof part === 'object' && !Array.isArray(part)
    && (part as Record<string, unknown>).type === 'text'
    && (part as Record<string, unknown>).text === SELECTED_JOB_PREPARATION_MESSAGE_TEXT)
}

function timestamp(value: unknown): number {
  if (typeof value !== 'string' || value.length > 128) return Number.NEGATIVE_INFINITY
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY
}
