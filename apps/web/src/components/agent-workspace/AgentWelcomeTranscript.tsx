'use client'

import React from 'react'
import { useI18n } from '@/lib/i18n'

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
  const { t } = useI18n()
  const now = new Date()

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <WelcomeBlock
        speaker="Orchestrator"
        title={t('agent.ready')}
        accent="var(--primary)"
        time={now}
      >
        <div style={bodyStyle}>
          {t('agent.welcomeReadyPrefix')} {savedCount} {t(savedCount === 1 ? 'agent.savedRole' : 'agent.savedRoles')}
          {pendingCount > 0 ? `, ${pendingCount} ${t('agent.waitingForReview')}` : ''}. {t('agent.sensitiveConfirmation')}
        </div>
      </WelcomeBlock>

      <WelcomeBlock
        speaker="Analyst"
        title={t('agent.thinkingSummary')}
        accent="#64748b"
        time={now}
      >
        <details style={{ fontSize: 12, color: 'var(--text)', lineHeight: 1.65 }}>
          <summary style={{ cursor: 'pointer', color: 'var(--text-muted)', fontWeight: 650 }}>
            {t('agent.viewReasoning')}
          </summary>
          <div style={{ marginTop: 8, display: 'grid', gap: 5 }}>
            <span>{t('agent.approvalPolicy')}: {autonomousMode ? t('agent.autonomousSafety') : t('agent.interactiveConfirmation')}</span>
            <span>{t('agent.availableContext')}</span>
            <span>{t('agent.suggestedNext')}</span>
          </div>
        </details>
      </WelcomeBlock>

      <WelcomeBlock
        speaker="Orchestrator"
        title={t('agent.options')}
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
              <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text)' }}>{t(option.label)}</span>
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{t(option.description)}</span>
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
    label: 'agent.createAutomationOption',
    description: 'agent.createAutomationDescription',
    prompt: 'Create a weekday 09:00 automation to find software engineering roles in Berlin and send matches above 85% for approval.',
  },
  {
    label: 'agent.reviewPending',
    description: 'agent.reviewPendingDescription',
    prompt: 'Review the pending roles and recommend an action based on match, risk, and application readiness.',
  },
  {
    label: 'agent.explainScore',
    description: 'agent.explainScoreDescription',
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
