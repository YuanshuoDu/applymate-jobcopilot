import { AGENT_STREAM_SCHEMA_VERSION } from '@jobcopilot/agent-protocol'

export const APPROVAL_LEDGER_EVENT_TYPES = ['approval.requested', 'approval.resolved', 'approval.consumed', 'approval.expired'] as const
export type ApprovalLedgerEventType = typeof APPROVAL_LEDGER_EVENT_TYPES[number]
export type ApprovalLedgerStatus = 'pending' | 'resolved' | 'approved' | 'rejected' | 'cancelled' | 'consumed' | 'expired'
export const APPROVAL_LEDGER_MAX_EVENTS = 64
export const APPROVAL_LEDGER_MAX_EVENT_BYTES = 16 * 1024
export const APPROVAL_LEDGER_MAX_PAYLOAD_BYTES = 8 * 1024

const SAFE_SEQUENCE = /^(0|[1-9]\d*)$/
const SAFE_ID = /^[^\u0000-\u001f\u007f]{1,256}$/
const SAFE_ACTION = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/
const SAFE_HASH = /^(?:[a-f0-9]{64}|sha256:[a-f0-9]{64})$/
const ACTORS: Record<ApprovalLedgerEventType, string> = {
  'approval.requested': 'orchestrator', 'approval.resolved': 'user', 'approval.consumed': 'system', 'approval.expired': 'system',
}

export function isApprovalLedgerEventType(value: unknown): value is ApprovalLedgerEventType {
  return typeof value === 'string' && (APPROVAL_LEDGER_EVENT_TYPES as readonly string[]).includes(value)
}

type Row = Record<string, unknown>
export interface ApprovalLedgerEnvelope {
  readonly schemaVersion: string
  readonly id: string
  readonly sessionId: string
  readonly turnId: string
  readonly itemId: string | null
  readonly taskId: string | null
  readonly type: ApprovalLedgerEventType
  readonly actor: string
  readonly sequence: string
  readonly payload: unknown
  readonly correlationId?: string
  readonly causationId?: string | null
  readonly idempotencyKey?: string | null
  readonly createdAt?: string
}

export interface ApprovalLedgerEventRow {
  readonly id: unknown
  readonly sessionId: unknown
  readonly turnId: unknown
  readonly itemId: unknown
  readonly taskId: unknown
  readonly sequence: unknown
  readonly type: unknown
  readonly actor: unknown
  readonly payload: unknown
}

export type ParsedApprovalLedgerEvent = ApprovalLedgerEnvelope & {
  readonly receipt:
    | { readonly kind: 'audit'; readonly approvalId: string; readonly action?: string; readonly revision?: number }
    | { readonly kind: 'broker'; readonly approvalId: string; readonly itemId: string; readonly toolCallId: string | null; readonly status: 'approved' | 'rejected' | 'cancelled'; readonly nextTurnRevision?: number; readonly answerAvailable?: boolean }
}

function plain(value: unknown): value is Row {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
}

function exact(row: Row, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional])
  return required.every(key => Object.prototype.hasOwnProperty.call(row, key)) && Object.keys(row).every(key => allowed.has(key))
}

function safeId(value: unknown, maxBytes = 256): value is string {
  return typeof value === 'string' && value.trim() === value && SAFE_ID.test(value) && new TextEncoder().encode(value).byteLength <= maxBytes
}
function safeAction(value: unknown): value is string { return typeof value === 'string' && value.trim() === value && SAFE_ACTION.test(value) }
function safeRevision(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 2_147_483_647 }
function encodedBytes(value: unknown): number | null {
  try { const json = JSON.stringify(value); return json === undefined ? null : new TextEncoder().encode(json).byteLength } catch { return null }
}

function auditPayload(value: unknown): ParsedApprovalLedgerEvent['receipt'] | null {
  if (!plain(value) || !exact(value, ['approvalId'], ['action', 'scopeHash', 'revision']) || !safeId(value.approvalId)) return null
  if (value.action !== undefined && !safeAction(value.action)) return null
  if (value.scopeHash !== undefined && value.scopeHash !== 'legacy' && (typeof value.scopeHash !== 'string' || !SAFE_HASH.test(value.scopeHash))) return null
  if (value.revision !== undefined && !safeRevision(value.revision)) return null
  return { kind: 'audit', approvalId: value.approvalId, ...(value.action === undefined ? {} : { action: value.action }), ...(value.revision === undefined ? {} : { revision: value.revision }) }
}

function brokerPayload(value: unknown, envelope: Row): ParsedApprovalLedgerEvent['receipt'] | null {
  if (!plain(value) || value.waitKind !== 'approval' || !safeId(value.waitId) || !safeId(value.itemId) || !safeId(value.turnId) || value.itemId !== envelope.itemId || value.turnId !== envelope.turnId ||
    (value.toolCallId !== null && !safeId(value.toolCallId))) return null
  if (value.outcome === 'cancelled') {
    if (!exact(value, ['waitKind', 'waitId', 'itemId', 'turnId', 'toolCallId', 'outcome', 'reason']) || value.reason !== 'interrupt') return null
    return { kind: 'broker', approvalId: value.waitId, itemId: value.itemId, toolCallId: value.toolCallId as string | null, status: 'cancelled' }
  }
  if (!exact(value, ['waitKind', 'waitId', 'itemId', 'turnId', 'toolCallId', 'status', 'nextTurnRevision', 'answerAvailable']) ||
    (value.status !== 'approved' && value.status !== 'rejected') || !safeRevision(value.nextTurnRevision) || typeof value.answerAvailable !== 'boolean') return null
  return { kind: 'broker', approvalId: value.waitId, itemId: value.itemId, toolCallId: value.toolCallId as string | null, status: value.status, nextTurnRevision: value.nextTurnRevision, answerAvailable: value.answerAvailable }
}

/** Strictly validates both legacy audit and broker wait approval facts. */
export function parseApprovalLedgerEvent(value: unknown, expectedSessionId: string): ParsedApprovalLedgerEvent | null {
  try {
    if (!plain(value) || !safeId(expectedSessionId) || !exact(value, ['schemaVersion', 'id', 'sessionId', 'turnId', 'itemId', 'taskId', 'type', 'actor', 'sequence', 'payload'], ['correlationId', 'causationId', 'idempotencyKey', 'createdAt']) ||
      value.schemaVersion !== AGENT_STREAM_SCHEMA_VERSION || !safeId(value.id) || value.sessionId !== expectedSessionId || !safeId(value.turnId) ||
      (value.itemId !== null && !safeId(value.itemId)) || (value.taskId !== null && !safeId(value.taskId)) || !APPROVAL_LEDGER_EVENT_TYPES.includes(value.type as ApprovalLedgerEventType) ||
      (value.type === 'approval.resolved' ? (value.actor !== 'user' && value.actor !== 'system') : value.actor !== ACTORS[value.type as ApprovalLedgerEventType]) || typeof value.sequence !== 'string' || !SAFE_SEQUENCE.test(value.sequence) || value.sequence.length > 39 ||
      (value.correlationId !== undefined && !safeId(value.correlationId)) || (value.causationId !== undefined && value.causationId !== null && !safeId(value.causationId)) ||
      (value.idempotencyKey !== undefined && value.idempotencyKey !== null && !safeId(value.idempotencyKey)) || (value.createdAt !== undefined && !safeId(value.createdAt, 64))) return null
    const payloadSize = encodedBytes(value.payload)
    const eventSize = encodedBytes(value)
    if (payloadSize === null || payloadSize > APPROVAL_LEDGER_MAX_PAYLOAD_BYTES || eventSize === null || eventSize > APPROVAL_LEDGER_MAX_EVENT_BYTES) return null
    const receipt = value.type === 'approval.resolved' && plain(value.payload) && value.payload.waitKind === 'approval'
      ? brokerPayload(value.payload, value) : auditPayload(value.payload)
    if (!receipt || (receipt.kind === 'broker' && (value.type !== 'approval.resolved' || (receipt.status === 'cancelled' ? value.actor !== 'system' : value.actor !== 'user'))) || (receipt.kind === 'audit' && (value.itemId !== null || (value.type === 'approval.resolved' && value.actor !== 'user')))) return null
    return { ...value, type: value.type as ApprovalLedgerEventType, actor: value.actor as string, receipt } as ParsedApprovalLedgerEvent
  } catch { return null }
}

/** Builds a browser-safe envelope only after raw and sanitized strict parses pass. */
export function projectApprovalLedgerRow(row: ApprovalLedgerEventRow, expectedSessionId: string, redact: (value: unknown) => unknown): ApprovalLedgerEnvelope | null {
  const sequence = typeof row.sequence === 'bigint' ? row.sequence.toString() : typeof row.sequence === 'string' ? row.sequence : ''
  const candidate = { schemaVersion: AGENT_STREAM_SCHEMA_VERSION, id: row.id, sessionId: row.sessionId, turnId: row.turnId, itemId: row.itemId, taskId: row.taskId, type: row.type, actor: row.actor, sequence, payload: row.payload }
  const raw = parseApprovalLedgerEvent(candidate, expectedSessionId)
  if (!raw || !plain(redact(row.payload))) return null
  const payload = raw.receipt.kind === 'audit'
    ? { approvalId: raw.receipt.approvalId, ...(raw.receipt.action === undefined ? {} : { action: raw.receipt.action }), ...(raw.receipt.revision === undefined ? {} : { revision: raw.receipt.revision }) }
    : raw.receipt.status === 'cancelled'
      ? { waitKind: 'approval', waitId: raw.receipt.approvalId, itemId: raw.receipt.itemId, turnId: raw.turnId, toolCallId: raw.receipt.toolCallId, outcome: 'cancelled', reason: 'interrupt' }
      : { waitKind: 'approval', waitId: raw.receipt.approvalId, itemId: raw.receipt.itemId, turnId: raw.turnId, toolCallId: raw.receipt.toolCallId, status: raw.receipt.status, nextTurnRevision: raw.receipt.nextTurnRevision, answerAvailable: raw.receipt.answerAvailable }
  const safe = { ...candidate, payload }
  return parseApprovalLedgerEvent(safe, expectedSessionId) ? safe as ApprovalLedgerEnvelope : null
}
