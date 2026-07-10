'use client'

import React, { useState, useEffect, useRef } from 'react'
import { useSession, signIn, signOut } from 'next-auth/react'
import { useRouter } from 'next/navigation'
import { Bell } from 'lucide-react'
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
import { AgentHistoryPage }   from '@/components/pages/AgentHistoryPage'
import { ExtensionPage }      from '@/components/pages/ExtensionPage'
import { SettingsPage }       from '@/components/pages/SettingsPage'
import { ObservabilityPage } from '@/components/pages/ObservabilityPage'

interface NotificationItem {
  id: string
  type: string
  title: string
  body: string | null
  read: boolean
  jobId: string | null
  createdAt: string
}

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
  'agent-history': AgentHistoryPage,
  extension: ExtensionPage,
  settings:  SettingsPage,
  observability: ObservabilityPage,
}

export function getNotificationTargetPage(type: string): Page | null {
  return type.startsWith('apply_') ? 'jobs' : null
}

function getInitialPage(): Page {
  if (typeof window === 'undefined') return 'dashboard'
  const params = new URLSearchParams(window.location.search)
  const pageParam = params.get('page')
  if (isPage(pageParam)) return pageParam
  return 'dashboard'
}

function isPage(value: string | null): value is Page {
  return Boolean(value && value in PAGES)
}

function writePageToUrl(nextPage: Page, mode: 'push' | 'replace' = 'push') {
  if (typeof window === 'undefined') return
  const url = new URL(window.location.href)
  if (nextPage === 'dashboard') {
    url.searchParams.delete('page')
  } else {
    url.searchParams.set('page', nextPage)
  }
  const nextUrl = `${url.pathname}${url.search}${url.hash}`
  if (nextUrl === `${window.location.pathname}${window.location.search}${window.location.hash}`) return
  window.history[mode === 'replace' ? 'replaceState' : 'pushState']({}, '', nextUrl)
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
  const [notifications, setNotifications] = useState<NotificationItem[]>([])
  const [unreadCount, setUnreadCount] = useState(0)
  const [notificationsOpen, setNotificationsOpen] = useState(false)

  function navigatePage(nextPage: Page, mode: 'push' | 'replace' = 'push') {
    setPage(nextPage)
    writePageToUrl(nextPage, mode)
  }

  useEffect(() => {
    if (status !== 'authenticated') { setCheckingOnboard(false); return }
    fetch('/api/me')
      .then(r => r.json())
      .then((u) => { setNeedsOnboarding(!u.onboardedAt); setCheckingOnboard(false) })
      .catch(() => setCheckingOnboard(false))
  }, [status])

  useEffect(() => {
    writePageToUrl(page, 'replace')

    function handlePopState() {
      const params = new URLSearchParams(window.location.search)
      const pageParam = params.get('page')
      setPage(isPage(pageParam) ? pageParam : 'dashboard')
    }

    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
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
    if (status !== 'authenticated') return

    let cancelled = false
    const loadNotifications = () => {
      fetch('/api/notifications')
        .then(r => r.ok ? r.json() : Promise.reject(new Error('notifications fetch failed')))
        .then((data: { notifications?: NotificationItem[]; unreadCount?: number }) => {
          if (cancelled) return
          setNotifications(data.notifications ?? [])
          setUnreadCount(data.unreadCount ?? 0)
        })
        .catch(() => {
          if (!cancelled) {
            setNotifications([])
            setUnreadCount(0)
          }
        })
    }

    loadNotifications()
    const interval = window.setInterval(loadNotifications, 60_000)
    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [status])

  async function markNotificationRead(id?: string) {
    await fetch('/api/notifications/mark-read', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(id ? { id } : {}),
    }).catch(() => null)

    setNotifications(prev =>
      prev.map(n => (!id || n.id === id) ? { ...n, read: true } : n)
    )
    setUnreadCount(prev => id
      ? Math.max(prev - (notifications.find(n => n.id === id && !n.read) ? 1 : 0), 0)
      : 0
    )
  }

  async function openNotification(n: NotificationItem) {
    await markNotificationRead(n.id)
    setNotificationsOpen(false)
    const target = getNotificationTargetPage(n.type)
    if (target) navigatePage(target)
  }

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
      <NavContext.Provider value={{ navigate: navigatePage }}>
        {/* Onboarding sits inside ToastProvider so useToast works */}
        {needsOnboarding ? (
          <OnboardingFlow onComplete={() => setNeedsOnboarding(false)} />
        ) : (
          <>
            <div style={{ display: 'flex', height: '100vh', overflow: 'hidden' }}>
              <div id="desktop-sidebar">
                <Sidebar active={page} onNav={navigatePage} session={session} jobCount={jobCount} />
              </div>
              <div id="main-content" style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                <div style={{ position: 'fixed', top: 10, right: 20, zIndex: 80 }}>
                  <button
                    type="button"
                    aria-label="Notifications"
                    onClick={() => setNotificationsOpen(v => !v)}
                    style={{
                      width: 36, height: 36, borderRadius: 8,
                      border: '1px solid var(--border-glass)',
                      background: 'var(--surface-raised)',
                      color: 'var(--text)',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      cursor: 'pointer',
                      boxShadow: '0 6px 20px rgba(15,23,42,0.12)',
                      position: 'relative',
                    }}
                  >
                    <Bell size={18} aria-hidden="true" />
                    {unreadCount > 0 && (
                      <span
                        aria-label={`${unreadCount} unread notifications`}
                        style={{
                          position: 'absolute', top: -5, right: -5,
                          minWidth: 18, height: 18, padding: '0 5px',
                          borderRadius: 999,
                          background: 'var(--c-danger)',
                          color: '#fff',
                          fontSize: 10,
                          fontWeight: 700,
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          border: '2px solid var(--bg)',
                          lineHeight: 1,
                        }}
                      >
                        {unreadCount > 9 ? '9+' : unreadCount}
                      </span>
                    )}
                  </button>
                  {notificationsOpen && (
                    <div
                      style={{
                        position: 'absolute', top: 44, right: 0,
                        width: 320, maxWidth: 'calc(100vw - 32px)',
                        background: 'var(--bg)',
                        border: '1px solid var(--border)',
                        borderRadius: 8,
                        boxShadow: '0 14px 40px rgba(15,23,42,0.18)',
                        overflow: 'hidden',
                      }}
                    >
                      <div style={{
                        padding: '10px 12px',
                        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                        borderBottom: '1px solid var(--border)',
                      }}>
                        <span style={{ fontSize: 12, fontWeight: 700 }}>Notifications</span>
                        {unreadCount > 0 && (
                          <button
                            type="button"
                            onClick={() => markNotificationRead()}
                            style={{
                              border: 'none', background: 'transparent',
                              color: 'var(--primary)', fontSize: 11,
                              cursor: 'pointer', padding: 0,
                            }}
                          >
                            Mark read
                          </button>
                        )}
                      </div>
                      <div style={{ maxHeight: 320, overflowY: 'auto' }}>
                        {notifications.length === 0 ? (
                          <div style={{ padding: 16, fontSize: 12, color: 'var(--text-muted)' }}>No notifications</div>
                        ) : notifications.slice(0, 5).map(n => (
                          <button
                            key={n.id}
                            type="button"
                            onClick={() => openNotification(n)}
                            style={{
                              width: '100%',
                              border: 'none',
                              borderBottom: '1px solid var(--border)',
                              background: n.read ? 'var(--bg)' : 'var(--bg-secondary)',
                              padding: '10px 12px',
                              display: 'flex', alignItems: 'flex-start', gap: 8,
                              textAlign: 'left',
                              cursor: 'pointer',
                            }}
                          >
                            <span
                              aria-hidden="true"
                              style={{
                                width: 7, height: 7, borderRadius: '50%',
                                background: n.read ? 'var(--text-muted)' : 'var(--c-success)',
                                marginTop: 5, flexShrink: 0,
                              }}
                            />
                            <span style={{ minWidth: 0, flex: 1 }}>
                              <span style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {n.title}
                              </span>
                              {n.body && (
                                <span style={{ display: 'block', fontSize: 11, color: 'var(--text-muted)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                  {n.body}
                                </span>
                              )}
                            </span>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
                <PageComp />
              </div>
            </div>

            {/* Mobile bottom bar */}
            <div id="mobile-bottom-bar">
              {MOB_NAV.map(item => (
                <button key={item.id}
                  aria-label={item.label}
                  onClick={() => navigatePage(item.id)}
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
