'use client'

import React from 'react'

export interface AgentAutomation {
  id: string
  name: string
  enabled: boolean
  triggerType: string
  cron: string | null
  timezone: string
  targetRoles: string[]
  targetLocations: string[]
  minScore: number
  dailyCap: number
  requireApproval: boolean
  autoApply: boolean
  createdBy: string
  lastRunAt: string | null
  nextRunAt: string | null
}

function automationMeta(row: AgentAutomation) {
  if (!row.enabled) return 'Paused'
  if (row.nextRunAt) {
    return `Next run: ${new Date(row.nextRunAt).toLocaleString('en', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`
  }
  if (row.requireApproval) return 'Approval required'
  return `${row.dailyCap} applications/day`
}

function automationSubMeta(row: AgentAutomation) {
  if (row.lastRunAt) {
    return `Last run: ${new Date(row.lastRunAt).toLocaleString('en', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`
  }
  if (row.requireApproval) return 'Approval required before submit'
  return row.autoApply ? 'Auto-apply enabled' : 'Review queue only'
}

function automationIcon(row: AgentAutomation) {
  if (row.autoApply) return '▣'
  if (row.triggerType === 'weekdays' || row.triggerType === 'daily') return '⌁'
  return '✦'
}

export function AutomationRow({
  row,
  index,
  pending,
  onToggle,
  onEdit,
  onRun,
}: {
  row: AgentAutomation
  index: number
  pending: boolean
  onToggle: (row: AgentAutomation) => void
  onEdit: (row: AgentAutomation) => void
  onRun: (row: AgentAutomation) => void
}) {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 9,
      padding: '9px 10px',
      borderTop: index === 0 ? 'none' : '1px solid var(--border)',
    }}>
      <button
        onClick={() => onToggle(row)}
        disabled={pending}
        aria-label={`${row.enabled ? 'Disable' : 'Enable'} ${row.name}`}
        style={{
          width: 29,
          height: 16,
          borderRadius: 999,
          border: '1px solid var(--border)',
          background: row.enabled ? 'var(--c-success)' : 'var(--bg-tertiary)',
          cursor: pending ? 'wait' : 'pointer',
          opacity: pending ? 0.65 : 1,
          padding: 1,
          display: 'flex',
          justifyContent: row.enabled ? 'flex-end' : 'flex-start',
          flexShrink: 0,
        }}
      >
        <span style={{ width: 12, height: 12, borderRadius: '50%', background: '#fff', display: 'block' }} />
      </button>
      <div style={{ width: 20, textAlign: 'center', color: row.enabled ? 'var(--primary)' : 'var(--text-muted)', fontSize: 12 }}>
        {automationIcon(row)}
      </div>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontSize: 11, fontWeight: 650, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.name}</div>
        <div style={{ fontSize: 9, color: 'var(--text-muted)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{automationMeta(row)}</div>
        <div style={{ fontSize: 9, color: 'var(--text-muted)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{automationSubMeta(row)}</div>
      </div>
      <button
        onClick={() => onEdit(row)}
        disabled={pending}
        title={`Edit ${row.name}`}
        aria-label={`Edit ${row.name}`}
        style={iconButtonStyle(pending ? 'wait' : 'pointer', 'var(--text-muted)', pending)}
      >
        ✎
      </button>
      <button
        onClick={() => onRun(row)}
        disabled={pending || !row.enabled}
        title={row.enabled ? `Run ${row.name}` : `${row.name} is paused`}
        aria-label={`Run ${row.name}`}
        style={iconButtonStyle(pending ? 'wait' : row.enabled ? 'pointer' : 'not-allowed', row.enabled ? 'var(--primary)' : 'var(--text-muted)', pending || !row.enabled)}
      >
        ▶
      </button>
    </div>
  )
}

function iconButtonStyle(cursor: string, color: string, dimmed: boolean): React.CSSProperties {
  return {
    width: 24,
    height: 24,
    borderRadius: 7,
    border: '1px solid var(--border)',
    background: 'var(--bg-secondary)',
    color,
    cursor,
    opacity: dimmed ? 0.65 : 1,
    flexShrink: 0,
    fontSize: 10,
    fontFamily: 'inherit',
  }
}
