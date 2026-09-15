import { isAfter } from './timeline-reducer-utils'
import { parseApprovalLedgerEvent, APPROVAL_LEDGER_MAX_EVENTS, type ParsedApprovalLedgerEvent } from './approval-ledger-parser'

export type ApprovalLedgerProjectionStatus = 'pending' | 'resolved' | 'approved' | 'rejected' | 'cancelled' | 'consumed' | 'expired'

interface ApprovalRecord {
  readonly approvalId: string
  readonly turnId: string
  readonly taskId: string | null
  readonly status: ApprovalLedgerProjectionStatus
  readonly action?: string
  readonly revision?: number
  readonly sequence: string
  readonly eventId: string
}

export interface ApprovalLedgerApproval {
  readonly status: ApprovalLedgerProjectionStatus
  readonly action?: string
  readonly revision?: number
}

export interface ApprovalLedgerProjection {
  readonly sessionId: string
  readonly approvals: readonly ApprovalLedgerApproval[]
  readonly pending: readonly ApprovalLedgerApproval[]
  readonly currentPending: ApprovalLedgerApproval | null
  readonly pendingCount: number
}

export interface ApprovalLedgerState {
  readonly sessionId: string
  readonly records: readonly ApprovalRecord[]
  readonly projection: ApprovalLedgerProjection
}

export function createApprovalLedgerState(sessionId: string): ApprovalLedgerState {
  return { sessionId, records: [], projection: emptyProjection(sessionId) }
}

/** Folds server-owned approval facts while keeping identifiers reducer-owned. */
export function reduceApprovalLedger(state: ApprovalLedgerState, value: unknown): ApprovalLedgerState {
  const event = parseApprovalLedgerEvent(value, state.sessionId)
  if (!event) return state
  const current = state.records.find(record => record.approvalId === event.receipt.approvalId)
  const next = nextRecord(current, event)
  if (!next) return state
  const records = [...state.records.filter(record => record.approvalId !== next.approvalId), next]
    .sort((left, right) => compareSequence(right.sequence, left.sequence) || right.eventId.localeCompare(left.eventId))
    .slice(0, APPROVAL_LEDGER_MAX_EVENTS)
  return { ...state, records, projection: buildProjection(state.sessionId, records) }
}

function nextRecord(current: ApprovalRecord | undefined, event: ParsedApprovalLedgerEvent): ApprovalRecord | null {
  const receipt = event.receipt
  if (current && !isAfter(event.sequence, current.sequence)) return null
  if (current && (current.turnId !== event.turnId || current.taskId !== event.taskId)) return null
  const action = receipt.kind === 'audit' ? receipt.action : current?.action
  const revision = receipt.kind === 'audit' ? receipt.revision : current?.revision
  if (current && current.action && receipt.kind === 'audit' && receipt.action && current.action !== receipt.action) return null
  if (event.type === 'approval.requested') return current ? null : { approvalId: receipt.approvalId, turnId: event.turnId, taskId: event.taskId, status: 'pending', action, revision, sequence: event.sequence, eventId: event.id }
  if (event.type === 'approval.resolved') {
    if (!current || current.status !== 'pending') return null
    const status = receipt.kind === 'broker' ? receipt.status : 'resolved'
    return { ...current, status, action: action ?? current.action, revision: revision ?? current.revision, sequence: event.sequence, eventId: event.id }
  }
  if (event.type === 'approval.consumed') {
    if (!current || (current.status !== 'approved' && current.status !== 'resolved')) return null
    return { ...current, status: 'consumed', sequence: event.sequence, eventId: event.id }
  }
  if (!current || current.status !== 'pending') return null
  return { ...current, status: 'expired', sequence: event.sequence, eventId: event.id }
}

function buildProjection(sessionId: string, records: readonly ApprovalRecord[]): ApprovalLedgerProjection {
  const approvals = records.map(({ approvalId: _approvalId, turnId: _turnId, taskId: _taskId, sequence: _sequence, eventId: _eventId, ...safe }) => safe)
  const pending = approvals.filter(approval => approval.status === 'pending')
  return { sessionId, approvals, pending, currentPending: pending[0] ?? null, pendingCount: pending.length }
}

function emptyProjection(sessionId: string): ApprovalLedgerProjection {
  return { sessionId, approvals: [], pending: [], currentPending: null, pendingCount: 0 }
}

function compareSequence(left: string, right: string): number {
  const leftValue = BigInt(left)
  const rightValue = BigInt(right)
  return leftValue === rightValue ? 0 : leftValue < rightValue ? -1 : 1
}

export function selectApprovalLedgerApprovals(state: ApprovalLedgerState): readonly ApprovalLedgerApproval[] { return state.projection.approvals }
export function selectApprovalLedgerPending(state: ApprovalLedgerState): readonly ApprovalLedgerApproval[] { return state.projection.pending }
export function selectApprovalLedgerProjection(state: ApprovalLedgerState): ApprovalLedgerProjection { return state.projection }
