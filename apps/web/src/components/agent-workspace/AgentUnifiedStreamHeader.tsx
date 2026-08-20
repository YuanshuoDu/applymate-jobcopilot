'use client'

import type { RunSummary } from './live-run-types'
import { useI18n } from '@/lib/i18n'

export function AgentUnifiedStreamHeader({
  hideForNewChat,
  running,
  summary,
  approvalRequired,
  autonomousMode,
  conversationTitle,
  conversationSubtitle,
}: {
  hideForNewChat: boolean
  running: boolean
  summary: RunSummary | null
  approvalRequired: boolean
  autonomousMode: boolean
  conversationTitle?: string | null
  conversationSubtitle?: string | null
}) {
  const { t } = useI18n()
  if (hideForNewChat) return null
  const hasDistinctSubtitle = Boolean(conversationSubtitle && conversationSubtitle !== conversationTitle)

  return (
    <div style={{ padding: '12px 18px', borderBottom: '0.5px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'var(--bg)', flexShrink: 0 }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 15, fontWeight: 750, color: 'var(--text)', lineHeight: 1.2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {conversationTitle ?? t('agent.workspace')}
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 3 }}>
          {conversationTitle
            ? (hasDistinctSubtitle ? conversationSubtitle : t('agent.chatSession'))
            : (summary ? `${summary.processed} scored · ${summary.queued} dispatched · ${summary.applied} confirmed` : t('agent.planReviewApply'))}
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 3 }}>
        {running && <span style={{ fontSize: 10, color: 'var(--primary)', fontWeight: 700 }}>{t('agent.running')}</span>}
        <span style={{ fontSize: 10, color: autonomousMode ? 'var(--c-success)' : 'var(--text-muted)', fontWeight: 700 }}>
          {autonomousMode ? t('agent.autopilot') : t('agent.reviewMode')}
        </span>
        {approvalRequired && <span style={{ fontSize: 10, color: '#d97706', fontWeight: 700 }}>{t('agent.approvalRequired')}</span>}
      </div>
    </div>
  )
}
