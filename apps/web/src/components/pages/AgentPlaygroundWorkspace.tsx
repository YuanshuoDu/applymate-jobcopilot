'use client'

import React, { type Dispatch, type ReactNode, type SetStateAction } from 'react'
import { Home, PanelLeftClose, PanelLeftOpen } from 'lucide-react'
import { TopBar } from '@/components/layout/TopBar'
import { AddAgentModal } from '@/components/agent-workspace/AddAgentModal'
import { AgentSessionConsole } from '@/components/agent-workspace/AgentSessionConsole'
import { useNav } from '@/lib/nav-context'
import { useI18n } from '@/lib/i18n'
import { AgentPlaygroundResponsiveStyles } from './AgentPlaygroundResponsiveStyles'

type SessionConsoleProps = React.ComponentProps<typeof AgentSessionConsole>

interface AgentPlaygroundWorkspaceProps {
  showAddModal: boolean
  setShowAddModal: Dispatch<SetStateAction<boolean>>
  mobileSessionDrawerOpen: boolean
  setMobileSessionDrawerOpen: Dispatch<SetStateAction<boolean>>
  sessionProps: SessionConsoleProps
  children: ReactNode
}

export function AgentPlaygroundWorkspace({
  showAddModal, setShowAddModal, mobileSessionDrawerOpen, setMobileSessionDrawerOpen,
  sessionProps, children,
}: AgentPlaygroundWorkspaceProps) {
  const { navigate } = useNav()
  const { t } = useI18n()

  return (
    <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: 'var(--bg-tertiary)' }}>
      <AgentPlaygroundResponsiveStyles />
      <TopBar title={t('agent.title')}>
        <button
          className="agent-session-drawer-trigger"
          type="button"
          aria-expanded={mobileSessionDrawerOpen}
          aria-controls="agent-session-drawer"
          onClick={() => setMobileSessionDrawerOpen(true)}
        >
          <PanelLeftOpen size={15} aria-hidden="true" />
          {t('agent.conversations')}
        </button>
      </TopBar>

      {showAddModal && (
        <AddAgentModal
          onClose={() => setShowAddModal(false)}
          onCreated={() => window.dispatchEvent(new Event('applymate:agents-changed'))}
        />
      )}

      <div className="agent-workspace-layout" style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', overflow: 'hidden' }}>
        <button
          className={`agent-session-drawer-scrim${mobileSessionDrawerOpen ? ' is-open' : ''}`}
          type="button"
          aria-label={t('agent.closeConversations')}
          tabIndex={mobileSessionDrawerOpen ? 0 : -1}
          onClick={() => setMobileSessionDrawerOpen(false)}
        />
        <div id="agent-session-drawer" className={`agent-session-drawer${mobileSessionDrawerOpen ? ' is-open' : ''}`}>
          <div className="agent-session-drawer-header">
            <span>{t('agent.conversations')}</span>
            <div className="agent-session-drawer-actions">
              <button className="agent-session-drawer-home" type="button" aria-label={t('agent.backHome')} onClick={() => {
                setMobileSessionDrawerOpen(false)
                navigate('dashboard')
              }}>
                <Home size={15} aria-hidden="true" />
                {t('agent.backHome')}
              </button>
              <button className="agent-session-drawer-collapse" type="button" aria-label={t('agent.collapseConversations')} onClick={() => setMobileSessionDrawerOpen(false)}>
                <PanelLeftClose size={17} aria-hidden="true" />
              </button>
            </div>
          </div>
          <AgentSessionConsole {...sessionProps} />
        </div>
        {children}
      </div>
    </div>
  )
}
