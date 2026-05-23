'use client'

import React, { useState, useEffect, useRef } from 'react'
import { useSession, signIn, signOut } from 'next-auth/react'
import { useRouter } from 'next/navigation'
import { Sidebar } from './Sidebar'
import { ToastProvider } from '@/components/ui'
import type { DashboardData, JobStatus, Page } from '@/lib/types'
import { NavContext } from '@/lib/nav-context'
import { OnboardingFlow } from '@/components/onboarding/OnboardingFlow'
import { DashboardPage }      from '@/components/pages/DashboardPage'
import { JobsPage }           from '@/components/pages/JobsPage'
import { SearchPage }         from '@/components/pages/SearchPage'
import { ResumePage }         from '@/components/pages/ResumePage'
import { GmailPage }          from '@/components/pages/GmailPage'
import { AgentPlaygroundPage } from '@/components/pages/AgentPlaygroundPage'
import { ExtensionPage }      from '@/components/pages/ExtensionPage'
import { SettingsPage }       from '@/components/pages/SettingsPage'
import { ApplyHistoryPage }  from '@/components/pages/ApplyHistoryPage'

const MOB_NAV: { id: Page; label: string }[] = [
  { id: 'dashboard', label: 'Home'     },
  { id: 'jobs',      label: 'Jobs'     },
  { id: 'gmail',     label: 'Gmail'    },
  { id: 'agent',     label: 'Agent'    },
  { id: 'settings',  label: 'More'     },
]

const MOB_ICONS: Record<string, React.ReactNode> = {
  dashboard: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>,
  jobs:      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2"/></svg>,
  gmail:     <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>,
  agent:     <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83"/></svg>,
  settings:  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>,
}

const PAGES: Record<Page, React.ComponentType> = {
  dashboard: DashboardPage,
  jobs:      JobsPage,
  search:    SearchPage,
  resume:    ResumePage,
  gmail:     GmailPage,
  agent:     AgentPlaygroundPage,
  extension: ExtensionPage,
  settings:  SettingsPage,
  'apply-history': ApplyHistoryPage,
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

  const [checkingOnboard, setCheckingOnboard] = useState(true)
  const [needsOnboarding, setNeedsOnboarding] = useState(false)

  useEffect(() => {
    if (status !== 'authenticated') { setCheckingOnboard(false); return }
    fetch('/api/me')
      .then(r => r.json())
      .then((u) => { setNeedsOnboarding(!u.onboardedAt); setCheckingOnboard(false) })
      .catch(() => setCheckingOnboard(false))
  }, [status])

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
      document.querySelector('meta[name="applymate:user"]')?.remove()
    }
  }, [status, session])

  // Listen for extension messages (login / logout)
  useEffect(() => {
    function handleMessage(e: MessageEvent) {
      if (e.origin !== window.location.origin) return

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
  if (status === 'loading' || checkingOnboard) {
    return (
      <div style={{
        display: 'flex', height: '100vh', alignItems: 'center', justifyContent: 'center',
        background: 'var(--bg-mesh)', backgroundAttachment: 'fixed',
      }}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16 }}>
          <div style={{
            width: 52, height: 52, borderRadius: 16,
            background: 'linear-gradient(135deg, #4F46E5 0%, #7C3AED 100%)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: '#fff', fontSize: 22, fontWeight: 700,
            boxShadow: '0 8px 32px rgba(79,70,229,0.40), inset 0 1px 0 rgba(255,255,255,0.25)',
          }}>A</div>
          <div style={{
            width: 28, height: 28, borderRadius: '50%',
            border: '2.5px solid rgba(79,70,229,0.15)',
            borderTopColor: '#4F46E5',
            animation: 'spin 0.7s linear infinite',
          }} />
          <div style={{ fontSize: 12, color: 'var(--text-muted)', letterSpacing: '0.02em' }}>Loading…</div>
        </div>
      </div>
    )
  }

  return (
    <>
      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
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
        {/* Onboarding sits inside ToastProvider so useToast works */}
        {needsOnboarding ? (
          <OnboardingFlow onComplete={() => setNeedsOnboarding(false)} />
        ) : (
          <>
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
                  aria-label={item.label}
                  onClick={() => setPage(item.id)}
                  style={{
                    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3,
                    flex: 1, padding: '6px 0', border: 'none', background: 'transparent', cursor: 'pointer',
                    color: page === item.id ? 'var(--primary)' : 'var(--text-muted)',
                    fontSize: 10, fontFamily: 'inherit', position: 'relative',
                  }}>
                  <span aria-hidden="true" style={{ fontSize: 18 }}>{MOB_ICONS[item.id]}</span>
                  <span>{item.label}</span>
                </button>
              ))}
            </div>
          </>
        )}
      </NavContext.Provider>
    </ToastProvider>
    </>
  )
}
