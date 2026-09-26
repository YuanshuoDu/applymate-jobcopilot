'use client'

import React, { useCallback, useEffect, useRef, useState } from 'react'

import { useI18n } from '@/lib/i18n'

import { createAgentApprovalMessageId, isCurrentAgentApprovalRequest, postAgentApprovalDecision, type ApprovalDecision } from './approval-action'
import type { ApprovalLedgerActionRef, ApprovalLedgerApproval, ApprovalLedgerProjection, ApprovalLedgerProjectionStatus } from './approval-ledger-view'
import type { SupervisorTurnSummary } from './task-tree-projection'

export interface AgentApprovalLedgerCardProps {
  readonly ledger: ApprovalLedgerProjection
  readonly sessionId: string
  readonly turns: readonly SupervisorTurnSummary[]
  readonly onAccepted: () => void
  readonly selectionKey?: string
}

export type ApprovalActionFeedback = 'accepted' | 'duplicate' | 'failed'
type BooleanById = Record<string, boolean>
type FeedbackById = Record<string, ApprovalActionFeedback | undefined>

const STATUS_KEYS: Record<ApprovalLedgerProjectionStatus, string> = {
  pending: 'agent.approvalLedger.status.pending', resolved: 'agent.approvalLedger.status.resolved', approved: 'agent.approvalLedger.status.approved', cancelled: 'agent.approvalLedger.status.cancelled',
  rejected: 'agent.approvalLedger.status.rejected', consumed: 'agent.approvalLedger.status.consumed', expired: 'agent.approvalLedger.status.expired',
}

/** Server-owned approval facts with a guarded, non-optimistic decision command. */
export function AgentApprovalLedgerCard({ ledger, sessionId, turns, onAccepted, selectionKey: externalSelectionKey = '' }: AgentApprovalLedgerCardProps) {
  const { t } = useI18n()
  const [submitting, setSubmitting] = useState<BooleanById>({})
  const [feedback, setFeedback] = useState<FeedbackById>({})
  const requestEpochRef = useRef(0)
  const previousSelectionKeyRef = useRef('')
  const submittingKeysRef = useRef(new Set<string>())
  const selectionKey = `${sessionId}:${externalSelectionKey}:${ledger.pendingActions.map(ref => `${ref.approvalId}:${ref.turnId}:${turnRevision(turns, sessionId, ref.turnId) ?? 'unavailable'}`).join(',')}`

  // Advance during render so a late response cannot win a session, selection, or Turn revision change.
  if (previousSelectionKeyRef.current !== selectionKey) {
    previousSelectionKeyRef.current = selectionKey
    requestEpochRef.current += 1
  }

  useEffect(() => {
    setSubmitting({})
    setFeedback({})
  }, [selectionKey])

  const handleDecision = useCallback((actionRef: ApprovalLedgerActionRef, expectedRevision: number, decision: ApprovalDecision) => {
    const requestKey = `${actionRef.approvalId}:${actionRef.turnId}:${expectedRevision}`
    if (submittingKeysRef.current.has(requestKey)) return
    submittingKeysRef.current.add(requestKey)
    const requestEpoch = requestEpochRef.current
    const requestSelectionKey = selectionKey
    const clientMessageId = createAgentApprovalMessageId()
    setSubmitting(current => ({ ...current, [actionRef.approvalId]: true }))
    setFeedback(current => ({ ...current, [actionRef.approvalId]: undefined }))
    void postAgentApprovalDecision({ sessionId, actionRef, expectedRevision, decision, clientMessageId }).then(result => {
      if (!isCurrentAgentApprovalRequest(requestEpochRef.current, requestEpoch, selectionKey, requestSelectionKey)) return
      setFeedback(current => ({ ...current, [actionRef.approvalId]: result.disposition === 'duplicate' ? 'duplicate' : 'accepted' }))
      onAccepted()
    }).catch(() => {
      if (isCurrentAgentApprovalRequest(requestEpochRef.current, requestEpoch, selectionKey, requestSelectionKey)) setFeedback(current => ({ ...current, [actionRef.approvalId]: 'failed' }))
    }).finally(() => {
      submittingKeysRef.current.delete(requestKey)
      if (isCurrentAgentApprovalRequest(requestEpochRef.current, requestEpoch, selectionKey, requestSelectionKey)) {
        setSubmitting(current => ({ ...current, [actionRef.approvalId]: false }))
      }
    })
  }, [onAccepted, selectionKey, sessionId])

  if (ledger.approvals.length === 0) return null
  const terminalApprovals = ledger.approvals.filter(approval => approval.status !== 'pending').slice(0, 8)
  return (
    <section data-agent-approval-ledger="true" aria-label={t('agent.approvalLedger.title')} style={cardStyle}>
      <div style={headingStyle}>
        <strong>{t('agent.approvalLedger.title')}</strong>
        <span style={mutedStyle}>{t('agent.approvalLedger.serverOwned')}</span>
      </div>
      <div style={summaryStyle}><span>{t('agent.approvalLedger.pending')}</span><strong>{ledger.pendingCount}</strong></div>
      <div data-agent-approval-ledger-rows="true" style={rowsStyle}>
        {ledger.pendingActions.slice(0, 8).map(actionRef => <PendingApprovalRow key={actionRef.approvalId} actionRef={actionRef} sessionId={sessionId} turns={turns} submitting={Boolean(submitting[actionRef.approvalId])} feedback={feedback[actionRef.approvalId]} onDecision={handleDecision} t={t} />)}
        {terminalApprovals.map((approval, index) => <ApprovalRow key={`${index}-${approval.status}`} approval={approval} t={t} />)}
      </div>
    </section>
  )
}

function PendingApprovalRow({ actionRef, sessionId, turns, submitting, feedback, onDecision, t }: {
  readonly actionRef: ApprovalLedgerActionRef
  readonly sessionId: string
  readonly turns: readonly SupervisorTurnSummary[]
  readonly submitting: boolean
  readonly feedback: ApprovalActionFeedback | undefined
  readonly onDecision: (actionRef: ApprovalLedgerActionRef, expectedRevision: number, decision: ApprovalDecision) => void
  readonly t: (key: string) => string
}) {
  const expectedRevision = turnRevision(turns, sessionId, actionRef.turnId)
  const unavailable = expectedRevision === null
  const disabled = isApprovalActionDisabled(submitting, unavailable, feedback)
  return (
    <div data-agent-approval-ledger-row="true" style={rowStyle}>
      <span>{actionRef.action ?? t('agent.approvalLedger.unknownAction')}</span>
      <span>{t('agent.approvalLedger.status.pending')}</span>
      <div style={actionsStyle}>
        <button type="button" disabled={disabled} onClick={() => expectedRevision !== null && onDecision(actionRef, expectedRevision, 'approved')} style={{ ...buttonStyle, opacity: disabled ? 0.68 : 1 }}>{submitting ? t('agent.approvalLedger.submitting') : t('agent.approvalLedger.approve')}</button>
        <button type="button" disabled={disabled} onClick={() => expectedRevision !== null && onDecision(actionRef, expectedRevision, 'rejected')} style={{ ...buttonStyle, opacity: disabled ? 0.68 : 1 }}>{t('agent.approvalLedger.reject')}</button>
      </div>
      {unavailable && <p role="status" aria-live="polite" style={hintStyle}>{t('agent.approvalLedger.turnUnavailable')}</p>}
      {feedback === 'accepted' && <p role="status" aria-live="polite" style={hintStyle}>{t('agent.approvalLedger.accepted')}</p>}
      {feedback === 'duplicate' && <p role="status" aria-live="polite" style={hintStyle}>{t('agent.approvalLedger.duplicate')}</p>}
      {feedback === 'failed' && <p role="alert" style={errorStyle}>{t('agent.approvalLedger.actionFailed')}</p>}
    </div>
  )
}

function ApprovalRow({ approval, t }: { readonly approval: ApprovalLedgerApproval; readonly t: (key: string) => string }) {
  return <div data-agent-approval-ledger-row="true" style={rowStyle}><span>{approval.action ?? t('agent.approvalLedger.unknownAction')}</span><span>{t(STATUS_KEYS[approval.status])}</span>{approval.revision === undefined ? null : <span style={mutedStyle}>{t('agent.approvalLedger.revision')}: {approval.revision}</span>}</div>
}

function turnRevision(turns: readonly SupervisorTurnSummary[], sessionId: string, turnId: string): number | null {
  const turn = turns.find(candidate => candidate.sessionId === sessionId && candidate.id === turnId)
  return turn && Number.isSafeInteger(turn.revision) ? turn.revision : null
}

export function isApprovalActionDisabled(submitting: boolean, unavailable: boolean, feedback: ApprovalActionFeedback | undefined): boolean {
  return submitting || unavailable || feedback === 'accepted' || feedback === 'duplicate'
}

const cardStyle: React.CSSProperties = { display: 'grid', gap: 7, marginBottom: 10, padding: 10, border: '1px solid var(--border)', borderRadius: 9, background: 'var(--bg)' }
const headingStyle: React.CSSProperties = { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8, fontSize: 12 }
const summaryStyle: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', color: 'var(--text-muted)', fontSize: 10 }
const rowsStyle: React.CSSProperties = { display: 'grid', gap: 4, paddingTop: 5, borderTop: '1px solid var(--border)' }
const rowStyle: React.CSSProperties = { display: 'grid', gap: 5, color: 'var(--text)', fontSize: 9, alignItems: 'baseline' }
const actionsStyle: React.CSSProperties = { display: 'flex', gap: 5 }
const buttonStyle: React.CSSProperties = { flex: 1, border: '1px solid var(--border)', borderRadius: 7, padding: '5px 7px', color: 'var(--text)', background: 'var(--bg-secondary)', cursor: 'pointer', font: 'inherit', fontSize: 10, fontWeight: 600 }
const mutedStyle: React.CSSProperties = { color: 'var(--text-muted)', fontSize: 9 }
const hintStyle: React.CSSProperties = { margin: 0, color: 'var(--text-muted)', fontSize: 10, lineHeight: 1.4 }
const errorStyle: React.CSSProperties = { ...hintStyle, color: 'var(--c-danger)' }
