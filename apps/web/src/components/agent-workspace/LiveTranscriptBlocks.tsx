'use client'

import React from 'react'
import { SmartMessage } from './SmartMessage'
import { TranscriptSpecialContent, type TranscriptAction } from './TranscriptSpecialBlocks'
import type { AgentTranscriptEvent, EventTone } from './session-view-model'
import { eventChrome, eventSubtitle, shouldCollapseByDefault } from './session-view-model'

export { SmartMessage } from './SmartMessage'

interface QuestionOptionLike {
  label: string
  value: string
  action?: { field: string; value: unknown }
}

interface LogEntryLike {
  type: string
  message: string
  time: Date
  question?: string
  options?: QuestionOptionLike[]
  answered?: boolean
}

export function LiveLogTranscriptBlock({ entry, speaker, accent }: {
  entry: LogEntryLike
  speaker: string
  accent: string
}) {
  return (
    <article style={transcriptArticleStyle(accent)}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 7, marginBottom: 7 }}>
        <div style={{ fontSize: 12, fontWeight: 760, color: accent }}>{speaker}</div>
        <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>
          {entry.type === 'user_message' ? 'Message' : entry.type === 'error' ? 'Error' : 'Thinking summary'}
        </div>
      </div>
      <SmartMessage text={entry.message} color="var(--text)" />
      <TranscriptTime time={entry.time} />
    </article>
  )
}

export function LiveQuestionTranscriptBlock({ entry, speaker, title, accent, onSelect }: {
  entry: LogEntryLike
  speaker: string
  title: string
  accent: string
  onSelect: (option: QuestionOptionLike) => Promise<void> | void
}) {
  const [pendingValue, setPendingValue] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  async function selectOption(option: QuestionOptionLike) {
    if (pendingValue || entry.answered) return
    setPendingValue(option.value)
    setError(null)
    try {
      await onSelect(option)
    } catch (err) {
      setError((err as Error).message || 'Failed to record decision.')
    } finally {
      setPendingValue(null)
    }
  }

  return (
    <article style={transcriptArticleStyle(accent)}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 7, marginBottom: 7 }}>
        <div style={{ fontSize: 12, fontWeight: 760, color: accent }}>{speaker}</div>
        <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>{title}</div>
      </div>
      <div style={{ fontSize: 12, color: 'var(--text)', lineHeight: 1.7, marginBottom: entry.answered ? 0 : 9 }}>
        {entry.question ?? entry.message}
      </div>
      {!entry.answered && entry.options && entry.options.length > 0 && (
        <div style={{ display: 'grid', gap: 6 }}>
          {entry.options.map((option, index) => (
            <button
              key={`${option.value}-${index}`}
              type="button"
              onClick={() => { void selectOption(option) }}
              disabled={Boolean(pendingValue)}
              style={{
                minHeight: 34,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 10,
                border: `1px solid ${accent}`,
                borderRadius: 7,
                background: 'var(--bg-secondary)',
                color: pendingValue ? 'var(--text-muted)' : 'var(--text)',
                cursor: pendingValue ? 'wait' : 'pointer',
                opacity: pendingValue && pendingValue !== option.value ? 0.62 : 1,
                padding: '7px 10px',
                textAlign: 'left',
                fontFamily: 'inherit',
                fontSize: 11,
                fontWeight: 650,
              }}
            >
              <span>{pendingValue === option.value ? 'Working...' : option.label}</span>
              {option.action && <span style={{ color: 'var(--text-muted)', fontSize: 10 }}>will update setting</span>}
            </button>
          ))}
        </div>
      )}
      {error && (
        <div style={{ marginTop: 8, fontSize: 11, color: 'var(--c-danger)', fontWeight: 650 }}>
          {error}
        </div>
      )}
      {entry.answered && (
        <div style={{ marginTop: 8, fontSize: 11, color: 'var(--c-success)', fontWeight: 650 }}>
          Decision recorded.
        </div>
      )}
      <TranscriptTime time={entry.time} />
    </article>
  )
}

export function LiveTranscriptBlock({ event, actedApprovalIds, revealThinkingVersion, onAction }: {
  event: AgentTranscriptEvent
  actedApprovalIds?: Set<string>
  revealThinkingVersion?: number
  onAction: (action: TranscriptAction) => Promise<void> | void
}) {
  const chrome = eventChrome(event.type)
  const style = liveToneStyle(chrome.tone)
  const [expanded, setExpanded] = React.useState(!shouldCollapseByDefault(event.type))

  React.useEffect(() => {
    if (shouldRevealThinkingBlock(event.type, revealThinkingVersion)) setExpanded(true)
  }, [event.type, revealThinkingVersion])

  return (
    <article data-agent-event-type={event.type} style={{ border: `1px solid ${style.border}`, borderRadius: 8, background: style.bg, overflow: 'hidden', margin: '6px 0' }}>
      <button
        onClick={() => shouldCollapseByDefault(event.type) && setExpanded(value => !value)}
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
          <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>{event.title ?? chrome.label}</div>
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

export function shouldRevealThinkingBlock(eventType: string, revealThinkingVersion?: number): boolean {
  return eventType === 'thinking_summary' && Boolean(revealThinkingVersion)
}

function TranscriptTime({ time }: { time: Date }) {
  return (
    <div style={{
      marginTop: 8,
      paddingTop: 7,
      borderTop: '1px solid var(--border)',
      fontSize: 10,
      color: 'var(--text-muted)',
    }}>
      {time.toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit' })}
    </div>
  )
}

function transcriptArticleStyle(accent: string): React.CSSProperties {
  return {
    border: '1px solid var(--border)',
    borderLeft: `3px solid ${accent}`,
    borderRadius: 8,
    background: 'var(--bg)',
    margin: '6px 0',
    padding: '10px 12px',
    boxShadow: '0 1px 4px rgba(15,23,42,0.04)',
  }
}

function liveToneStyle(tone: EventTone) {
  if (tone === 'user') return { border: 'rgba(99,102,241,0.32)', bg: 'rgba(99,102,241,0.05)', text: 'var(--primary)' }
  if (tone === 'orchestrator') return { border: 'rgba(79,70,229,0.35)', bg: 'rgba(79,70,229,0.05)', text: 'var(--primary)' }
  if (tone === 'subagent') return { border: 'rgba(14,165,233,0.32)', bg: 'rgba(14,165,233,0.05)', text: '#0369a1' }
  if (tone === 'approval') return { border: 'rgba(245,158,11,0.46)', bg: 'rgba(245,158,11,0.08)', text: '#92400e' }
  if (tone === 'success') return { border: 'rgba(34,197,94,0.35)', bg: 'rgba(34,197,94,0.06)', text: 'var(--c-success)' }
  if (tone === 'error') return { border: 'rgba(239,68,68,0.38)', bg: 'rgba(239,68,68,0.07)', text: 'var(--c-danger)' }
  return { border: 'var(--border)', bg: 'var(--bg)', text: 'var(--text)' }
}
