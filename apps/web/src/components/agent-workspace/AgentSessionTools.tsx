'use client'

import React from 'react'
import { useI18n } from '@/lib/i18n'
import { AutomationList } from './AutomationList'

interface AgentSessionToolsProps {
  onCreate: () => void
  onSessionStarted: (sessionId: string, policy: { autoApply: boolean; requireApproval: boolean }) => void
}

export function AgentSessionTools({ onCreate, onSessionStarted }: AgentSessionToolsProps) {
  const { t } = useI18n()
  return (
    <div style={{ borderTop: '1px solid var(--border)', padding: '6px 0' }}>
      <ToolSection title={t('agent.automations')}>
        <AutomationList onCreate={onCreate} onSessionStarted={onSessionStarted} />
      </ToolSection>
    </div>
  )
}

function ToolSection({ title, children }: { title: string; children: React.ReactNode }) {
  // Native disclosure keeps child state mounted when the section is collapsed.
  return <details className="agent-session-tool-section">
    <summary style={{ padding: '10px 14px', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 12, fontWeight: 650 }}>{title}</summary>
    {children}
  </details>
}
