'use client'

import React from 'react'
import { useApi } from '@/lib/hooks'
import type { AgentSessionSummary, AgentSessionsResponse } from './session-view-model'
import { formatSessionClock, sessionHeaderSubtitle, sessionStatusLabel } from './session-view-model'
import { AgentSessionTools } from './AgentSessionTools'
import { SessionFocusPanel } from './SessionFocusPanel'
import { useI18n } from '@/lib/i18n'
import { AgentTaskHistoryMemoryConsent } from './AgentTaskHistoryMemoryConsent'
import { EmptyText } from './AgentSessionConsoleParts'

function statusColor(status: string): string {
  if (status === 'running') return 'var(--primary)'
  if (status === 'waiting_for_user' || status === 'paused') return '#d97706'
  if (status === 'completed') return 'var(--c-success)'
  if (status === 'failed') return 'var(--c-danger)'
  return 'var(--text-muted)'
}

export function AgentSessionConsole({
  selectedSessionId,
  onSelectSession,
  onRunSession,
  onNewChat,
  onDeletedSession,
  refreshVersion = 0,
  onSessionsLoaded,
  onAttentionChange,
}: {
  selectedSessionId: string | null
  onSelectSession: (id: string, goal?: string, subtitle?: string) => void
  onRunSession?: (id: string, policy: { autoApply: boolean; requireApproval: boolean }) => void
  onNewChat: () => void
  onDeletedSession: (id: string) => void
  refreshVersion?: number
  onSessionsLoaded?: (data: AgentSessionsResponse) => void
  onAttentionChange?: (sessionId: string, needsAttention: boolean) => void
}) {
  const { t } = useI18n()
  const { data, loading, error, refetch } = useApi<AgentSessionsResponse>('/api/agent/sessions')
  const [statusFilter, setStatusFilter] = React.useState('all')
  const [confirmingDeleteId, setConfirmingDeleteId] = React.useState<string | null>(null)
  const [deletingSessionId, setDeletingSessionId] = React.useState<string | null>(null)
  const sessions = data?.sessions ?? []
  const needsAttention = (session: AgentSessionSummary) => ['waiting_for_user', 'failed'].includes(session.status)
  const visibleSessions = statusFilter === 'all' ? sessions : sessions.filter(session => statusFilter === 'needs_attention' ? needsAttention(session) : session.status === statusFilter)
  const runningCount = sessions.filter(session => session.status === 'running').length
  const attentionCount = sessions.filter(needsAttention).length

  React.useEffect(() => { if (refreshVersion > 0) void refetch() }, [refreshVersion, refetch])

  React.useEffect(() => {
    if (data) onSessionsLoaded?.(data)
  }, [data, onSessionsLoaded])

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
      width: 272, flexShrink: 0, borderRight: '1px solid var(--border)',
      background: 'var(--bg-secondary)', display: 'flex', flexDirection: 'column', overflow: 'hidden',
    }}>
      <div style={{ padding: 14, borderBottom: '1px solid var(--border)' }}>
        <div style={{ display: 'grid', gap: 9 }}>
          <button
            onClick={onNewChat}
            style={{
              minHeight: 36,
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
            + {t('agent.newChat')}
          </button>
          <select
            aria-label={t('agent.filterSessions')}
            value={statusFilter}
            onChange={event => setStatusFilter(event.target.value)}
            style={{
              height: 38,
              borderRadius: 8,
              border: '1px solid var(--border)',
              background: 'var(--bg)',
              color: 'var(--text)',
              cursor: 'pointer',
              fontSize: 12,
              fontWeight: 650,
              fontFamily: 'inherit',
              padding: '0 10px',
            }}
          >
            <option value="all">{t('agent.all')}</option>
            <option value="needs_attention">{t('agent.needsAttention')}</option>
            <option value="running">{t('agent.run')}</option>
            <option value="waiting_for_user">{t('agent.ask')}</option>
            <option value="completed">{t('agent.done')}</option>
            <option value="failed">{t('agent.fail')}</option>
          </select>
        </div>
      </div>

      {(runningCount > 0 || attentionCount > 0) && <div style={{ padding: '10px 12px 0', display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {runningCount > 0 && <button type="button" aria-pressed={statusFilter === 'running'} onClick={() => setStatusFilter('running')} style={countStyle}>{runningCount} {t('agent.runningSessions')}</button>}
        {attentionCount > 0 && <button type="button" aria-pressed={statusFilter === 'needs_attention'} onClick={() => setStatusFilter('needs_attention')} style={{ ...countStyle, color: '#b45309' }}>{attentionCount} {t('agent.needsAttention')}</button>}
      </div>}

      <div style={{ flex: 1, overflowY: 'auto' }}>
        <div style={{ padding: '14px 12px 8px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0, fontWeight: 700 }}>
            {t('agent.recentSessions')}
          </div>
          <button onClick={() => { setStatusFilter('all'); void refetch() }} style={{ border: 'none', background: 'transparent', color: 'var(--primary)', fontSize: 10, cursor: 'pointer', fontFamily: 'inherit', padding: 0 }}>
            {t('agent.viewAll')}
          </button>
        </div>
        <AgentTaskHistoryMemoryConsent />

        <div style={{ padding: '0 10px 12px', display: 'flex', flexDirection: 'column', gap: 7 }}>
          {loading && <EmptyText>{t('agent.loadingSessions')}</EmptyText>}
          {error && <EmptyText tone="error" title={error}>{t('agent.sessionsUnavailable')}</EmptyText>}
          {!loading && !error && sessions.length === 0 && <EmptyText>{t('agent.noSessions')}</EmptyText>}
          {!loading && !error && sessions.length > 0 && visibleSessions.length === 0 && <EmptyText>{t('agent.noMatchingSessions')}</EmptyText>}
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
                  aria-pressed={selected}
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
                      <div title={session.goal} style={{ fontSize: 12, fontWeight: 650, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {session.goal}
                      </div>
                      <div style={{ fontSize: 10, color, flexShrink: 0, fontWeight: 650 }}>{sessionStatusLabel(session.status)}</div>
                    </div>
                    <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 4, lineHeight: 1.5 }}>
                      {formatSessionClock(session.updatedAt)}
                    </div>
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
                      {deleting ? '…' : `${t('agent.delete')}?`}
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmingDeleteId(null)}
                      disabled={deleting}
                      aria-label={t('agent.cancelDelete')}
                      style={{ width: 22, height: 22, border: 'none', borderRadius: 6, background: 'transparent', color: 'var(--text-muted)', cursor: deleting ? 'wait' : 'pointer', fontSize: 14, lineHeight: 1, fontFamily: 'inherit' }}
                    >
                      ×
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    aria-label={`${t('agent.delete')} ${session.goal}`}
                    title={t('agent.deleteConversation')}
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
        <SessionFocusPanel sessionId={selectedSessionId} onAttentionChange={onAttentionChange} />
        <AgentSessionTools
          onCreate={onNewChat}
          onSessionStarted={(sessionId, policy) => {
            void refetch()
            if (onRunSession) onRunSession(sessionId, policy)
            else onSelectSession(sessionId)
          }}
        />
      </div>
    </aside>
  )
}
const countStyle: React.CSSProperties = { border: '1px solid var(--border)', borderRadius: 7, padding: '5px 7px', background: 'var(--bg)', color: 'var(--primary)', cursor: 'pointer', font: 'inherit', fontSize: 11 }
