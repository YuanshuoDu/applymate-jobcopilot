'use client'

import React, { useEffect, useRef, useState } from 'react'
import { Btn } from '@/components/ui'
import { useApi } from '@/lib/hooks'
import type { AgentSessionDetail, AgentTranscriptEvent, EventTone } from './session-view-model'
import { approvalResponseIds, eventChrome, eventSubtitle, sessionStatusLabel, shouldCollapseByDefault } from './session-view-model'
import { ReplayBanner } from './ReplayBanner'
import { TranscriptSpecialContent, type TranscriptAction } from './TranscriptSpecialBlocks'

interface DetailResponse {
  session: AgentSessionDetail
}

interface EventsResponse {
  events: AgentTranscriptEvent[]
}

function toneStyle(tone: EventTone): { border: string; bg: string; text: string } {
  const styles: Record<EventTone, { border: string; bg: string; text: string }> = {
    user: { border: 'rgba(79,70,229,0.35)', bg: 'rgba(79,70,229,0.07)', text: 'var(--primary)' },
    orchestrator: { border: 'rgba(217,119,6,0.30)', bg: 'rgba(217,119,6,0.06)', text: '#b45309' },
    subagent: { border: 'rgba(2,132,199,0.24)', bg: 'rgba(2,132,199,0.05)', text: '#0369a1' },
    approval: { border: 'rgba(245,158,11,0.46)', bg: 'rgba(245,158,11,0.08)', text: '#92400e' },
    success: { border: 'rgba(5,150,105,0.30)', bg: 'rgba(5,150,105,0.07)', text: 'var(--c-success)' },
    error: { border: 'rgba(220,38,38,0.30)', bg: 'rgba(220,38,38,0.06)', text: 'var(--c-danger)' },
    system: { border: 'var(--border)', bg: 'var(--bg-secondary)', text: 'var(--text-muted)' },
  }
  return styles[tone]
}

export function AgentSessionTranscript({ sessionId, onBackToLive }: {
  sessionId: string
  onBackToLive: () => void
}) {
  const { data: detailData, loading: detailLoading, refetch: refetchDetail } = useApi<DetailResponse>(`/api/agent/sessions/${sessionId}`)
  const { data: eventsData, loading: eventsLoading, refetch } = useApi<EventsResponse>(`/api/agent/sessions/${sessionId}/events`)
  const events = React.useMemo(() => eventsData?.events ?? [], [eventsData?.events])
  const session = detailData?.session
  const bottomRef = useRef<HTMLDivElement>(null)
  const [localEvents, setLocalEvents] = useState<AgentTranscriptEvent[]>([])
  const actedApprovalIds = React.useMemo(() => approvalResponseIds([...events, ...localEvents]), [events, localEvents])

  useEffect(() => { setLocalEvents([]) }, [sessionId])
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [events.length, localEvents.length])

  async function refreshTranscript() {
    await Promise.all([refetchDetail(), refetch()])
  }

  async function handleAction(action: TranscriptAction) {
    if (action.type === 'edit_automation_draft') {
      window.dispatchEvent(new CustomEvent('applymate:composer-prefill', { detail: action.prompt ?? '请编辑这个自动化草稿：' }))
      onBackToLive()
      return
    }
    if (action.type === 'cancel_automation_draft') {
      setLocalEvents(current => [...current, {
        id: `local-cancel-${Date.now()}`,
        taskId: null,
        type: 'automation_cancelled',
        speaker: 'You',
        title: 'Automation draft cancelled',
        body: action.body ?? 'Cancelled automation draft.',
        data: action,
        durationMs: null,
        createdAt: new Date().toISOString(),
      }])
      return
    }
    const res = await fetch(`/api/agent/sessions/${sessionId}/actions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(action),
    })
    if (!res.ok) throw new Error(await readableActionError(res))
    if (action.type === 'create_automation') {
      window.dispatchEvent(new Event('applymate:automations-changed'))
    }
    window.dispatchEvent(new Event('applymate:sessions-changed'))
    await refreshTranscript()
  }

  return (
    <section className="agent-transcript-pane" style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', background: 'var(--bg)' }}>
      <div style={{
        padding: '12px 16px',
        borderBottom: '1px solid var(--border)',
        background: 'var(--bg-secondary)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
      }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 13, fontWeight: 750, color: 'var(--text)' }}>
              {session?.goal ?? 'Session transcript'}
            </span>
            {session && (
              <span style={{ fontSize: 10, border: '1px solid var(--border)', borderRadius: 999, padding: '2px 7px', color: 'var(--text-muted)' }}>
                {sessionStatusLabel(session.status)}
              </span>
            )}
            {session?.qualityScore != null && (
              <span style={{ fontSize: 10, color: 'var(--c-success)', fontWeight: 650 }}>
                quality {Math.round(session.qualityScore)}%
              </span>
            )}
          </div>
          {session?.memorySummary && (
            <div style={{ marginTop: 4, fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {session.memorySummary}
            </div>
          )}
        </div>
        <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
          <Btn small variant="ghost" onClick={() => { void refreshTranscript() }}>Refresh</Btn>
          <Btn small variant="glass" onClick={onBackToLive}>Back to live</Btn>
        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: 12 }}>
        {session && (
          <ReplayBanner
            source={session.source}
            updatedAt={session.updatedAt}
            eventCount={events.length}
            onBackToLive={onBackToLive}
          />
        )}
        {(detailLoading || eventsLoading) && <EmptyState>Loading transcript...</EmptyState>}
        {!eventsLoading && events.length === 0 && <EmptyState>No transcript events yet.</EmptyState>}
        {[...events, ...localEvents].map(event => (
          <TranscriptBlock key={event.id} event={event} actedApprovalIds={actedApprovalIds} onAction={handleAction} />
        ))}
        <div ref={bottomRef} />
      </div>
    </section>
  )
}

async function readableActionError(res: Response) {
  const fallback = `Action failed (${res.status})`
  const raw = await res.text().catch(() => '')
  if (!raw.trim()) return fallback
  try {
    const parsed = JSON.parse(raw) as { error?: unknown; message?: unknown }
    const message = typeof parsed.error === 'string' ? parsed.error : parsed.message
    return typeof message === 'string' && message.trim() ? message : fallback
  } catch {
    return raw.length > 180 ? `${raw.slice(0, 177)}...` : raw
  }
}

function TranscriptBlock({ event, actedApprovalIds, onAction }: {
  event: AgentTranscriptEvent
  actedApprovalIds: Set<string>
  onAction: (action: TranscriptAction) => Promise<void> | void
}) {
  const chrome = eventChrome(event.type)
  const style = toneStyle(chrome.tone)
  const [expanded, setExpanded] = useState(!shouldCollapseByDefault(event.type))
  const title = event.title ?? chrome.label

  return (
    <article style={{
      border: `1px solid ${style.border}`,
      borderRadius: 8,
      background: style.bg,
      overflow: 'hidden',
    }}>
      <button
        onClick={() => shouldCollapseByDefault(event.type) && setExpanded(v => !v)}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          padding: '9px 12px',
          background: 'rgba(255,255,255,0.35)',
          border: 'none',
          borderBottom: expanded ? `1px solid ${style.border}` : 'none',
          cursor: shouldCollapseByDefault(event.type) ? 'pointer' : 'default',
          fontFamily: 'inherit',
          textAlign: 'left',
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 12, fontWeight: 750, color: style.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {event.speaker}
          </div>
          <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>
            {title}
          </div>
        </div>
        {shouldCollapseByDefault(event.type) && (
          <span style={{ fontSize: 10, color: style.text, fontWeight: 650 }}>{expanded ? 'Hide' : 'Show'}</span>
        )}
      </button>

      {expanded && (
        <div style={{ padding: '11px 13px 10px' }}>
          <TranscriptSpecialContent event={event} border={style.border} actedApprovalIds={actedApprovalIds} onAction={onAction} />
          <div style={{ marginTop: 10, fontSize: 10, color: 'var(--text-muted)', borderTop: `1px solid ${style.border}`, paddingTop: 7 }}>
            {eventSubtitle(event)}
          </div>
        </div>
      )}
    </article>
  )
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ margin: 'auto', fontSize: 12, color: 'var(--text-muted)', textAlign: 'center' }}>
      {children}
    </div>
  )
}
