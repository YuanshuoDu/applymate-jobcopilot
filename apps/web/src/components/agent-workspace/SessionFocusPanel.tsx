'use client'

import React from 'react'
import { useApi } from '@/lib/hooks'
import type { AgentSessionDetail } from './session-view-model'
import { confidenceLabel, sessionStatusLabel, taskStatusColor, taskStatusLabel } from './session-view-model'

interface DetailResponse {
  session: AgentSessionDetail
}

export function SessionFocusPanel({ sessionId }: { sessionId: string | null }) {
  if (!sessionId) {
    return (
      <Section title="Queued Tasks">
        <EmptyText>Select a session to inspect tasks, approvals, and quality.</EmptyText>
      </Section>
    )
  }

  return <SessionFocusPanelInner sessionId={sessionId} />
}

function SessionFocusPanelInner({ sessionId }: { sessionId: string }) {
  const { data, loading, error, refetch } = useApi<DetailResponse>(`/api/agent/sessions/${sessionId}`)
  const session = data?.session
  const tasks = session?.tasks ?? []
  const approvals = session?.approvals ?? []
  const queuedTasks = tasks.filter(task => ['queued', 'running', 'retrying', 'waiting_for_user'].includes(task.status))
  const visibleTasks = queuedTasks.length > 0 ? queuedTasks : tasks.slice(-4)
  const pendingApprovals = approvals.filter(approval => approval.status === 'pending')

  React.useEffect(() => {
    const refresh = () => { void refetch() }
    window.addEventListener('applymate:sessions-changed', refresh)
    return () => window.removeEventListener('applymate:sessions-changed', refresh)
  }, [refetch])

  return (
    <>
      <Section title="Queued Tasks">
        {loading && <EmptyText>Loading tasks...</EmptyText>}
        {error && <EmptyText>{error}</EmptyText>}
        {!loading && !error && visibleTasks.length === 0 && <EmptyText>No task records yet.</EmptyText>}
        {visibleTasks.map(task => <TaskRow key={task.id} task={task} />)}
      </Section>

      <Section title="Approvals">
        {!loading && pendingApprovals.length === 0 && <EmptyText>No pending approvals.</EmptyText>}
        {pendingApprovals.slice(0, 3).map(approval => (
          <div key={approval.id} style={rowStyle}>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={rowTitleStyle}>{approval.title}</div>
              <div style={rowMetaStyle}>{approval.type} · {sessionStatusLabel(approval.status)}</div>
            </div>
            <span style={{ ...badgeStyle, color: '#d97706' }}>waiting</span>
          </div>
        ))}
      </Section>

      <Section title="Session Quality">
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          <QualityMetric label="Quality" value={session?.qualityScore == null ? '--' : `${Math.round(session.qualityScore)}%`} />
          <QualityMetric label="Tasks" value={tasks.length.toString()} />
          <QualityMetric label="Approvals" value={approvals.length.toString()} warn={pendingApprovals.length > 0} />
          <QualityMetric label="Status" value={session ? sessionStatusLabel(session.status) : '--'} />
        </div>
      </Section>
    </>
  )
}

function TaskRow({ task }: { task: AgentSessionDetail['tasks'][number] }) {
  const color = taskStatusColor(task.status)
  return (
    <div style={rowStyle}>
      <span style={{ width: 7, height: 7, borderRadius: '50%', background: color, marginTop: 5, flexShrink: 0 }} />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={rowTitleStyle}>{task.role} · {task.taskType}</div>
        <div style={rowMetaStyle}>
          {taskStatusLabel(task.status)} · {confidenceLabel(task.confidence)}
        </div>
        {task.failureReason && (
          <div style={{ ...rowMetaStyle, color: 'var(--c-danger)', marginTop: 3 }}>
            {task.failureReason}
          </div>
        )}
      </div>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ padding: '0 10px 12px' }}>
      <div style={sectionTitleStyle}>{title}</div>
      <div style={{ border: '1px solid var(--border)', borderRadius: 8, background: 'var(--bg)', overflow: 'hidden' }}>
        {children}
      </div>
    </div>
  )
}

function QualityMetric({ label, value, warn = false }: { label: string; value: string; warn?: boolean }) {
  return (
    <div style={{ padding: '8px 9px', borderRight: '1px solid var(--border)', borderBottom: '1px solid var(--border)' }}>
      <div style={{ fontSize: 13, lineHeight: 1.1, fontWeight: 750, color: warn ? '#d97706' : 'var(--text)' }}>
        {value}
      </div>
      <div style={{ fontSize: 9, color: 'var(--text-muted)', marginTop: 3 }}>{label}</div>
    </div>
  )
}

function EmptyText({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ padding: '10px 11px', fontSize: 10, color: 'var(--text-muted)', lineHeight: 1.45 }}>
      {children}
    </div>
  )
}

const sectionTitleStyle: React.CSSProperties = {
  fontSize: 10,
  color: 'var(--text-muted)',
  textTransform: 'uppercase',
  letterSpacing: 0,
  fontWeight: 700,
  marginBottom: 6,
}

const rowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 8,
  padding: '9px 10px',
  borderTop: '1px solid var(--border)',
}

const rowTitleStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 650,
  color: 'var(--text)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

const rowMetaStyle: React.CSSProperties = {
  fontSize: 9,
  color: 'var(--text-muted)',
  marginTop: 3,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

const badgeStyle: React.CSSProperties = {
  fontSize: 9,
  fontWeight: 650,
  flexShrink: 0,
}
