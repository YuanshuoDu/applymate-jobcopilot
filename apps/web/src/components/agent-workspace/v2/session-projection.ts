import type { AgentTranscriptEvent } from '../session-view-model'
import type { TimelineItem } from './timeline-reducer'

export interface ReadOnlySessionProjection {
  sessionId: string
  writable: false
  items: TimelineItem[]
}

/** Projects canonical timeline items for the existing transcript renderer. */
export function createReadOnlySessionProjection(sessionId: string, items: TimelineItem[]): ReadOnlySessionProjection {
  return { sessionId, writable: false, items: [...items] }
}

/**
 * Adapts the canonical V2 projection to the legacy renderer's view shape.
 * Canonical items stay immutable at this boundary. Legacy-shaped payloads are
 * only exposed to the read-only renderer so established approval cards keep
 * their presentation without creating a second session state.
 */
export function projectTimelineItems(projection: ReadOnlySessionProjection): AgentTranscriptEvent[] {
  return projection.items.map(item => {
    const content = record(item.content)
    const legacyType = legacyTypeFor(item)
    return {
      id: item.id,
      taskId: item.taskId,
      type: legacyType ?? item.type,
      speaker: speakerFor(item, content),
      title: titleFor(item, content),
      body: bodyFor(item, content),
      data: legacyType ? legacyPayload(content) : item,
      durationMs: null,
      createdAt: item.createdAt,
    }
  })
}

function speakerFor(item: TimelineItem, content: Record<string, unknown>): string {
  if (typeof content.speaker === 'string' && content.speaker.trim()) return content.speaker
  if (item.type === 'user_message') return 'You'
  if (item.type === 'tool_call' || item.type === 'tool_result') return 'Tool'
  return 'ApplyMate'
}

function titleFor(item: TimelineItem, content = record(item.content)): string | null {
  return typeof content.title === 'string' ? content.title : null
}

function bodyFor(item: TimelineItem, content = record(item.content)): string {
  if (typeof content.text === 'string') return content.text
  if (typeof content.body === 'string') return content.body
  return ''
}

function legacyTypeFor(item: TimelineItem): string | null {
  const content = record(item.content)
  if (typeof content.legacyType === 'string' && content.legacyType.trim()) return content.legacyType
  return ['approval_request', 'approval_response', 'automation_draft', 'automation_created', 'automation_updated', 'automation_cancelled', 'quality_gate', 'job_results', 'resume_tailored', 'resume_finalized'].includes(item.type)
    ? item.type
    : null
}

function legacyPayload(content: Record<string, unknown>): unknown {
  return content.data && typeof content.data === 'object' && !Array.isArray(content.data)
    ? content.data
    : content
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}
