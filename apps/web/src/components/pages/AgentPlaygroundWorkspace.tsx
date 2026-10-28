'use client'

import React, { useCallback, useEffect, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react'
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
  const [conversationsCollapsed, setConversationsCollapsed] = useState(false)
  const [attention, setAttention] = useState<{ sessionId: string; needed: boolean } | null>(null)
  const onAttentionChange = useCallback((sessionId: string, needed: boolean) => setAttention({ sessionId, needed }), [])
  const needsAttention = attention?.sessionId === sessionProps.selectedSessionId && attention.needed
  const mobileTrigger = useRef<HTMLButtonElement>(null)
  const drawerClose = useRef<HTMLButtonElement>(null)
  const wasDrawerOpen = useRef(false)
  useEffect(() => {
    if (mobileSessionDrawerOpen) drawerClose.current?.focus()
    else if (wasDrawerOpen.current) mobileTrigger.current?.focus()
    wasDrawerOpen.current = mobileSessionDrawerOpen
  }, [mobileSessionDrawerOpen])

  return (
    <div className="agent-playground-workspace" style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: 'var(--bg-tertiary)' }}>
      <AgentPlaygroundResponsiveStyles />
      <TopBar title={t('agent.title')}>
        <button type="button" className="agent-desktop-conversations-toggle"
          aria-label={`${t(conversationsCollapsed ? 'agent.conversations' : 'agent.collapseConversations')}${needsAttention ? ` · ${t('agent.needsAttention')}` : ''}`}
          aria-expanded={!conversationsCollapsed} aria-controls="agent-session-drawer"
          onClick={() => setConversationsCollapsed(value => !value)}>
          {conversationsCollapsed ? <PanelLeftOpen size={17} aria-hidden="true" /> : <PanelLeftClose size={17} aria-hidden="true" />}
          {needsAttention && <span className="agent-conversations-attention" aria-hidden="true" />}
        </button>
        <button
          ref={mobileTrigger}
          className={`agent-session-drawer-trigger${mobileSessionDrawerOpen ? ' is-open' : ''}`}
          type="button"
          aria-label={`${t('agent.conversations')}${needsAttention ? ` · ${t('agent.needsAttention')}` : ''}`}
          aria-expanded={mobileSessionDrawerOpen}
          aria-controls="agent-session-drawer"
          onClick={() => setMobileSessionDrawerOpen(true)}
        >
          <PanelLeftOpen size={15} aria-hidden="true" />
          {needsAttention && <span className="agent-conversations-attention" aria-hidden="true" />}
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
        <div id="agent-session-drawer" className={`agent-session-drawer${mobileSessionDrawerOpen ? ' is-open' : ''}${conversationsCollapsed ? ' is-desktop-collapsed' : ''}`}>
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
              <button ref={drawerClose} className="agent-session-drawer-collapse" type="button" aria-label={t('agent.collapseConversations')} onClick={() => setMobileSessionDrawerOpen(false)}>
                <PanelLeftClose size={17} aria-hidden="true" />
              </button>
            </div>
          </div>
          <AgentSessionConsole {...sessionProps} onAttentionChange={onAttentionChange} />
        </div>
        {children}
      </div>
    </div>
  )
}
