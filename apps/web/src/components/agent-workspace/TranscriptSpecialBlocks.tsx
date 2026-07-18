'use client'

import React from 'react'
import type { AgentTranscriptEvent } from './session-view-model'
import { TranscriptActionButtons } from './TranscriptActionButtons'
import { ApprovalBlock } from './ApprovalBlock'

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

export function TranscriptSpecialContent({ event, border, actedApprovalIds, onAction }: {
  event: AgentTranscriptEvent
  border: string
  actedApprovalIds?: Set<string>
  onAction?: (action: TranscriptAction) => Promise<void> | void
}) {
  if (event.type === 'approval_request') {
    const payload = nestedRecord(event, 'approval')
    const approvalId = text(payload.id) ?? text(payload.approvalId)
    return <ApprovalBlock event={event} border={border} acted={approvalId ? actedApprovalIds?.has(approvalId) : false} onAction={onAction} />
  }
  if (event.type === 'automation_draft') return <AutomationDraftBlock event={event} border={border} onAction={onAction} />
  if (event.type === 'quality_gate') return <QualityGateBlock event={event} border={border} />
  if (event.type === 'job_results') return <JobResultsBlock event={event} border={border} />
  if (event.type === 'resume_tailored' || event.type === 'resume_finalized') return <ResumeArtifactBlock event={event} border={border} />

  return (
    <div style={{ whiteSpace: 'pre-wrap', fontSize: 12, lineHeight: 1.7, color: 'var(--text)' }}>
      {event.body || '(empty event)'}
    </div>
  )
}

function ResumeArtifactBlock({ event, border }: { event: AgentTranscriptEvent; border: string }) {
  const artifact = nestedRecord(event, 'resume')
  const job = nestedRecord(event, 'job')
  return (
    <div>
      <BodyText>{event.body}</BodyText>
      <KeyValueGrid border={border} rows={[
        ['Resume', text(artifact.name) ?? 'Tailored resume'],
        ['Job', [text(job.company) ?? text(artifact.company), text(job.role) ?? text(artifact.role)].filter(Boolean).join(' · ') || 'Linked job'],
        ['Status', event.type === 'resume_finalized' ? 'Confirmed for Executor' : 'Waiting for Reviewer'],
      ]} />
    </div>
  )
}

export interface TranscriptAction {
  type: 'approval_response' | 'create_automation' | 'edit_automation_draft' | 'cancel_automation_draft'
  approvalId?: string | null
  decision?: 'approved' | 'rejected' | 'cancelled' | 'review'
  body?: string
  draft?: AutomationDraftAction
  prompt?: string
}

interface AutomationDraftAction { name: string; triggerType: string; cron: string | null; timezone: string; targetRoles: string[]; targetLocations: string[]; minScore: number; dailyCap: number; requireApproval: boolean; autoApply: boolean }
function AutomationDraftBlock({ event, border, onAction }: {
  event: AgentTranscriptEvent
  border: string
  onAction?: (action: TranscriptAction) => Promise<void> | void
}) {
  const draft = nestedRecord(event, 'draft')
  const actionDraft = toAutomationDraftAction(draft)
  const rows: Array<[string, string]> = [
    ['Name', text(draft.name) ?? 'New automation'],
    ['Trigger', text(draft.trigger) ?? text(draft.triggerType) ?? text(draft.cron) ?? 'Manual'],
    ['Target', listValue(draft.targetRoles, draft.targetLocations)],
    ['Score', text(draft.minScore) ? `${text(draft.minScore)}+` : '85+'],
    ['Approval', draft.requireApproval === false ? 'Not required' : 'Required'],
  ]

  return (
    <div>
      <BodyText>{event.body}</BodyText>
      <KeyValueGrid border={border} rows={rows} />
      <TranscriptActionButtons actions={[
        { label: 'Create automation', onClick: () => onAction?.({ type: 'create_automation', draft: actionDraft }) },
        { label: 'Edit', onClick: () => onAction?.({ type: 'edit_automation_draft', draft: actionDraft, prompt: draftPrompt(actionDraft) }) },
        { label: 'Cancel', onClick: () => onAction?.({ type: 'cancel_automation_draft', body: `Cancelled automation draft: ${actionDraft.name}` }) },
      ]} />
    </div>
  )
}

function draftPrompt(draft: AutomationDraftAction) {
  const roles = draft.targetRoles.join(', ') || 'target roles'
  const locations = draft.targetLocations.join(', ') || 'target locations'
  return `请编辑这个自动化草稿：名称 ${draft.name}；触发 ${draft.triggerType}${draft.cron ? ` (${draft.cron})` : ''}；目标 ${locations} 的 ${roles}；最低分 ${draft.minScore}+；每日上限 ${draft.dailyCap}；${draft.requireApproval ? '提交前需要审批' : '不需要审批'}。`
}

function toAutomationDraftAction(draft: Record<string, unknown>): AutomationDraftAction {
  return {
    name: text(draft.name) ?? 'New automation',
    triggerType: text(draft.triggerType) ?? triggerTypeFromLabel(text(draft.trigger)),
    cron: text(draft.cron),
    timezone: text(draft.timezone) ?? 'Europe/Berlin',
    targetRoles: stringArray(draft.targetRoles),
    targetLocations: stringArray(draft.targetLocations),
    minScore: boundedNumber(draft.minScore, 85, 0, 100),
    dailyCap: boundedNumber(draft.dailyCap, 8, 1, 50),
    requireApproval: draft.requireApproval === false ? false : true,
    autoApply: draft.autoApply === true,
  }
}

function stringArray(value: unknown) {
  if (!Array.isArray(value)) return []
  return value
    .map(item => text(item))
    .filter((item): item is string => Boolean(item))
}

function boundedNumber(value: unknown, fallback: number, min: number, max: number) {
  const numeric = typeof value === 'number' ? value : Number.parseInt(text(value) ?? '', 10)
  if (!Number.isFinite(numeric)) return fallback
  return Math.min(max, Math.max(min, Math.round(numeric)))
}

function triggerTypeFromLabel(value: string | null) {
  if (!value) return 'manual'
  const lower = value.toLowerCase()
  if (lower.includes('weekday')) return 'weekdays'
  if (lower.includes('daily')) return 'daily'
  return 'manual'
}

function QualityGateBlock({ event, border }: { event: AgentTranscriptEvent; border: string }) {
  const gate = nestedRecord(event, 'qualityGate')
  const evidence = Array.isArray(gate.evidence) ? gate.evidence.map(text).filter((v): v is string => !!v).slice(0, 4) : []

  return (
    <div>
      <KeyValueGrid border={border} rows={[
        ['Gate', text(gate.gate) ?? text(event.title) ?? 'Quality gate'],
        ['Status', text(gate.status) ?? 'recorded'],
        ['Score', text(gate.score) ?? 'n/a'],
        ['Retry', gate.retryRecommended === true ? 'recommended' : 'not needed'],
      ]} />
      {evidence.length > 0 && <EvidenceList items={evidence} />}
      <BodyText>{event.body}</BodyText>
    </div>
  )
}

function JobResultsBlock({ event, border }: { event: AgentTranscriptEvent; border: string }) {
  const data = isRecord(event.data) ? event.data : {}
  const jobs = Array.isArray(data.jobs) ? data.jobs.filter(isRecord).slice(0, 6) : []

  if (jobs.length === 0) {
    return <BodyText>{event.body}</BodyText>
  }

  return (
    <div>
      <BodyText>{event.body || 'Top matches'}</BodyText>
      <div style={{ border: `1px solid ${border}`, borderRadius: 7, overflow: 'hidden', marginTop: 8 }}>
        {jobs.map((job, index) => (
          <div key={index} style={{
            display: 'grid',
            gridTemplateColumns: '1.3fr 1.5fr 52px',
            gap: 8,
            padding: '7px 9px',
            borderTop: index === 0 ? 'none' : `1px solid ${border}`,
            fontSize: 10,
            alignItems: 'center',
          }}>
            <span style={{ fontWeight: 650, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{text(job.company) ?? 'Company'}</span>
            <span style={{ color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{text(job.role) ?? text(job.title) ?? 'Role'}</span>
            <span style={{ color: 'var(--c-success)', fontWeight: 750, textAlign: 'right' }}>{text(job.score) ?? '-'}</span>
          </div>
        ))}
      </div>
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

function EvidenceList({ items }: { items: string[] }) {
  return (
    <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
      {items.map(item => (
        <div key={item} style={{ fontSize: 10, color: 'var(--text-muted)', lineHeight: 1.45 }}>
          - {item}
        </div>
      ))}
    </div>
  )
}

function listValue(primary: unknown, secondary: unknown) {
  const first = Array.isArray(primary) ? primary.map(text).filter(Boolean).join(', ') : text(primary)
  const second = Array.isArray(secondary) ? secondary.map(text).filter(Boolean).join(', ') : text(secondary)
  return [first, second].filter(Boolean).join(' · ') || 'Target to be confirmed'
}
