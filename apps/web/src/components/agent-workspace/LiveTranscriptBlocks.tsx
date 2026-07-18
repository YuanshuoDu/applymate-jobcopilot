'use client'

import React from 'react'
import { SmartMessage } from './SmartMessage'
import { TranscriptSpecialContent, type TranscriptAction } from './TranscriptSpecialBlocks'
import type { AgentTranscriptEvent, EventTone } from './session-view-model'
import { EVENT_TONE_COLOR, eventChrome, eventSubtitle, shouldCollapseByDefault } from './session-view-model'

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

export function LiveLogTranscriptBlock({ entry, speaker, accent, title }: {
  entry: LogEntryLike
  speaker: string
  accent: string
  title?: string
}) {
  return (
    <article style={transcriptArticleStyle(accent)}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 12 }}>
        <div style={{ fontSize: 13, fontWeight: 750, color: accent }}>{speaker}</div>
        <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          {title ?? (entry.type === 'user_message' ? 'Message' : entry.type === 'error' ? 'Error' : 'Thinking summary')}
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
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 12 }}>
        <div style={{ fontSize: 13, fontWeight: 750, color: accent }}>{speaker}</div>
        <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{title}</div>
      </div>
      <div style={{ fontSize: 12, color: 'var(--text)', lineHeight: 1.7, marginBottom: entry.answered ? 0 : 12 }}>
        {entry.question ?? entry.message}
      </div>
      {!entry.answered && entry.options && entry.options.length > 0 && (
        <div style={{ display: 'grid', gap: 8 }}>
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
                borderRadius: 8,
                background: 'var(--bg-secondary)',
                color: pendingValue ? 'var(--text-muted)' : 'var(--text)',
                cursor: pendingValue ? 'wait' : 'pointer',
                opacity: pendingValue && pendingValue !== option.value ? 0.62 : 1,
                padding: '10px 12px',
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
    <article data-agent-event-type={event.type} style={transcriptArticleStyle(style.text)}>
      <button
        onClick={() => shouldCollapseByDefault(event.type) && setExpanded(value => !value)}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'flex-start',
          gap: 10,
          padding: 0,
          background: 'transparent',
          border: 'none',
          cursor: shouldCollapseByDefault(event.type) ? 'pointer' : 'default',
          fontFamily: 'inherit',
          textAlign: 'left',
        }}
      >
        {shouldCollapseByDefault(event.type) && <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>{expanded ? '▼' : '▶'}</span>}
        <div style={{ fontSize: 13, fontWeight: 750, color: style.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{event.speaker}</div>
        <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{event.title ?? chrome.label}</div>
      </button>
      {expanded && (
        <div style={{ marginTop: 12 }}>
          <TranscriptSpecialContent event={event} border={style.border} actedApprovalIds={actedApprovalIds} onAction={onAction} />
          <div style={{ marginTop: 12, fontSize: 10, color: 'var(--text-muted)', borderTop: '1px solid var(--border)', paddingTop: 9 }}>
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
      marginTop: 12,
      paddingTop: 9,
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
    flexShrink: 0,
    border: '1px solid var(--border)',
    borderLeft: `4px solid ${accent}`,
    borderRadius: 10,
    background: 'var(--bg)',
    margin: 0,
    padding: '15px 18px',
    boxShadow: 'var(--shadow-sm)',
  }
}

function liveToneStyle(tone: EventTone) {
  const text = EVENT_TONE_COLOR[tone]
  return { border: `${text}55`, text }
}
