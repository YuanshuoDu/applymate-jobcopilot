'use client'

import React from 'react'
import type { AgentTranscriptEvent } from './session-view-model'
import { TranscriptActionButtons } from './TranscriptActionButtons'
import type { TranscriptAction } from './TranscriptSpecialBlocks'

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
  const payload = nestedRecord(event, 'approval')
  const impact = isRecord(payload.impact) ? payload.impact : {}
  const approvalId = text(payload.id) ?? text(payload.approvalId)
  const status = acted ? 'recorded' : text(payload.status) ?? 'pending'

  return (
    <div>
      <BodyText>{event.body}</BodyText>
      <KeyValueGrid border={border} rows={[
        ['Type', text(payload.type) ?? text(event.title) ?? 'approval'],
        ['Status', status],
        ['Impact', Object.entries(impact).map(([k, v]) => `${k}: ${text(v) ?? 'set'}`).join(' · ') || 'requires user decision'],
      ]} />
      {acted ? (
        <div style={{ marginTop: 8, fontSize: 10, color: 'var(--c-success)', fontWeight: 650 }}>
          Decision recorded in this session.
        </div>
      ) : (
        <TranscriptActionButtons actions={[
          { label: 'Approve', onClick: () => onAction?.({ type: 'approval_response', approvalId, decision: 'approved', body: 'Approved the requested action.' }) },
          { label: 'Review', onClick: () => onAction?.({ type: 'approval_response', approvalId, decision: 'review', body: 'Asked to review the requested action.' }) },
          { label: 'Cancel', onClick: () => onAction?.({ type: 'approval_response', approvalId, decision: 'cancelled', body: 'Cancelled the requested action.' }) },
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
