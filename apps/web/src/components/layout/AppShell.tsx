'use client'

import React, { useState, useEffect } from 'react'
import { useSession } from 'next-auth/react'
import { Sidebar } from './Sidebar'
import { ToastProvider } from '@/components/ui'
import type { Page } from '@/lib/types'
import { DashboardPage }     from '@/components/pages/DashboardPage'
import { JobsPage }          from '@/components/pages/JobsPage'
import { ResumePage }        from '@/components/pages/ResumePage'
import { GmailPage }         from '@/components/pages/GmailPage'
import { AgentPlaygroundPage } from '@/components/pages/AgentPlaygroundPage'
import { AgentAnimationPage } from '@/components/pages/AgentAnimationPage'
import { ExtensionPage }     from '@/components/pages/ExtensionPage'
import { SettingsPage }      from '@/components/pages/SettingsPage'

const MOB_NAV: { id: Page; icon: string; label: string; badge?: boolean }[] = [
  { id: 'dashboard', icon: '▦', label: 'Home'    },
  { id: 'jobs',      icon: '◈', label: 'Jobs',    badge: true },
  { id: 'gmail',     icon: '✉', label: 'Gmail',   badge: true },
  { id: 'agent',     icon: '◉', label: 'Agent'    },
  { id: 'settings',  icon: '⚙', label: 'Settings' },
]

const PAGES: Record<Page, React.ComponentType> = {
  dashboard: DashboardPage,
  jobs:      JobsPage,
  resume:    ResumePage,
  gmail:     GmailPage,
  agent:     AgentPlaygroundPage,
  animation: AgentAnimationPage,
  extension: ExtensionPage,
  settings:  SettingsPage,
}

export function AppShell() {
  const [page, setPage]         = useState<Page>('dashboard')
  const [timedOut, setTimedOut] = useState(false)
  const { data: session, status } = useSession()
  const PageComp = PAGES[page]

  // Safety timeout: if session is still loading after 10s, redirect to login
  useEffect(() => {
    if (status !== 'loading') return
    const t = setTimeout(() => setTimedOut(true), 10000)
    return () => clearTimeout(t)
  }, [status])

  // Redirect to login if unauthenticated or timed out
  if (status === 'unauthenticated' || timedOut) {
    window.location.href = '/login'
    return null
  }

  // Show loading skeleton while session loads
  if (status === 'loading') {
    return (
      <div style={{ display:'flex', height:'100vh', alignItems:'center', justifyContent:'center', background:'var(--bg-tertiary)' }}>
        <div style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:12 }}>
          <div style={{ width:32, height:32, borderRadius:8, background:'#185FA5', display:'flex', alignItems:'center', justifyContent:'center', color:'#fff', fontSize:15, fontWeight:700 }}>A</div>
          <div style={{ fontSize:12, color:'var(--text-muted)' }}>Loading…</div>
        </div>
      </div>
    )
  }

  return (
    <ToastProvider>
      <div style={{ display: 'flex', height: '100vh', overflow: 'hidden' }}>
        <div id="desktop-sidebar">
          <Sidebar active={page} onNav={setPage} session={session} />
        </div>
        <div id="main-content" style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <PageComp />
        </div>
      </div>

      {/* Mobile bottom bar */}
      <div id="mobile-bottom-bar">
        {MOB_NAV.map(item => (
          <button key={item.id}
            onClick={() => setPage(item.id)}
            style={{
              display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3,
              flex: 1, padding: '6px 0', border: 'none', background: 'transparent', cursor: 'pointer',
              color: page === item.id ? 'var(--primary)' : 'var(--text-muted)',
              fontSize: 10, fontFamily: 'inherit', position: 'relative',
            }}>
            <span style={{ fontSize: 18 }}>{item.icon}</span>
            <span>{item.label}</span>
            {item.badge && item.id === 'gmail' && (
              <span style={{ position: 'absolute', top: 4, right: 18, width: 6, height: 6, borderRadius: '50%', background: '#A32D2D' }} />
            )}
          </button>
        ))}
      </div>
    </ToastProvider>
  )
}
