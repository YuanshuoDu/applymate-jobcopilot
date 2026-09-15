'use client'

import React from 'react'

import { useI18n } from '@/lib/i18n'

import type { ApprovalLedgerApproval, ApprovalLedgerProjection, ApprovalLedgerProjectionStatus } from './approval-ledger-view'

export interface AgentApprovalLedgerCardProps {
  readonly ledger: ApprovalLedgerProjection
}

const STATUS_KEYS: Record<ApprovalLedgerProjectionStatus, string> = {
  pending: 'agent.approvalLedger.status.pending', resolved: 'agent.approvalLedger.status.resolved', approved: 'agent.approvalLedger.status.approved', cancelled: 'agent.approvalLedger.status.cancelled',
  rejected: 'agent.approvalLedger.status.rejected', consumed: 'agent.approvalLedger.status.consumed', expired: 'agent.approvalLedger.status.expired',
}

/** Compact read-only approval facts; IDs and receipt material remain reducer-owned. */
export function AgentApprovalLedgerCard({ ledger }: AgentApprovalLedgerCardProps) {
  const { t } = useI18n()
  if (ledger.approvals.length === 0) return null
  return (
    <section data-agent-approval-ledger="true" aria-label={t('agent.approvalLedger.title')} style={cardStyle}>
      <div style={headingStyle}>
        <strong>{t('agent.approvalLedger.title')}</strong>
        <span style={mutedStyle}>{t('agent.approvalLedger.serverOwned')}</span>
      </div>
      <div style={summaryStyle}><span>{t('agent.approvalLedger.pending')}</span><strong>{ledger.pendingCount}</strong></div>
      <div data-agent-approval-ledger-rows="true" style={rowsStyle}>
        {ledger.approvals.slice(0, 8).map((approval, index) => <ApprovalRow key={`${index}-${approval.status}`} approval={approval} t={t} />)}
      </div>
    </section>
  )
}

function ApprovalRow({ approval, t }: { readonly approval: ApprovalLedgerApproval; readonly t: (key: string) => string }) {
  return (
    <div data-agent-approval-ledger-row="true" style={rowStyle}>
      <span>{approval.action ?? t('agent.approvalLedger.unknownAction')}</span>
      <span>{t(STATUS_KEYS[approval.status])}</span>
      {approval.revision === undefined ? null : <span style={mutedStyle}>{t('agent.approvalLedger.revision')}: {approval.revision}</span>}
    </div>
  )
}

const cardStyle: React.CSSProperties = { display: 'grid', gap: 7, marginBottom: 10, padding: 10, border: '1px solid var(--border)', borderRadius: 9, background: 'var(--bg)' }
const headingStyle: React.CSSProperties = { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8, fontSize: 12 }
const summaryStyle: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', color: 'var(--text-muted)', fontSize: 10 }
const rowsStyle: React.CSSProperties = { display: 'grid', gap: 4, paddingTop: 5, borderTop: '1px solid var(--border)' }
const rowStyle: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr) auto', gap: 5, color: 'var(--text)', fontSize: 9, alignItems: 'baseline' }
const mutedStyle: React.CSSProperties = { color: 'var(--text-muted)', fontSize: 9 }
