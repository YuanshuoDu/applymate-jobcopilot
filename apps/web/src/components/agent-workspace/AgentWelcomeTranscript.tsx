'use client'

import React from 'react'

export function AgentWelcomeTranscript({
  savedCount,
  pendingCount,
  autonomousMode,
  onSelectPrompt,
}: {
  savedCount: number
  pendingCount: number
  autonomousMode: boolean
  onSelectPrompt: (prompt: string) => void
}) {
  const now = new Date()

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <WelcomeBlock
        speaker="Orchestrator"
        title="Ready"
        accent="var(--primary)"
        time={now}
      >
        <div style={bodyStyle}>
          I&apos;m ready to take over this job search. You currently have {savedCount} saved role{savedCount === 1 ? '' : 's'}
          {pendingCount > 0 ? ` and ${pendingCount} waiting for review` : ''}. Sensitive actions will always ask for confirmation first.
        </div>
      </WelcomeBlock>

      <WelcomeBlock
        speaker="Analyst"
        title="Thinking summary"
        accent="#64748b"
        time={now}
      >
        <details style={{ fontSize: 12, color: 'var(--text)', lineHeight: 1.65 }}>
          <summary style={{ cursor: 'pointer', color: 'var(--text-muted)', fontWeight: 650 }}>
            View the current reasoning summary
          </summary>
          <div style={{ marginTop: 8, display: 'grid', gap: 5 }}>
            <span>Approval policy: {autonomousMode ? 'autonomous decisions are enabled, but external submissions still pass a safety gate' : 'interactive confirmation comes first'}</span>
            <span>Available context: saved roles, resume, Agent settings, and automation rules.</span>
            <span>Suggested next step: create an automation, review pending roles, or explain a recent score.</span>
          </div>
        </details>
      </WelcomeBlock>

      <WelcomeBlock
        speaker="Orchestrator"
        title="Options"
        accent="#7c3aed"
        time={now}
      >
        <div style={{ display: 'grid', gap: 7 }}>
          {STARTER_OPTIONS.map(option => (
            <button
              key={option.label}
              type="button"
              onClick={() => onSelectPrompt(option.prompt)}
              style={optionButtonStyle}
            >
              <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text)' }}>{option.label}</span>
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{option.description}</span>
            </button>
          ))}
        </div>
      </WelcomeBlock>
    </div>
  )
}

function WelcomeBlock({
  speaker,
  title,
  accent,
  time,
  children,
}: {
  speaker: string
  title: string
  accent: string
  time: Date
  children: React.ReactNode
}) {
  return (
    <article style={{
      border: '1px solid var(--border)',
      borderLeft: `3px solid ${accent}`,
      borderRadius: 8,
      background: 'var(--bg)',
      padding: '10px 12px',
      boxShadow: '0 1px 4px rgba(15,23,42,0.04)',
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 7, marginBottom: 7 }}>
        <div style={{ fontSize: 12, fontWeight: 760, color: accent }}>{speaker}</div>
        <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>{title}</div>
      </div>
      {children}
      <div style={{
        marginTop: 8,
        paddingTop: 7,
        borderTop: '1px solid var(--border)',
        fontSize: 10,
        color: 'var(--text-muted)',
      }}>
        {time.toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit' })}
      </div>
    </article>
  )
}

const STARTER_OPTIONS = [
  {
    label: 'Create automation',
    description: 'Search and score roles on weekdays, then follow your approval rules.',
    prompt: 'Create a weekday 09:00 automation to find software engineering roles in Berlin and send matches above 85% for approval.',
  },
  {
    label: 'Review pending',
    description: 'Review pending roles and recommend approve, skip, or follow-up actions.',
    prompt: 'Review the pending roles and recommend an action based on match, risk, and application readiness.',
  },
  {
    label: 'Explain score',
    description: 'Explain why the latest high-match role is worth applying for and identify gaps.',
    prompt: 'Explain the latest high-match role, including scoring evidence and resume gaps.',
  },
]

const bodyStyle: React.CSSProperties = {
  fontSize: 12,
  color: 'var(--text)',
  lineHeight: 1.7,
}

const optionButtonStyle: React.CSSProperties = {
  width: '100%',
  minHeight: 42,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 12,
  border: '1px solid var(--border)',
  borderRadius: 7,
  background: 'var(--bg-secondary)',
  padding: '8px 10px',
  cursor: 'pointer',
  textAlign: 'left',
  fontFamily: 'inherit',
}
