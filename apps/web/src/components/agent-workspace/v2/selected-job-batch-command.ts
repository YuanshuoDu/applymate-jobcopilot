import {
  VERIFIED_SHORTLIST_SELECTION_SCHEMA, parseVerifiedShortlistSelectionBinding,
} from '@jobcopilot/agent-protocol'
import type { VerifiedShortlistPreparationRequest } from './VerifiedShortlistPreparation'

export type SelectedJobBatchCommandResult = Readonly<{ turnId: string; disposition: 'started' | 'duplicate' }>

type PendingRequest = Readonly<{ intentKey: string; clientMessageId: string }>
const STORAGE_PREFIX = 'applymate:selected-job-batch:v1:'
const MAX_PENDING_PER_SOURCE = 4
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const SAFE_MESSAGE_ID = /^[!-~]{1,128}$/
const memoryPending = new Map<string, readonly PendingRequest[]>()
let messageSequence = 0

/** Starts one explicit shortlist request. Failed ambiguous attempts reuse their id only for the exact intent. */
export async function startSelectedJobBatch(
  sessionId: string,
  request: VerifiedShortlistPreparationRequest,
): Promise<SelectedJobBatchCommandResult> {
  const binding = parseVerifiedShortlistSelectionBinding({
    schemaVersion: VERIFIED_SHORTLIST_SELECTION_SCHEMA, source: request?.source, selectedJobIds: request?.selectedJobIds,
  })
  if (!binding || binding.source.sessionId !== sessionId) throw new Error('Selected Job batch request is invalid')
  const sourceKey = JSON.stringify(binding.source)
  const intentKey = JSON.stringify({ source: binding.source, selectedJobIds: binding.selectedJobIds })
  const clientMessageId = reserveMessageId(sessionId, sourceKey, intentKey)
  let response: Response
  try {
    response = await fetch(`/api/agent/sessions/${encodeURIComponent(sessionId)}/prepare-selected-jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': clientMessageId },
      body: JSON.stringify({ schemaVersion: VERIFIED_SHORTLIST_SELECTION_SCHEMA, clientMessageId,
        source: binding.source, selectedJobIds: binding.selectedJobIds }),
    })
  } catch {
    throw new Error('Selected Job batch request could not be confirmed')
  }
  if (response.status !== 202) {
    throw new Error(`Selected Job batch request failed with status ${response.status}`)
  }
  const result = parseReceipt(await response.json().catch(() => null))
  if (!result) throw new Error('Selected Job batch returned an invalid response')
  clearMessageId(sessionId, sourceKey, intentKey, clientMessageId)
  return result
}

function reserveMessageId(sessionId: string, sourceKey: string, intentKey: string): string {
  const key = storageKey(sessionId, sourceKey), current = readPending(key)
  const existing = current.find(row => row.intentKey === intentKey)
  if (existing) return existing.clientMessageId
  if (current.length >= MAX_PENDING_PER_SOURCE) throw new Error('Selected Job batch has too many unresolved requests')
  const entry = { intentKey, clientMessageId: createMessageId() }
  writePending(key, [...current, entry])
  return entry.clientMessageId
}

function clearMessageId(sessionId: string, sourceKey: string, intentKey: string, clientMessageId: string): void {
  const key = storageKey(sessionId, sourceKey)
  writePending(key, readPending(key).filter(row => row.intentKey !== intentKey || row.clientMessageId !== clientMessageId))
}

function readPending(key: string): readonly PendingRequest[] {
  const cached = memoryPending.get(key)
  if (cached) return cached
  let raw: string | null
  try { raw = browserStorage()?.getItem(key) ?? null } catch { return [] }
  if (raw === null) return []
  let value: unknown
  try { value = JSON.parse(raw) as unknown } catch { throw new Error('Selected Job batch pending state is invalid') }
  const parsed = parsePending(value)
  if (!parsed) throw new Error('Selected Job batch pending state is invalid')
  memoryPending.set(key, parsed)
  return parsed
}

function writePending(key: string, pending: readonly PendingRequest[]): void {
  if (pending.length) memoryPending.set(key, pending)
  else memoryPending.delete(key)
  const storage = browserStorage()
  if (!storage) return
  try {
    if (pending.length) storage.setItem(key, JSON.stringify({ version: 1, pending }))
    else storage.removeItem(key)
  } catch { /* Keep the bounded in-memory fallback for this page lifetime. */ }
}

function browserStorage(): Storage | null {
  try { return typeof globalThis.sessionStorage === 'undefined' ? null : globalThis.sessionStorage }
  catch { return null }
}

function parsePending(value: unknown): readonly PendingRequest[] | null {
  const envelope = record(value)
  if (!envelope || Object.keys(envelope).sort().join(',') !== 'pending,version' || envelope.version !== 1
    || !Array.isArray(envelope.pending) || envelope.pending.length > MAX_PENDING_PER_SOURCE) return null
  const pending: PendingRequest[] = []
  const intents = new Set<string>(), messageIds = new Set<string>()
  for (const value of envelope.pending) {
    const row = record(value)
    if (!row || Object.keys(row).sort().join(',') !== 'clientMessageId,intentKey'
      || typeof row.intentKey !== 'string' || row.intentKey.length < 1 || row.intentKey.length > 2048
      || typeof row.clientMessageId !== 'string' || !SAFE_MESSAGE_ID.test(row.clientMessageId)
      || intents.has(row.intentKey) || messageIds.has(row.clientMessageId)) return null
    intents.add(row.intentKey); messageIds.add(row.clientMessageId)
    pending.push({ intentKey: row.intentKey, clientMessageId: row.clientMessageId })
  }
  return pending
}

function parseReceipt(value: unknown): SelectedJobBatchCommandResult | null {
  const row = record(value)
  if (!row || typeof row.inputId !== 'string' || !SAFE_ID.test(row.inputId)
    || typeof row.turnId !== 'string' || !SAFE_ID.test(row.turnId)
    || typeof row.sequence !== 'string' || !/^[1-9]\d{0,39}$/.test(row.sequence)) return null
  if (row.disposition === 'started' && Object.keys(row).sort().join(',') === 'disposition,inputId,sequence,turnId') {
    return { turnId: row.turnId, disposition: 'started' }
  }
  if (row.disposition === 'duplicate' && row.originalDisposition === 'started'
    && Object.keys(row).sort().join(',') === 'disposition,inputId,originalDisposition,sequence,turnId') {
    return { turnId: row.turnId, disposition: 'duplicate' }
  }
  return null
}

function createMessageId(): string {
  messageSequence += 1
  const random = typeof globalThis.crypto?.randomUUID === 'function' ? globalThis.crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}-${messageSequence}`
  return `selected-job-batch-${random}`
}

function storageKey(sessionId: string, sourceKey: string): string {
  return `${STORAGE_PREFIX}${encodeURIComponent(sessionId)}:${encodeURIComponent(sourceKey)}`
}
function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  try {
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null ? value as Record<string, unknown> : null
  } catch { return null }
}
