import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { I18nProvider, translate } from '@/lib/i18n'

import { AgentApprovalLedgerCard, isApprovalActionDisabled } from './AgentApprovalLedgerCard'
import { createApprovalLedgerState, reduceApprovalLedger, selectApprovalLedgerProjection } from './approval-ledger-view'

const turns = [{
  id: 'turn-1', sessionId: 'session-1', source: 'automation', goal: 'hidden goal', status: 'waiting_for_approval', revision: 7,
  activeStepId: null, finalItemId: null, createdAt: '2026-09-15T00:00:00.000Z', updatedAt: '2026-09-15T00:00:00.000Z', completedAt: null,
}]

function cardProps(ledger: ReturnType<typeof selectApprovalLedgerProjection>) {
  return { ledger, sessionId: 'session-1', turns, controlGate: 'open' as const, onAccepted: () => undefined }
}

function ledger() {
  const requested = { schemaVersion: 'agent-harness.v2', id: 'request-1', sessionId: 'session-1', turnId: 'turn-1', itemId: null, taskId: null, type: 'approval.requested', actor: 'orchestrator', sequence: '1', payload: { approvalId: 'opaque-approval', action: 'submit_application', scopeHash: `sha256:${'a'.repeat(64)}`, revision: 2 } }
  const resolved = { schemaVersion: 'agent-harness.v2', id: 'resolve-1', sessionId: 'session-1', turnId: 'turn-1', itemId: null, taskId: null, type: 'approval.resolved', actor: 'user', sequence: '2', payload: { approvalId: 'opaque-approval', action: 'submit_application', scopeHash: `sha256:${'a'.repeat(64)}`, revision: 2 } }
  return selectApprovalLedgerProjection(reduceApprovalLedger(reduceApprovalLedger(createApprovalLedgerState('session-1'), requested), resolved))
}

describe('AgentApprovalLedgerCard', () => {
  it('renders translated safe status without receipt material or actions', () => {
    const html = renderToStaticMarkup(<I18nProvider><AgentApprovalLedgerCard {...cardProps(ledger())} /></I18nProvider>)
    expect(html).toContain('data-agent-approval-ledger="true"')
    expect(html).toContain(translate('en', 'agent.approvalLedger.title'))
    expect(html).toContain(translate('en', 'agent.approvalLedger.status.resolved'))
    expect(html).toContain('submit_application')
    expect(html).toContain('Revision: 2')
    expect(html).not.toContain('opaque-approval')
    expect(html).not.toContain('scopeHash')
    expect(html).not.toContain('<button')
  })

  it('stays hidden with no approval facts', () => {
    const html = renderToStaticMarkup(<I18nProvider><AgentApprovalLedgerCard {...cardProps(selectApprovalLedgerProjection(createApprovalLedgerState('session-1')))} /></I18nProvider>)
    expect(html).toBe('')
  })

  it('renders a translated cancellation status without controls', () => {
    const ledger = { sessionId: 'session-1', approvals: [{ status: 'cancelled' as const, action: 'submit_application' }], pending: [], pendingActions: [], currentPending: null, pendingCount: 0 }
    const html = renderToStaticMarkup(<I18nProvider><AgentApprovalLedgerCard {...cardProps(ledger)} /></I18nProvider>)
    expect(html).toContain(translate('en', 'agent.approvalLedger.status.cancelled'))
    expect(html).not.toContain('<button')
  })

  it('renders pending decision controls without exposing action references', () => {
    const requested = { schemaVersion: 'agent-harness.v2', id: 'request-1', sessionId: 'session-1', turnId: 'turn-1', itemId: null, taskId: null, type: 'approval.requested', actor: 'orchestrator', sequence: '1', payload: { approvalId: 'opaque-approval', action: 'submit_application', scopeHash: `sha256:${'a'.repeat(64)}`, revision: 2 } }
    const pending = selectApprovalLedgerProjection(reduceApprovalLedger(createApprovalLedgerState('session-1'), requested))
    const html = renderToStaticMarkup(<I18nProvider><AgentApprovalLedgerCard {...cardProps(pending)} /></I18nProvider>)
    expect(html.match(/<button/g)).toHaveLength(2)
    expect(html).toContain(translate('en', 'agent.approvalLedger.approve'))
    expect(html).toContain(translate('en', 'agent.approvalLedger.reject'))
    expect(html).not.toContain('opaque-approval')
    expect(html).not.toContain('turn-1')
    expect(html).not.toContain('scopeHash')
  })

  it('disables controls and explains paused or unavailable Turn state', () => {
    const requested = { schemaVersion: 'agent-harness.v2', id: 'request-2', sessionId: 'session-1', turnId: 'missing-turn', itemId: null, taskId: null, type: 'approval.requested', actor: 'orchestrator', sequence: '1', payload: { approvalId: 'opaque-approval', action: 'submit_application' } }
    const pending = selectApprovalLedgerProjection(reduceApprovalLedger(createApprovalLedgerState('session-1'), requested))
    const html = renderToStaticMarkup(<I18nProvider><AgentApprovalLedgerCard {...cardProps(pending)} controlGate="user_paused" /></I18nProvider>)
    expect(html.match(/disabled=""/g)).toHaveLength(2)
    expect(html).toContain(translate('en', 'agent.approvalLedger.resumeFirst'))
    expect(html).toContain(translate('en', 'agent.approvalLedger.turnUnavailable'))
  })

  it('keeps acknowledged commands fenced until authoritative state changes', () => {
    expect(isApprovalActionDisabled(false, false, false, 'accepted')).toBe(true)
    expect(isApprovalActionDisabled(false, false, false, 'duplicate')).toBe(true)
    expect(isApprovalActionDisabled(false, false, false, 'failed')).toBe(false)
  })
})
