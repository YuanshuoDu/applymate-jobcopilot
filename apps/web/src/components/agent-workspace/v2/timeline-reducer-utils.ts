import type { TimelineEvent, TimelineItem, TimelineItemSource } from './timeline-reducer'

/** Index helpers for the canonical Phase 9 timeline state root. */

export interface FinalTurnCompletedDiagnostic {
  eventNameMatches: boolean; rawTypeMatches: boolean; rawSessionMatches: boolean; rawTurnMatches: boolean
  rawActorMatches: boolean; rawPayloadRecord: boolean; rawPayloadTurnMatches: boolean; rawFinalItemMatchesEventItem: boolean
  normalized: boolean; normalizedSessionMatches: boolean; normalizedTurnMatches: boolean
}

export interface FinalItemTargetDiagnostic {
  targetSessionMatches: boolean; targetTurnMatches: boolean; actorMatches: boolean; sequencePresent: boolean
  itemPresent: boolean; payloadRecord: boolean; payloadTurnMatches: boolean; payloadTaskMatches: boolean
  finalItemMatchesEventItem: boolean; targetAccepted: boolean
}

export interface FinalItemHydrationDiagnostic {
  requestStarted: boolean; responseReceived: boolean; responseCategory: 'ok' | 'non_ok' | 'unavailable'
  jsonParsed: boolean; itemCountCategory: 'zero' | 'one' | 'many' | 'unavailable'
  itemAccepted: boolean; projectionAccepted: boolean; replayDispatched: boolean
}

interface FinalAnswerDiagnosticsObserver {
  matchesTarget(sessionId: unknown, turnId: unknown): boolean
  recordTurnCompleted(summary: FinalTurnCompletedDiagnostic): void
  recordFinalItemTarget(summary: FinalItemTargetDiagnostic): void
  recordFinalItemHydration(summary: FinalItemHydrationDiagnostic): void
}

/** Returns only the E2E-installed observer; every diagnostic callback is fail-silent. */
export function getFinalAnswerDiagnostics(): FinalAnswerDiagnosticsObserver | null {
  if (typeof window === 'undefined') return null
  const observer = (window as Window & { __applymateFinalDiagnostics?: unknown }).__applymateFinalDiagnostics
  if (!isRecord(observer) || typeof observer.matchesTarget !== 'function' || typeof observer.recordTurnCompleted !== 'function' ||
    typeof observer.recordFinalItemTarget !== 'function' || typeof observer.recordFinalItemHydration !== 'function') return null
  const typed = observer as unknown as FinalAnswerDiagnosticsObserver
  return {
    matchesTarget: (sessionId, turnId) => safely(() => typed.matchesTarget(sessionId, turnId) === true, false),
    recordTurnCompleted: summary => safely(() => typed.recordTurnCompleted(summary), undefined),
    recordFinalItemTarget: summary => safely(() => typed.recordFinalItemTarget(summary), undefined),
    recordFinalItemHydration: summary => safely(() => typed.recordFinalItemHydration(summary), undefined),
  }
}

export function observeFinalTurnCompleted(frameName: string, value: unknown, event: TimelineEvent | null, sessionId: string): void {
  const diagnostics = getFinalAnswerDiagnostics()
  if (!diagnostics) return
  const raw = isRecord(value) ? value : null
  if (frameName !== 'turn.completed' && raw?.type !== 'turn.completed') return
  const payload = raw && isRecord(raw.payload) ? raw.payload : null
  diagnostics.recordTurnCompleted({
    eventNameMatches: frameName === 'turn.completed', rawTypeMatches: raw?.type === 'turn.completed',
    rawSessionMatches: raw?.sessionId === sessionId, rawTurnMatches: Boolean(raw && diagnostics.matchesTarget(raw.sessionId, raw.turnId)),
    rawActorMatches: raw?.actor === 'orchestrator', rawPayloadRecord: payload !== null,
    rawPayloadTurnMatches: Boolean(raw && payload && payload.turnId === raw.turnId),
    rawFinalItemMatchesEventItem: Boolean(raw && payload && payload.finalItemId === raw.itemId),
    normalized: event?.type === 'turn.completed', normalizedSessionMatches: event?.sessionId === sessionId,
    normalizedTurnMatches: Boolean(event && diagnostics.matchesTarget(event.sessionId, event.turnId)),
  })
}

function safely<T>(run: () => T, fallback: T): T { try { return run() } catch { return fallback } }

export function buildEventIndexes(input: TimelineEvent[]) {
  const events = [...new Map(input.map(event => [event.id, event])).values()].sort(compareEvents)
  const byId = new Map<string, TimelineEvent>()
  const byTurnId = new Map<string, TimelineEvent[]>()
  const byToolCallId = new Map<string, TimelineEvent[]>()
  for (const event of events) {
    byId.set(event.id, event)
    byTurnId.set(event.turnId, [...(byTurnId.get(event.turnId) ?? []), event])
    const toolCallId = eventToolCallId(event)
    if (toolCallId) byToolCallId.set(toolCallId, [...(byToolCallId.get(toolCallId) ?? []), event])
  }
  return { events, byId, byTurnId, byToolCallId }
}

export function appendFallbackEvent(items: TimelineEvent[], event: TimelineEvent): TimelineEvent[] {
  return items.some(item => item.id === event.id) ? items : [...items, event]
}

export function appendTimelineEvent(events: TimelineEvent[], event: TimelineEvent) {
  return buildEventIndexes([...events, event])
}

function compareEvents(a: TimelineEvent, b: TimelineEvent): number {
  if (a.sequence !== null && b.sequence !== null) {
    const bySequence = BigInt(a.sequence) < BigInt(b.sequence) ? -1 : BigInt(a.sequence) > BigInt(b.sequence) ? 1 : 0
    if (bySequence !== 0) return bySequence
  } else if (a.sequence !== null) return -1
  else if (b.sequence !== null) return 1
  return (a.createdAt ?? '').localeCompare(b.createdAt ?? '') || a.id.localeCompare(b.id)
}

function eventToolCallId(event: TimelineEvent): string | null {
  const payload = isRecord(event.payload) ? event.payload : null
  const item = payload && isRecord(payload.item) ? payload.item : null
  const content = item && isRecord(item.content) ? item.content : null
  for (const candidate of [payload, item, content]) {
    if (candidate && typeof candidate.toolCallId === 'string' && candidate.toolCallId) return candidate.toolCallId
  }
  return null
}

export function itemFromTimelineEvent(
  event: TimelineEvent,
  status: string,
  existing: TimelineItem | undefined,
  revision: number | undefined,
  normalize: (value: unknown, source?: TimelineItemSource) => TimelineItem | null,
): TimelineItem | null {
  const payload = isRecord(event.payload) ? event.payload : {}
  const source = event.kind ? 'transient' : 'durable'
  const candidate = normalize(payload.item, source) ?? (payload.id === event.itemId ? normalize(payload, source) : null)
  if (candidate) return { ...candidate, status, revision: revision ?? candidate.revision, sequence: event.sequence ?? candidate.sequence }
  if (!existing && event.itemId) return {
    schemaVersion: event.schemaVersion, id: event.itemId, sessionId: event.sessionId, turnId: event.turnId,
    stepId: null, taskId: event.taskId, type: 'unknown', status, phase: null, revision: revision ?? 0,
    content: { eventType: event.type, payload: event.payload, opaque: true }, startedAt: event.createdAt ?? null,
    completedAt: status === 'completed' ? event.createdAt ?? null : null,
    createdAt: event.createdAt ?? new Date(0).toISOString(), updatedAt: event.createdAt ?? new Date(0).toISOString(),
    source: event.kind ? 'transient' : 'unknown', sequence: event.sequence,
  }
  if (!existing) return null
  const content = event.type === 'item.completed' || event.type === 'item.failed' || event.kind === 'snapshot'
    ? payload.content ?? payload
    : mergeContent(existing.content, payload.content ?? payload)
  return { ...existing, taskId: event.taskId ?? existing.taskId, status, revision: revision ?? existing.revision,
    content, completedAt: status === 'completed' ? event.createdAt ?? existing.completedAt : existing.completedAt,
    updatedAt: event.createdAt ?? existing.updatedAt, sequence: event.sequence ?? existing.sequence }
}

export function buildIndexes(itemsById: Record<string, TimelineItem>) {
  const itemIdsByTurnId: Record<string, string[]> = {}
  const itemIdsByTaskId: Record<string, string[]> = {}
  for (const item of Object.values(itemsById)) {
    ;(itemIdsByTurnId[item.turnId] ??= []).push(item.id)
    if (item.taskId) (itemIdsByTaskId[item.taskId] ??= []).push(item.id)
  }
  for (const ids of Object.values(itemIdsByTurnId)) ids.sort()
  for (const ids of Object.values(itemIdsByTaskId)) ids.sort()
  return { itemIdsByTurnId, itemIdsByTaskId }
}

export function compareItems(a: TimelineItem, b: TimelineItem): number {
  return a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)
}

export function mergeContent(current: unknown, incoming: unknown): unknown {
  if (!isRecord(current) || !isRecord(incoming)) return incoming
  return { ...current, ...incoming }
}

export function integer(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0
}

export function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined
}

export function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

export function timestamp(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

export function sequence(value: unknown): string | null {
  return typeof value === 'string' && /^\d{1,39}$/.test(value) ? value : null
}

export function isAfter(left: string, right: string | null): boolean {
  return right === null || BigInt(left) > BigInt(right)
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
