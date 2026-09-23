import { describe, expect, it } from 'vitest'

import { projectApprovalLedgerRow, parseApprovalLedgerEvent } from './approval-ledger-parser'

const legacy = (type: string, actor: string, payload: Record<string, unknown> = {}) => ({
  schemaVersion: 'agent-harness.v2', id: `${type}-1`, sessionId: 'session-1', turnId: 'turn-1', itemId: null, taskId: null,
  type, actor, sequence: '7', payload: { approvalId: 'approval-1', action: 'submit_application', scopeHash: `sha256:${'a'.repeat(64)}`, revision: 2, ...payload },
})

const broker = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 'agent-harness.v2', id: 'resolved-1', sessionId: 'session-1', turnId: 'turn-1', itemId: 'wait-item-1', taskId: null,
  type: 'approval.resolved', actor: 'user', sequence: '8', correlationId: 'wait-1', causationId: 'wait-item-1', idempotencyKey: 'decision-1', createdAt: '2026-09-15T00:00:00.000Z',
  payload: { waitKind: 'approval', waitId: 'wait-1', itemId: 'wait-item-1', turnId: 'turn-1', toolCallId: 'call-1', status: 'approved', nextTurnRevision: 4, answerAvailable: false, ...overrides },
})

const cancelledBroker = () => ({
  schemaVersion: 'agent-harness.v2', id: 'cancelled-1', sessionId: 'session-1', turnId: 'turn-1', itemId: 'wait-item-1', taskId: null,
  type: 'approval.resolved', actor: 'system', sequence: '8', payload: { waitKind: 'approval', waitId: 'wait-1', itemId: 'wait-item-1', turnId: 'turn-1', toolCallId: 'call-1', outcome: 'cancelled', reason: 'interrupt' },
})

describe('approval ledger parser', () => {
  it('accepts legacy audit and broker wait receipts with optional envelope metadata', () => {
    expect(parseApprovalLedgerEvent(legacy('approval.requested', 'orchestrator'), 'session-1')?.receipt).toEqual({ kind: 'audit', approvalId: 'approval-1', action: 'submit_application', revision: 2 })
    expect(parseApprovalLedgerEvent(broker(), 'session-1')?.receipt).toMatchObject({ kind: 'broker', approvalId: 'wait-1', status: 'approved', nextTurnRevision: 4 })
    expect(parseApprovalLedgerEvent(cancelledBroker(), 'session-1')?.receipt).toMatchObject({ kind: 'broker', approvalId: 'wait-1', status: 'cancelled' })
  })

  it('rejects foreign, wrong-actor, wrong-item, malformed, and unsupported receipts', () => {
    expect(parseApprovalLedgerEvent({ ...legacy('approval.requested', 'orchestrator'), sessionId: 'session-2' }, 'session-1')).toBeNull()
    expect(parseApprovalLedgerEvent(legacy('approval.requested', 'user'), 'session-1')).toBeNull()
    expect(parseApprovalLedgerEvent(broker({ itemId: 'other-item' }), 'session-1')).toBeNull()
    expect(parseApprovalLedgerEvent(legacy('approval.requested', 'orchestrator', { revision: '2' }), 'session-1')).toBeNull()
    expect(parseApprovalLedgerEvent(legacy('approval.expired', 'system', { scopeHash: 'bad', evidence: 'secret' }), 'session-1')).toBeNull()
    expect(parseApprovalLedgerEvent({ ...cancelledBroker(), payload: { ...cancelledBroker().payload, reason: 'other' } }, 'session-1')).toBeNull()
  })

  it('redacts legacy receipt material only after raw validation and omits scope hash', () => {
    const row = { ...legacy('approval.requested', 'orchestrator'), sequence: BigInt(7) }
    const result = projectApprovalLedgerRow(row, 'session-1', value => value)
    expect(result).toMatchObject({ id: 'approval.requested-1', payload: { approvalId: 'approval-1', action: 'submit_application', revision: 2 } })
    expect(JSON.stringify(result)).not.toContain('scopeHash')
  })
})
