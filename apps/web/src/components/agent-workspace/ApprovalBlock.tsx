'use client'

import React from 'react'
import type { AgentTranscriptEvent } from './session-view-model'
import { TranscriptActionButtons } from './TranscriptActionButtons'
import type { TranscriptAction } from './TranscriptSpecialBlocks'
import { useI18n } from '@/lib/i18n'
import { approvalPresentation, readApprovalScope } from './agent-workspace-projection'

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function text(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return null
}

function nestedRecord(event: AgentTranscriptEvent, key: string): Record<string, unknown> {
  if (!isRecord(event.data)) return {}
  const nested = event.data[key]
  return isRecord(nested) ? nested : event.data
}

export function ApprovalBlock({ event, border, acted, onAction }: {
  event: AgentTranscriptEvent
  border: string
  acted?: boolean
  onAction?: (action: TranscriptAction) => Promise<void> | void
}) {
  const { t } = useI18n()
  const eventData = isRecord(event.data) ? event.data : {}
  const payload = nestedRecord(event, 'approval')
  const impact = isRecord(payload.impact) ? payload.impact : {}
  const approvalId = text(payload.id) ?? text(payload.approvalId)
  const receiptNonce = text(payload.receiptNonce)
  const rawScope = payload.scope ?? eventData.scope ?? payload
  const parsedScope = readApprovalScope(rawScope)
  const scope = { ...parsedScope, scopeHash: parsedScope.scopeHash ?? text(payload.scopeHash) ?? text(eventData.scopeHash) }
  const presentation = approvalPresentation({
    approvalId,
    status: text(payload.status) ?? text(eventData.status) ?? 'pending',
    acted,
    scope,
    eventTurnId: text(payload.turnId) ?? text(eventData.turnId),
  })
  const status = acted ? 'recorded' : presentation.state
  const scopeRows: Array<[string, string]> = [
    ['Scope', scope.action ?? 'Unavailable'],
    ['Session', scope.sessionId ?? 'Unavailable'],
    ['Turn', scope.turnId ?? 'Unavailable'],
    ['Job', scope.jobId ?? 'Unavailable'],
    ['Tool call', scope.toolCallId ?? 'Unavailable'],
    ['Resource hash', scope.resourceHash ?? 'Unavailable'],
    ['Material hash', scope.materialHash ?? 'Unavailable'],
    ['Answers hash', scope.answersHash ?? 'Unavailable'],
    ['Scope hash', scope.scopeHash ?? 'Unavailable'],
    ['Revision', scope.revision == null ? 'Unavailable' : String(scope.revision)],
    ['Expires', scope.expiresAt ?? 'Unavailable'],
  ]

  return (
    <div>
      <BodyText>{event.body}</BodyText>
      <KeyValueGrid border={border} rows={[
        [t('agent.type'), text(payload.type) ?? text(event.title) ?? 'approval'],
        [t('agent.status'), status],
        [t('agent.impact'), Object.entries(impact).map(([k, v]) => `${k}: ${text(v) ?? 'set'}`).join(' · ') || t('agent.requiresDecision')],
      ]} />
      <details style={{ marginTop: 8 }}>
        <summary style={{ cursor: 'pointer', fontSize: 10, color: 'var(--text-muted)', fontWeight: 650 }}>Approval scope and version</summary>
        <KeyValueGrid border={border} rows={scopeRows} />
      </details>
      {presentation.state !== 'pending' ? (
        <div style={{ marginTop: 8, fontSize: 10, color: presentation.state === 'answered' ? 'var(--c-success)' : '#d97706', fontWeight: 650 }}>
          {acted ? t('agent.decisionRecorded') : presentation.reason}
        </div>
      ) : !presentation.canAct || !onAction ? (
        <div style={{ marginTop: 8, fontSize: 10, color: 'var(--text-muted)' }}>{presentation.reason}</div>
      ) : (
        <TranscriptActionButtons actions={[
          { label: t('agent.approve'), onClick: () => onAction({ type: 'approval_response', approvalId, receiptNonce, decision: 'approved', body: 'Approved the requested action.' }) },
          { label: t('agent.reviewAction'), onClick: () => onAction({ type: 'approval_response', approvalId, receiptNonce, decision: 'review', body: 'Asked to review the requested action.' }) },
          { label: t('agent.cancelAction'), onClick: () => onAction({ type: 'approval_response', approvalId, receiptNonce, decision: 'cancelled', body: 'Cancelled the requested action.' }) },
        ]} />
      )}
    </div>
  )
}

function BodyText({ children }: { children: string }) {
  if (!children) return null
  return <div style={{ whiteSpace: 'pre-wrap', fontSize: 12, lineHeight: 1.7, color: 'var(--text)' }}>{children}</div>
}

function KeyValueGrid({ rows, border }: { rows: Array<[string, string]>; border: string }) {
  return (
    <div style={{ border: `1px solid ${border}`, borderRadius: 7, overflow: 'hidden', marginTop: 8 }}>
      {rows.map(([label, value], index) => (
        <div key={label} style={{
          display: 'grid',
          gridTemplateColumns: '92px 1fr',
          gap: 10,
          padding: '7px 9px',
          borderTop: index === 0 ? 'none' : `1px solid ${border}`,
          fontSize: 10,
        }}>
          <span style={{ color: 'var(--text-muted)' }}>{label}</span>
          <span style={{ color: 'var(--text)', fontWeight: 600 }}>{value}</span>
        </div>
      ))}
    </div>
  )
}
