import { parseQuestionInputItem, parseQuestionTerminalEvent } from './question-input-parser'
import { normalizeTimelineEvent, normalizeTimelineItem } from './timeline-event-normalizer'
import { appendTimelineEvent, buildIndexes, compareItems, isAfter, isRecord, itemFromTimelineEvent, mergeContent, numberOrUndefined } from './timeline-reducer-utils'
import type { TimelineItem, TimelineItemSource, TimelineState } from './timeline-reducer'

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'interrupted'])

export function reduceTimelineItems(state: TimelineState, values: unknown[], source: TimelineItemSource): TimelineState {
  let next = state
  for (const value of values) {
    const item = normalizeTimelineItem(value, source)
    if (item?.sessionId !== state.sessionId) continue
    if (item.type === 'question' && !parseQuestionInputItem(value, state.sessionId)) continue
    next = upsertTimelineItem(next, questionTerminalItem(next, item), source)
  }
  return next
}

export function reduceTimelineDelta(state: TimelineState, value: unknown, preprocessedId?: string): TimelineState {
  const delta = normalizeTimelineEvent(value)
  if (!delta || delta.sessionId !== state.sessionId || !delta.itemId || (preprocessedId === undefined && state.processedEventIds[delta.id])) return state
  if (preprocessedId === undefined && delta.sequence !== null && !isAfter(delta.sequence, state.lastSequence)) return state
  const processedEventIds: Record<string, true> = preprocessedId === undefined
    ? { ...state.processedEventIds, [delta.id]: true }
    : state.processedEventIds
  state = {
    ...state,
    processedEventIds,
    lastSequence: delta.sequence && isAfter(delta.sequence, state.lastSequence) ? delta.sequence : state.lastSequence,
  }
  if (preprocessedId === undefined) state = { ...state, ...appendTimelineEvent(state.events, delta), lastEventId: delta.id }
  const payload = isRecord(delta.payload) ? delta.payload : {}
  const revision = delta.revision ?? numberOrUndefined(payload.revision)
  if (revision === undefined) return state
  const existing = state.itemsById[delta.itemId]
  if (existing && (TERMINAL_STATUSES.has(existing.status) || revision <= existing.revision)) return state
  if (delta.kind === 'delta' && delta.baseRevision !== undefined && delta.baseRevision > (existing?.revision ?? 0)) {
    return { ...state, snapshotRequired: true, connection: 'reconnecting' }
  }
  const item = itemFromTimelineEvent(delta, 'streaming', existing, revision, normalizeTimelineItem)
  if (!item) return state
  const next = upsertTimelineItem(state, { ...item, revision, source: 'transient' }, 'transient', delta.kind === 'snapshot')
  return delta.kind === 'snapshot' ? { ...next, snapshotRequired: false } : next
}

export function upsertTimelineItem(state: TimelineState, item: TimelineItem, source: TimelineItemSource, replaceContent = false): TimelineState {
  const existing = state.itemsById[item.id]
  if (existing && existing.type === 'question' && TERMINAL_STATUSES.has(existing.status) && !TERMINAL_STATUSES.has(item.status)) return state
  if (existing && source === 'transient' && (TERMINAL_STATUSES.has(existing.status) || item.revision <= existing.revision)) return state
  if (existing && source === 'replay' && isOlderReplay(existing, item)) return state
  if (existing && source === 'durable' && existing.sequence && item.sequence && !isAfter(item.sequence, existing.sequence) && item.status !== 'completed') return state
  const nextItem = source === 'transient' && existing
    ? { ...existing, ...item, content: replaceContent ? item.content : mergeContent(existing.content, item.content), source }
    : { ...existing, ...item, source }
  const itemsById = { ...state.itemsById, [item.id]: nextItem }
  const itemIds = Object.values(itemsById).sort(compareItems).map((entry) => entry.id)
  const transientItems = new Map(state.transientItems)
  if (source === 'transient') transientItems.set(item.id, nextItem)
  else transientItems.delete(item.id)
  return { ...state, itemsById, itemIds, transientItems, ...buildIndexes(itemsById) }
}

export function questionTerminalItem(state: TimelineState, item: TimelineItem): TimelineItem {
  if (item.type !== 'question' || TERMINAL_STATUSES.has(item.status)) return item
  const input = parseQuestionInputItem(item, state.sessionId)
  if (!input) return item
  for (let index = state.events.length - 1; index >= 0; index -= 1) {
    const event = state.events[index]
    if (event.type !== 'question.answered' && event.type !== 'question.cancelled') continue
    if (event.itemId !== item.id || event.turnId !== item.turnId || event.taskId !== item.taskId) continue
    const terminal = parseQuestionTerminalEvent(event, state.sessionId)
    if (!terminal || terminal.questionId !== input.questionId || terminal.turnId !== input.turnId || terminal.taskId !== input.taskId) continue
    if (item.sequence !== null && !isAtLeast(terminal.sequence, item.sequence)) continue
    const content = isRecord(item.content)
      ? { ...item.content, pending: false, answerAvailable: terminal.status === 'completed', ...(terminal.status === 'interrupted' ? { cancelled: true, cancellationReason: 'interrupt' } : {}) }
      : item.content
    return { ...item, status: terminal.status, content, completedAt: terminal.createdAt ?? item.completedAt, sequence: terminal.sequence }
  }
  return item
}

function isAtLeast(left: string, right: string): boolean {
  return left === right || isAfter(left, right)
}

/** Prevent an in-flight snapshot from regressing evidence received from the live stream. */
function isOlderReplay(existing: TimelineItem, incoming: TimelineItem): boolean {
  if (existing.sequence && incoming.sequence) {
    if (isAfter(existing.sequence, incoming.sequence)) return true
    if (existing.sequence === incoming.sequence) {
      if (existing.revision > incoming.revision) return true
      if (TERMINAL_STATUSES.has(existing.status) && !TERMINAL_STATUSES.has(incoming.status)) return true
      return existing.status === incoming.status
    }
    return false
  }
  if (existing.revision > incoming.revision) return true
  return TERMINAL_STATUSES.has(existing.status) && !TERMINAL_STATUSES.has(incoming.status)
}
