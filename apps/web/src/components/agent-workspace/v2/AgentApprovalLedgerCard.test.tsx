import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { I18nProvider, translate } from '@/lib/i18n'

import { AgentApprovalLedgerCard } from './AgentApprovalLedgerCard'
import { createApprovalLedgerState, reduceApprovalLedger, selectApprovalLedgerProjection } from './approval-ledger-view'

function ledger() {
  const requested = { schemaVersion: 'agent-harness.v2', id: 'request-1', sessionId: 'session-1', turnId: 'turn-1', itemId: null, taskId: null, type: 'approval.requested', actor: 'orchestrator', sequence: '1', payload: { approvalId: 'opaque-approval', action: 'submit_application', scopeHash: `sha256:${'a'.repeat(64)}`, revision: 2 } }
  const resolved = { schemaVersion: 'agent-harness.v2', id: 'resolve-1', sessionId: 'session-1', turnId: 'turn-1', itemId: null, taskId: null, type: 'approval.resolved', actor: 'user', sequence: '2', payload: { approvalId: 'opaque-approval', action: 'submit_application', scopeHash: `sha256:${'a'.repeat(64)}`, revision: 2 } }
  return selectApprovalLedgerProjection(reduceApprovalLedger(reduceApprovalLedger(createApprovalLedgerState('session-1'), requested), resolved))
}

describe('AgentApprovalLedgerCard', () => {
  it('renders translated safe status without receipt material or actions', () => {
    const html = renderToStaticMarkup(<I18nProvider><AgentApprovalLedgerCard ledger={ledger()} /></I18nProvider>)
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
    const html = renderToStaticMarkup(<I18nProvider><AgentApprovalLedgerCard ledger={selectApprovalLedgerProjection(createApprovalLedgerState('session-1'))} /></I18nProvider>)
    expect(html).toBe('')
  })

  it('renders a translated cancellation status without controls', () => {
    const ledger = { sessionId: 'session-1', approvals: [{ status: 'cancelled' as const, action: 'submit_application' }], pending: [], currentPending: null, pendingCount: 0 }
    const html = renderToStaticMarkup(<I18nProvider><AgentApprovalLedgerCard ledger={ledger} /></I18nProvider>)
    expect(html).toContain(translate('en', 'agent.approvalLedger.status.cancelled'))
    expect(html).not.toContain('<button')
  })
})
