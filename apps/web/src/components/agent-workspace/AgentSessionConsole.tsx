'use client'

import React from 'react'
import { useApi } from '@/lib/hooks'
import type { AgentSessionSummary } from './session-view-model'
import { sessionHeaderSubtitle, sessionStatusLabel, sessionSubtitle } from './session-view-model'
import { AgentTeamList } from './AgentTeamList'
import { HealthStrip } from './HealthStrip'
import { AutomationList } from './AutomationList'
import { SessionFocusPanel } from './SessionFocusPanel'

interface SessionsResponse {
  sessions: AgentSessionSummary[]
}

function statusColor(status: string): string {
  if (status === 'running') return 'var(--primary)'
  if (status === 'waiting_user') return '#d97706'
  if (status === 'completed') return 'var(--c-success)'
  if (status === 'failed') return 'var(--c-danger)'
  return 'var(--text-muted)'
}

export function AgentSessionConsole({
  selectedSessionId,
  onSelectSession,
  onNewChat,
  onDeletedSession,
  onAddAgent,
  refreshVersion = 0,
}: {
  selectedSessionId: string | null
  onSelectSession: (id: string, goal?: string, subtitle?: string) => void
  onNewChat: () => void
  onDeletedSession: (id: string) => void
  onAddAgent?: () => void
  refreshVersion?: number
}) {
  const { data, loading, error, refetch } = useApi<SessionsResponse>('/api/agent/sessions')
  const [statusFilter, setStatusFilter] = React.useState('all')
  const [confirmingDeleteId, setConfirmingDeleteId] = React.useState<string | null>(null)
  const [deletingSessionId, setDeletingSessionId] = React.useState<string | null>(null)
  const sessions = data?.sessions ?? []
  const visibleSessions = statusFilter === 'all' ? sessions : sessions.filter(session => session.status === statusFilter)
  const pendingApprovals = sessions.filter(s => s.status === 'waiting_user').length

  React.useEffect(() => {
    if (refreshVersion > 0) void refetch()
  }, [refreshVersion, refetch])

  React.useEffect(() => {
    const refresh = () => { void refetch() }
    window.addEventListener('applymate:sessions-changed', refresh)
    return () => window.removeEventListener('applymate:sessions-changed', refresh)
  }, [refetch])

  async function deleteSession(session: AgentSessionSummary) {
    setDeletingSessionId(session.id)
    try {
      const response = await fetch(`/api/agent/sessions/${session.id}`, { method: 'DELETE' })
      if (!response.ok) return
      onDeletedSession(session.id)
      setConfirmingDeleteId(null)
      await refetch()
    } finally {
      setDeletingSessionId(null)
    }
  }

  return (
    <aside className="agent-session-console" style={{
      width: 292,
      flexShrink: 0,
      borderRight: '1px solid var(--border)',
      background: 'var(--bg-secondary)',
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
    }}>
      <div style={{ padding: 14, borderBottom: '1px solid var(--border)' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 40px', gap: 9 }}>
          <button
            onClick={onNewChat}
            style={{
              height: 38,
              borderRadius: 8,
              border: '1px solid rgba(255,255,255,0.20)',
              background: 'linear-gradient(135deg, #4338CA 0%, #5B21B6 100%)',
              color: '#fff',
              cursor: 'pointer',
              fontSize: 12,
              fontWeight: 700,
              fontFamily: 'inherit',
              boxShadow: '0 8px 18px rgba(79,70,229,0.22)',
            }}
          >
            + New chat
          </button>
          <select
            aria-label="Filter sessions"
            value={statusFilter}
            onChange={event => setStatusFilter(event.target.value)}
            style={{
              height: 38,
              borderRadius: 8,
              border: '1px solid var(--border)',
              background: 'var(--bg)',
              color: 'var(--text)',
              cursor: 'pointer',
              fontSize: 10,
              fontWeight: 650,
              fontFamily: 'inherit',
              padding: '0 4px',
            }}
          >
            <option value="all">All</option>
            <option value="running">Run</option>
            <option value="waiting_user">Ask</option>
            <option value="completed">Done</option>
            <option value="failed">Fail</option>
          </select>
        </div>
      </div>

      <div style={{ padding: '10px 10px 8px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <Metric label="Queued Tasks" value={sessions.filter(s => s.status === 'running').length.toString()} />
        <Metric label="Approvals" value={pendingApprovals.toString()} alert={pendingApprovals > 0} />
      </div>

      <div style={{ flex: 1, overflowY: 'auto' }}>
        <div style={{ padding: '0 10px 8px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0, fontWeight: 700 }}>
            Recent Sessions
          </div>
          <button onClick={() => { setStatusFilter('all'); void refetch() }} style={{ border: 'none', background: 'transparent', color: 'var(--primary)', fontSize: 10, cursor: 'pointer', fontFamily: 'inherit', padding: 0 }}>
            View all
          </button>
        </div>

        <div style={{ padding: '0 10px 12px', display: 'flex', flexDirection: 'column', gap: 7 }}>
          {loading && <EmptyText>Loading sessions...</EmptyText>}
          {error && <EmptyText tone="error" title={error}>Agent sessions unavailable.</EmptyText>}
          {!loading && !error && sessions.length === 0 && <EmptyText>No sessions recorded yet.</EmptyText>}
          {!loading && !error && sessions.length > 0 && visibleSessions.length === 0 && <EmptyText>No sessions match this filter.</EmptyText>}
          {visibleSessions.map(session => {
            const selected = selectedSessionId === session.id
            const confirmingDelete = confirmingDeleteId === session.id
            const deleting = deletingSessionId === session.id
            const color = statusColor(session.status)
            return (
              <div
                key={session.id}
                style={{
                  width: '100%',
                  position: 'relative',
                }}
              >
                <button
                  onClick={() => onSelectSession(session.id, session.goal, sessionHeaderSubtitle(session))}
                  style={{
                    width: '100%', padding: 10, paddingRight: confirmingDelete ? 96 : 34, borderRadius: 8,
                    border: selected ? `1px solid ${color}` : '1px solid var(--border)',
                    background: selected ? 'var(--bg)' : 'transparent',
                    boxShadow: selected ? '0 3px 10px rgba(15,23,42,0.06)' : 'none',
                    cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                  <span style={{ width: 7, height: 7, borderRadius: '50%', background: color, marginTop: 5, flexShrink: 0 }} />
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                      <div style={{ fontSize: 12, fontWeight: 650, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {session.goal}
                      </div>
                      <div style={{ fontSize: 10, color, flexShrink: 0, fontWeight: 650 }}>{sessionStatusLabel(session.status)}</div>
                    </div>
                    <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 4, lineHeight: 1.5 }}>
                      {sessionSubtitle(session)}
                    </div>
                    {session.memorySummary && (
                      <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 5, lineHeight: 1.45, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                        {session.memorySummary}
                      </div>
                    )}
                  </div>
                  </div>
                </button>
                {confirmingDelete ? (
                  <div style={{ position: 'absolute', top: 8, right: 7, display: 'flex', alignItems: 'center', gap: 3 }}>
                    <button
                      type="button"
                      onClick={() => { void deleteSession(session) }}
                      disabled={deleting}
                      style={{ height: 22, border: 'none', borderRadius: 6, background: 'rgba(220,38,38,0.10)', color: 'var(--c-danger)', cursor: deleting ? 'wait' : 'pointer', fontSize: 9, fontWeight: 750, fontFamily: 'inherit', padding: '0 6px' }}
                    >
                      {deleting ? '…' : 'Delete?'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmingDeleteId(null)}
                      disabled={deleting}
                      aria-label="Cancel delete"
                      style={{ width: 22, height: 22, border: 'none', borderRadius: 6, background: 'transparent', color: 'var(--text-muted)', cursor: deleting ? 'wait' : 'pointer', fontSize: 14, lineHeight: 1, fontFamily: 'inherit' }}
                    >
                      ×
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    aria-label={`Delete ${session.goal}`}
                    title="Delete conversation"
                    onClick={() => setConfirmingDeleteId(session.id)}
                    style={{ position: 'absolute', top: 8, right: 7, width: 22, height: 22, border: 'none', borderRadius: 6, background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 15, lineHeight: 1, fontFamily: 'inherit' }}
                  >
                    ×
                  </button>
                )}
              </div>
            )
          })}
        </div>
        <SessionFocusPanel sessionId={selectedSessionId} />
        <AgentTeamList onAddAgent={onAddAgent} />
        <AutomationList
          onCreate={onNewChat}
          onSessionStarted={sessionId => {
            void refetch()
            onSelectSession(sessionId)
          }}
        />
        <HealthStrip />
      </div>
    </aside>
  )
}

function Metric({ label, value, alert = false }: { label: string; value: string; alert?: boolean }) {
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '8px 9px', background: 'var(--bg)' }}>
      <div style={{ fontSize: 16, lineHeight: 1, fontWeight: 750, color: alert ? '#d97706' : 'var(--text)' }}>{value}</div>
      <div style={{ fontSize: 9, color: 'var(--text-muted)', marginTop: 4 }}>{label}</div>
    </div>
  )
}

function EmptyText({ children, tone = 'muted', title }: { children: React.ReactNode; tone?: 'muted' | 'error'; title?: string }) {
  return (
    <div title={title} style={{ padding: 12, fontSize: 11, color: tone === 'error' ? 'var(--c-danger)' : 'var(--text-muted)', lineHeight: 1.5 }}>
      {children}
    </div>
  )
}
