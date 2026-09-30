import type { InputContentPart } from '@jobcopilot/agent-protocol'

import { retryInputInvalid } from './errors'

const RETRYABLE_STATUSES = new Set(['failed', 'interrupted', 'cancelled'])
const MAX_RETRY_PARTS = 32
const MAX_RETRY_ATTACHMENT_REFS = 8
const MAX_RETRY_TEXT_BYTES = 20_000
const MAX_RETRY_CONTENT_BYTES = 256 * 1024

export function isRetryableTurnStatus(status: string): boolean {
  return RETRYABLE_STATUSES.has(status)
}

export function parsePersistedRetryContent(turnId: string, value: unknown): { goal: string; content: InputContentPart[] } {
  if (!isRecord(value) || !exactKeys(value, ['goal', 'content', 'clientMessageId']) ||
    !boundedGoal(value.goal) || (value.clientMessageId !== undefined && !boundedString(value.clientMessageId, 256)) ||
    !Array.isArray(value.content) || value.content.length < 1 || value.content.length > MAX_RETRY_PARTS) throw retryInputInvalid(turnId)
  const content: InputContentPart[] = []
  let attachmentCount = 0
  for (const part of value.content) {
    if (!isRecord(part) || typeof part.type !== 'string') throw retryInputInvalid(turnId)
    if (part.type === 'text') {
      if (Object.keys(part).length !== 2 || !boundedString(part.text, MAX_RETRY_TEXT_BYTES)) throw retryInputInvalid(turnId)
      content.push({ type: 'text', text: part.text })
    } else if (part.type === 'attachment_ref') {
      if (!exactKeys(part, ['type', 'attachmentId', 'mediaType', 'filename']) || !boundedString(part.attachmentId, 256) || !boundedString(part.mediaType, 256) || (part.filename !== undefined && !boundedString(part.filename, 256))) throw retryInputInvalid(turnId)
      attachmentCount += 1
      if (attachmentCount > MAX_RETRY_ATTACHMENT_REFS) throw retryInputInvalid(turnId)
      content.push({ type: 'attachment_ref', attachmentId: part.attachmentId, mediaType: part.mediaType, ...(part.filename === undefined ? {} : { filename: part.filename }) })
    } else throw retryInputInvalid(turnId)
  }
  if (new TextEncoder().encode(JSON.stringify(content)).byteLength > MAX_RETRY_CONTENT_BYTES) throw retryInputInvalid(turnId)
  return { goal: value.goal, content }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every(key => keys.includes(key))
}

function boundedString(value: unknown, maxBytes: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value && new TextEncoder().encode(value).byteLength <= maxBytes && !/[\u0000-\u001f\u007f]/.test(value)
}

function boundedGoal(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value && new TextEncoder().encode(value).byteLength <= MAX_RETRY_CONTENT_BYTES && !/[\u0000-\u0008\u000b-\u001f\u007f]/.test(value)
}
