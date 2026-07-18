'use client'

import React, { useEffect, useRef, useState } from 'react'
import { Btn } from '@/components/ui'
import { useApi } from '@/lib/hooks'
import type { AgentSessionDetail, AgentTranscriptEvent } from './session-view-model'
import { approvalResponseIds, EVENT_TONE_COLOR, eventChrome, eventSubtitle, sessionStatusLabel, shouldCollapseByDefault } from './session-view-model'
import { ReplayBanner } from './ReplayBanner'
import { TranscriptSpecialContent, type TranscriptAction } from './TranscriptSpecialBlocks'

interface DetailResponse {
  session: AgentSessionDetail
}

interface EventsResponse {
  events: AgentTranscriptEvent[]
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
    <section className="agent-transcript-pane" style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', background: 'var(--bg)' }}>
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

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain', padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: 12 }}>
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
  const accent = EVENT_TONE_COLOR[chrome.tone]
  const [expanded, setExpanded] = useState(!shouldCollapseByDefault(event.type))
  const title = event.title ?? chrome.label
  const collapsible = shouldCollapseByDefault(event.type)
  const header = <><span style={{ fontSize: 13, fontWeight: 750, color: accent }}>{event.speaker}</span><span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{title}</span></>

  return (
    <article style={{
      flexShrink: 0,
      border: '1px solid var(--border)', borderLeft: `4px solid ${accent}`,
      borderRadius: 10, background: 'var(--bg)', padding: '15px 18px', boxShadow: 'var(--shadow-sm)',
    }}>
      {collapsible ? <button onClick={() => setExpanded(v => !v)} style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', border: 0, padding: 0, color: 'var(--text)', background: 'transparent', cursor: 'pointer', font: 'inherit', textAlign: 'left' }}><span style={{ color: 'var(--text-muted)', fontSize: 12 }}>{expanded ? '▼' : '▶'}</span>{header}</button> : <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>{header}</div>}

      {expanded && (
        <div style={{ marginTop: 12 }}>
          <TranscriptSpecialContent event={event} border="var(--border)" actedApprovalIds={actedApprovalIds} onAction={onAction} />
          <div style={{ marginTop: 12, fontSize: 10, color: 'var(--text-muted)', borderTop: '1px solid var(--border)', paddingTop: 9 }}>
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
