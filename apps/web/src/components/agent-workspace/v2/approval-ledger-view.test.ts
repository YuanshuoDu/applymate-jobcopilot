import { describe, expect, it } from 'vitest'

import { createApprovalLedgerState, reduceApprovalLedger, selectApprovalLedgerPending, selectApprovalLedgerProjection } from './approval-ledger-view'
import { normalizeTimelineEvent } from './timeline-event-normalizer'

const audit = (type: string, actor: string, sequence: string, approvalId = 'approval-1', payload: Record<string, unknown> = {}) => ({
  schemaVersion: 'agent-harness.v2', id: `${type}-${sequence}-${approvalId}`, sessionId: 'session-1', turnId: 'turn-1', itemId: null, taskId: null,
  type, actor, sequence, payload: { approvalId, action: 'submit_application', revision: 2, scopeHash: `sha256:${'a'.repeat(64)}`, ...payload },
})

const brokerResolved = (sequence: string, status: 'approved' | 'rejected', approvalId = 'approval-1') => ({
  schemaVersion: 'agent-harness.v2', id: `resolved-${sequence}`, sessionId: 'session-1', turnId: 'turn-1', itemId: `item-${approvalId}`, taskId: null,
  type: 'approval.resolved', actor: 'user', sequence,
  payload: { waitKind: 'approval', waitId: approvalId, itemId: `item-${approvalId}`, turnId: 'turn-1', toolCallId: 'call-1', status, nextTurnRevision: 3, answerAvailable: false },
})

describe('approval ledger reducer', () => {
  it('folds requested, legacy resolved, and consumed facts into a safe terminal state', () => {
    let state = reduceApprovalLedger(createApprovalLedgerState('session-1'), audit('approval.requested', 'orchestrator', '1'))
    expect(selectApprovalLedgerPending(state)).toHaveLength(1)
    expect(selectApprovalLedgerProjection(state).pendingActions).toEqual([{ approvalId: 'approval-1', turnId: 'turn-1', taskId: null, action: 'submit_application' }])
    state = reduceApprovalLedger(state, audit('approval.resolved', 'user', '2'))
    state = reduceApprovalLedger(state, audit('approval.consumed', 'system', '3'))

    expect(selectApprovalLedgerProjection(state)).toMatchObject({ pendingCount: 0, approvals: [{ status: 'consumed', action: 'submit_application', revision: 2 }] })
    expect(JSON.stringify(selectApprovalLedgerProjection(state).approvals)).not.toContain('approval-1')
    expect(JSON.stringify(selectApprovalLedgerProjection(state).approvals)).not.toContain('scopeHash')
    expect(selectApprovalLedgerProjection(state).pendingActions).toEqual([])
  })

  it('preserves broker approved or rejected decisions and allows consumption only after approval', () => {
    let state = reduceApprovalLedger(createApprovalLedgerState('session-1'), audit('approval.requested', 'orchestrator', '1'))
    state = reduceApprovalLedger(state, brokerResolved('2', 'approved'))
    expect(selectApprovalLedgerProjection(state).approvals[0]?.status).toBe('approved')
    state = reduceApprovalLedger(state, audit('approval.consumed', 'system', '3'))
    expect(selectApprovalLedgerProjection(state).approvals[0]?.status).toBe('consumed')

    let rejected = reduceApprovalLedger(createApprovalLedgerState('session-1'), audit('approval.requested', 'orchestrator', '1', 'approval-2'))
    rejected = reduceApprovalLedger(rejected, brokerResolved('2', 'rejected', 'approval-2'))
    expect(selectApprovalLedgerProjection(rejected).approvals[0]?.status).toBe('rejected')
    expect(reduceApprovalLedger(rejected, audit('approval.consumed', 'system', '3', 'approval-2'))).toBe(rejected)
  })

  it('handles expiry, duplicates, stale events, and cross approval events safely', () => {
    let state = reduceApprovalLedger(createApprovalLedgerState('session-1'), audit('approval.requested', 'orchestrator', '1'))
    state = reduceApprovalLedger(state, audit('approval.expired', 'system', '2'))
    expect(selectApprovalLedgerProjection(state).approvals[0]?.status).toBe('expired')
    expect(reduceApprovalLedger(state, audit('approval.requested', 'orchestrator', '3'))).toBe(state)
    expect(reduceApprovalLedger(state, audit('approval.expired', 'system', '1'))).toBe(state)
    expect(reduceApprovalLedger(state, audit('approval.consumed', 'system', '4', 'other-approval'))).toBe(state)
  })

  it('preserves the system interrupt as cancelled instead of inventing a decision', () => {
    const requested = audit('approval.requested', 'orchestrator', '1', 'approval-cancelled')
    const cancelled = {
      schemaVersion: 'agent-harness.v2', id: 'cancelled-2', sessionId: 'session-1', turnId: 'turn-1', itemId: 'wait-item', taskId: null,
      type: 'approval.resolved', actor: 'system', sequence: '2', payload: {
        waitKind: 'approval', waitId: 'approval-cancelled', itemId: 'wait-item', turnId: 'turn-1', toolCallId: 'call-1', outcome: 'cancelled', reason: 'interrupt',
      },
    }
    let state = reduceApprovalLedger(createApprovalLedgerState('session-1'), requested)
    state = reduceApprovalLedger(state, cancelled)
    expect(selectApprovalLedgerProjection(state).approvals[0]?.status).toBe('cancelled')
    expect(selectApprovalLedgerProjection(state).pendingActions).toEqual([])
  })

  it('rejects the same approval id when a later event changes turn or task lineage', () => {
    const requested = audit('approval.requested', 'orchestrator', '1')
    const foreignLineage = { ...audit('approval.resolved', 'user', '2'), turnId: 'turn-2', taskId: 'task-2' }
    let state = reduceApprovalLedger(createApprovalLedgerState('session-1'), requested)
    expect(reduceApprovalLedger(state, foreignLineage)).toBe(state)
  })

  it.each(['approved', 'rejected'] as const)('clears pending actions for normalized broker %s and cannot reopen them', status => {
    const requested = normalizeTimelineEvent(audit('approval.requested', 'orchestrator', '1'))
    const resolved = normalizeTimelineEvent(brokerResolved('2', status))
    const pending = reduceApprovalLedger(createApprovalLedgerState('session-1'), requested)
    expect(pending.projection.pendingCount).toBe(1)
    for (const invalid of [{ extra: undefined }, { actor: 'system' }, { sessionId: 'foreign-session' }]) {
      expect(reduceApprovalLedger(pending, { ...resolved, ...invalid })).toBe(pending)
    }
    const settled = reduceApprovalLedger(pending, resolved)
    expect(settled.projection).toMatchObject({ pendingCount: 0, pendingActions: [], approvals: [{ status }] })
    expect(reduceApprovalLedger(settled, normalizeTimelineEvent(audit('approval.requested', 'orchestrator', '3')))).toBe(settled)
    expect(reduceApprovalLedger(settled, resolved)).toBe(settled)
    const consumed = reduceApprovalLedger(settled, normalizeTimelineEvent(audit('approval.consumed', 'system', '4')))
    if (status === 'rejected') expect(consumed).toBe(settled)
    else expect(consumed.projection.approvals[0]?.status).toBe('consumed')
  })

  it('clears pending actions after normalized audit resolution and interrupt cancellation', () => {
    const requested = normalizeTimelineEvent(audit('approval.requested', 'orchestrator', '1'))
    const pending = reduceApprovalLedger(createApprovalLedgerState('session-1'), requested)
    const resolved = reduceApprovalLedger(pending, normalizeTimelineEvent(audit('approval.resolved', 'user', '2')))
    expect(resolved.projection).toMatchObject({ pendingCount: 0, pendingActions: [], approvals: [{ status: 'resolved' }] })
    const cancelled = reduceApprovalLedger(pending, normalizeTimelineEvent({
      ...brokerResolved('2', 'approved'), actor: 'system', payload: {
        waitKind: 'approval', waitId: 'approval-1', itemId: 'item-approval-1', turnId: 'turn-1', toolCallId: 'call-1', outcome: 'cancelled', reason: 'interrupt',
      },
    }))
    expect(cancelled.projection).toMatchObject({ pendingCount: 0, pendingActions: [], approvals: [{ status: 'cancelled' }] })
  })
})
