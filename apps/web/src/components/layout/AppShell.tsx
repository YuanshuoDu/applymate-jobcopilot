'use client'

import React, { useState, useEffect, useRef } from 'react'
import { useSession, signIn, signOut } from 'next-auth/react'
import { useRouter } from 'next/navigation'
import { Sidebar } from './Sidebar'
import { ToastProvider } from '@/components/ui'
import type { DashboardData, JobStatus, Page } from '@/lib/types'
import { NavContext } from '@/lib/nav-context'
import { DashboardPage }      from '@/components/pages/DashboardPage'
import { JobsPage }           from '@/components/pages/JobsPage'
import { SearchPage }         from '@/components/pages/SearchPage'
import { ResumePage }         from '@/components/pages/ResumePage'
import { GmailPage }          from '@/components/pages/GmailPage'
import { AgentPlaygroundPage } from '@/components/pages/AgentPlaygroundPage'
import { AgentAnimationPage }  from '@/components/pages/AgentAnimationPage'
import { ExtensionPage }      from '@/components/pages/ExtensionPage'
import { SettingsPage }       from '@/components/pages/SettingsPage'

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
  search:    SearchPage,
  resume:    ResumePage,
  gmail:     GmailPage,
  agent:     AgentPlaygroundPage,
  animation: AgentAnimationPage,
  extension: ExtensionPage,
  settings:  SettingsPage,
}

function getInitialPage(): Page {
  if (typeof window === 'undefined') return 'dashboard'
  const params = new URLSearchParams(window.location.search)
  const pageParam = params.get('page')
  if (pageParam && pageParam in PAGES) return pageParam as Page
  return 'dashboard'
}

export function AppShell() {
  const [page, setPage]         = useState<Page>(getInitialPage)
  const [timedOut, setTimedOut] = useState(false)
  const [jobCount, setJobCount] = useState(0)
  const { data: session, status } = useSession()
  const router = useRouter()
  const loginSyncInProgress = useRef<boolean>(false)
  const PageComp = PAGES[page]

  // Clean up ?page= query param after reading it
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if (params.has('page')) {
      const url = new URL(window.location.href)
      url.searchParams.delete('page')
      window.history.replaceState({}, '', url)
    }
  }, [])

  // Safety timeout
  useEffect(() => {
    if (status !== 'loading') return
    const t = setTimeout(() => setTimedOut(true), 10000)
    return () => clearTimeout(t)
  }, [status])

  // ── Auth sync: Dashboard ↔ Extension ────────────────────

  // Expose login state to extension via <meta> tag
  useEffect(() => {
    if (status === 'authenticated' && session?.user?.email) {
      let meta = document.querySelector('meta[name="applymate:user"]') as HTMLMetaElement | null
      if (!meta) {
        meta = document.createElement('meta')
        meta.name = 'applymate:user'
        document.head.appendChild(meta)
      }
      meta.content = session.user.email
    } else if (status === 'unauthenticated') {
      // Remove meta tag so extension knows dashboard logged out
      document.querySelector('meta[name="applymate:user"]')?.remove()
    }
  }, [status, session])

  // Listen for extension messages (login / logout)
  useEffect(() => {
    function handleMessage(e: MessageEvent) {
      if (e.origin !== window.location.origin) return

      // Extension logged in → auto-login dashboard
      if (e.data?.type === 'APPLYMATE_TOKEN' && e.data?.token) {
        if (status === 'authenticated') return // already logged in
        if (loginSyncInProgress.current) return
        loginSyncInProgress.current = true

        try {
          signIn('credentials', { token: e.data.token as string, redirect: false })
            .then(() => { loginSyncInProgress.current = false })
            .catch(() => { loginSyncInProgress.current = false })
        } catch {
          loginSyncInProgress.current = false
        }
      }

      // Extension logged out → auto-logout dashboard
      if (e.data?.type === 'APPLYMATE_LOGOUT') {
        if (status !== 'authenticated') return
        signOut({ redirect: false })
      }
    }
    window.addEventListener('message', handleMessage)
    return () => window.removeEventListener('message', handleMessage)
  }, [status])

  // Notify extension when dashboard logs out
  useEffect(() => {
    if (status === 'unauthenticated') {
      window.postMessage({ type: 'DASHBOARD_LOGOUT' }, window.location.origin)
    }
  }, [status])

  useEffect(() => {
    if (status !== 'authenticated') return

    let cancelled = false

    fetch('/api/dashboard')
      .then(r => r.json() as Promise<DashboardData>)
      .then(data => {
        if (cancelled) return

        const pipeline = (data.pipeline ?? {}) as Partial<Record<JobStatus, number>>
        const nextCount =
          (pipeline.saved ?? 0) +
          (pipeline.applied ?? 0) +
          (pipeline.review ?? 0) +
          (pipeline.interview ?? 0)

        setJobCount(nextCount)
      })
      .catch(() => {
        if (!cancelled) setJobCount(0)
      })

    return () => {
      cancelled = true
    }
  }, [status])

  useEffect(() => {
    if (status === 'unauthenticated' || timedOut) {
      router.push('/login?callbackUrl=/')
    }
  }, [router, status, timedOut])

  // Redirect to login if unauthenticated or timed out
  if (status === 'unauthenticated' || timedOut) {
    return null
  }

  // Show loading skeleton
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
    <>
      <style>{`
        @keyframes ai-flash {
          0%   { background-color: rgba(234,179,8,0.35); }
          100% { background-color: transparent; }
        }
        .ai-flash-highlight {
          animation: ai-flash 2s ease-out;
          border-radius: 4px;
          padding: 2px 4px;
          margin: -2px -4px;
        }
      `}</style>
      <ToastProvider>
      <NavContext.Provider value={{ navigate: setPage }}>
        <div style={{ display: 'flex', height: '100vh', overflow: 'hidden' }}>
          <div id="desktop-sidebar">
            <Sidebar active={page} onNav={setPage} session={session} jobCount={jobCount} />
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
      </NavContext.Provider>
    </ToastProvider>
    </>
  )
}
