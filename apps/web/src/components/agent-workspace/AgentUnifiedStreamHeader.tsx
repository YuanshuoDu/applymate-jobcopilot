'use client'

import type { RunSummary } from './live-run-types'

export function AgentUnifiedStreamHeader({
  hideForNewChat,
  running,
  summary,
  approvalRequired,
  conversationTitle,
  conversationSubtitle,
}: {
  hideForNewChat: boolean
  running: boolean
  summary: RunSummary | null
  approvalRequired: boolean
  conversationTitle?: string | null
  conversationSubtitle?: string | null
}) {
  if (hideForNewChat) return null

  return (
    <div style={{ padding: '12px 18px', borderBottom: '0.5px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'var(--bg)', flexShrink: 0 }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 15, fontWeight: 750, color: 'var(--text)', lineHeight: 1.2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {conversationTitle ?? 'Agent workspace'}
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 3 }}>
          {conversationTitle ? conversationSubtitle ?? 'Chat session' : `Agent workspace${summary ? ` · ${summary.processed} scored · ${summary.applied} applied` : ''}`}
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 3 }}>
        {running && <span style={{ fontSize: 10, color: 'var(--primary)', fontWeight: 700 }}>Running</span>}
        {approvalRequired && <span style={{ fontSize: 10, color: '#d97706', fontWeight: 700 }}>Approval required</span>}
      </div>
    </div>
  )
}
