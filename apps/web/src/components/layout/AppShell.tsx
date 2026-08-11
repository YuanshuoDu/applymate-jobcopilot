'use client'

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import dynamic from 'next/dynamic'
import { useSession, signOut } from 'next-auth/react'
import { useRouter } from 'next/navigation'
import { Bell } from 'lucide-react'
import { Sidebar } from './Sidebar'
import type { Page } from '@/lib/types'
import { NavContext } from '@/lib/nav-context'
import { useI18n } from '@/lib/i18n'
import { OnboardingFlow } from '@/components/onboarding/OnboardingFlow'
import { clearCachedApiResponses } from '@/lib/api-cache'
import { pageFromSearch } from './page-routing'

function PageLoading() {
  return <div style={{ flex: 1, display: 'grid', placeItems: 'center', color: 'var(--text-muted)', fontSize: 13 }}>Loading page…</div>
}

const DashboardPage = dynamic(() => import('@/components/pages/DashboardPage').then(module => module.DashboardPage), { loading: PageLoading })
const JobsPage = dynamic(() => import('@/components/pages/JobsPage').then(module => module.JobsPage), { loading: PageLoading })
const SearchPage = dynamic(() => import('@/components/pages/SearchPage').then(module => module.SearchPage), { loading: PageLoading })
const ResumePage = dynamic(() => import('@/components/pages/ResumePage').then(module => module.ResumePage), { loading: PageLoading })
const GmailPage = dynamic(() => import('@/components/pages/GmailPage').then(module => module.GmailPage), { loading: PageLoading })
const JobRecommendationsPage = dynamic(() => import('@/components/pages/JobRecommendationsPage').then(module => module.JobRecommendationsPage), { loading: PageLoading })
const AgentPlaygroundPage = dynamic(() => import('@/components/pages/AgentPlaygroundPage').then(module => module.AgentPlaygroundPage), { loading: PageLoading })
const AgentHistoryPage = dynamic(() => import('@/components/pages/AgentHistoryPage').then(module => module.AgentHistoryPage), { loading: PageLoading })
const SettingsPage = dynamic(() => import('@/components/pages/SettingsPage').then(module => module.SettingsPage), { loading: PageLoading })
const ObservabilityPage = dynamic(() => import('@/components/pages/ObservabilityPage').then(module => module.ObservabilityPage), { loading: PageLoading })

const PAGE_PRELOADERS: Record<Page, () => Promise<unknown>> = {
  dashboard: () => import('@/components/pages/DashboardPage'),
  jobs: () => import('@/components/pages/JobsPage'),
  search: () => import('@/components/pages/SearchPage'),
  resume: () => import('@/components/pages/ResumePage'),
  gmail: () => import('@/components/pages/GmailPage'),
  'gmail-recommendations': () => import('@/components/pages/JobRecommendationsPage'),
  agent: () => import('@/components/pages/AgentPlaygroundPage'),
  'agent-history': () => import('@/components/pages/AgentHistoryPage'),
  settings: () => import('@/components/pages/SettingsPage'),
  observability: () => import('@/components/pages/ObservabilityPage'),
}

interface NotificationItem {
  id: string
  type: string
  title: string
  body: string | null
  read: boolean
  jobId: string | null
  createdAt: string
}

type MobileNavItem = { id: Page | 'more'; label: string }
type MobileMoreItem = { id: Extract<Page, 'gmail' | 'settings'> | 'signout'; label: string }

export function getMobileNavItems(): MobileNavItem[] {
  return [
    { id: 'jobs',      label: 'Jobs'   },
    { id: 'search',    label: 'Search' },
    { id: 'dashboard', label: 'Home'   },
    { id: 'agent',     label: 'Agent'  },
    { id: 'more',      label: 'More'   },
  ]
}

export function getMobileMoreItems(signOutLabel = 'Sign out'): MobileMoreItem[] {
  return [
    { id: 'gmail',    label: 'Gmail'    },
    { id: 'settings', label: 'Settings' },
    { id: 'signout',  label: signOutLabel },
  ]
}

const MOB_ICONS: Record<string, React.ReactNode> = {
  dashboard: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>,
  jobs:      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2"/></svg>,
  search:    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></svg>,
  gmail:     <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>,
  agent:     <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83"/></svg>,
  more:      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></svg>,
  settings:  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>,
}

const PAGES: Record<Page, React.ComponentType> = {
  dashboard: DashboardPage,
  jobs:      JobsPage,
  search:    SearchPage,
  resume:    ResumePage,
  gmail:     GmailPage,
  'gmail-recommendations': JobRecommendationsPage,
  agent:     AgentPlaygroundPage,
  'agent-history': AgentHistoryPage,
  settings:  SettingsPage,
  observability: ObservabilityPage,
}

export function getNotificationTargetPage(type: string): Page | null {
  if (type === 'gmail_recommendations') return 'gmail-recommendations'
  if (type.startsWith('gmail_')) return 'gmail'
  return type.startsWith('apply_') ? 'jobs' : null
}

function NotificationControl({ unreadCount, onToggle }: {
  unreadCount: number
  onToggle: () => void
}) {
  return <button type="button" aria-label="Notifications" onClick={onToggle} style={{
    width: 26, height: 26, padding: 0, border: 'none', borderRadius: 6, background: 'transparent', color: 'var(--text-muted)',
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', position: 'relative', flexShrink: 0,
  }}>
    <Bell size={16} aria-hidden="true" />
    {unreadCount > 0 && <span aria-label={`${unreadCount} unread notifications`} style={{
      position: 'absolute', top: -3, right: -3, minWidth: 13, height: 13, padding: '0 3px', borderRadius: 999,
      background: 'var(--c-danger)', color: '#fff', fontSize: 8, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1.5px solid var(--bg)', lineHeight: 1,
    }}>{unreadCount > 9 ? '9+' : unreadCount}</span>}
  </button>
}

function NotificationPanel({ notifications, unreadCount, onMarkRead, onOpenNotification }: {
  notifications: NotificationItem[]
  unreadCount: number
  onMarkRead: () => void
  onOpenNotification: (notification: NotificationItem) => void
}) {
  return <div role="dialog" aria-label="Notifications" style={{ position: 'absolute', left: 0, right: 0, bottom: 'calc(100% + 8px)', border: '1px solid var(--border)', borderRadius: 12, background: 'var(--bg)', boxShadow: '0 16px 36px rgba(15,23,42,0.16)', overflow: 'hidden', zIndex: 110 }}>
        <div style={{ padding: '10px 12px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: '1px solid var(--border)' }}>
          <span style={{ fontSize: 12, fontWeight: 700 }}>Notifications</span>
          {unreadCount > 0 && <button type="button" onClick={onMarkRead} style={{ border: 'none', background: 'transparent', color: 'var(--primary)', fontSize: 11, cursor: 'pointer', padding: 0 }}>Mark read</button>}
        </div>
        <div style={{ maxHeight: 260, overflowY: 'auto' }}>
          {notifications.length === 0 ? <div style={{ padding: 16, fontSize: 12, color: 'var(--text-muted)' }}>No notifications</div> : notifications.slice(0, 5).map(n => (
            <button key={n.id} type="button" onClick={() => onOpenNotification(n)} style={{ width: '100%', border: 'none', borderBottom: '1px solid var(--border)', background: n.read ? 'var(--bg)' : 'var(--bg-secondary)', padding: '10px 12px', display: 'flex', alignItems: 'flex-start', gap: 8, textAlign: 'left', cursor: 'pointer' }}>
              <span aria-hidden="true" style={{ width: 7, height: 7, borderRadius: '50%', background: n.read ? 'var(--text-muted)' : 'var(--c-success)', marginTop: 5, flexShrink: 0 }} />
              <span style={{ minWidth: 0, flex: 1 }}>
                <span style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{n.title}</span>
                {n.body && <span style={{ display: 'block', fontSize: 11, color: 'var(--text-muted)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{n.body}</span>}
              </span>
            </button>
          ))}
        </div>
      </div>
}

function getInitialPage(): Page {
  if (typeof window === 'undefined') return 'dashboard'
  return pageFromSearch(window.location.search)
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
  const { t } = useI18n()
  const router = useRouter()
  const initialPageRef = useRef(page)
  const previousUserIdRef = useRef<string | null>(null)
  const PageComp = PAGES[page]
  const activeUserId = session?.user?.id ?? null

  const [checkingOnboard, setCheckingOnboard] = useState(true)
  const [needsOnboarding, setNeedsOnboarding] = useState(false)
  const [notifications, setNotifications] = useState<NotificationItem[]>([])
  const [unreadCount, setUnreadCount] = useState(0)
  const [sidebarPopover, setSidebarPopover] = useState<'account' | 'notifications' | null>(null)
  const [mobileMoreOpen, setMobileMoreOpen] = useState(false)

  const prefetchPage = useCallback((nextPage: Page) => {
    // A speculative prefetch must never surface an unhandled rejection; the
    // dynamic component will still load normally if a transient request fails.
    void PAGE_PRELOADERS[nextPage]().catch(() => undefined)
  }, [])

  const navigatePage = useCallback((nextPage: Page, mode: 'push' | 'replace' = 'push') => {
    prefetchPage(nextPage)
    setSidebarPopover(null)
    setMobileMoreOpen(false)
    setPage(nextPage)
    writePageToUrl(nextPage, mode)
  }, [prefetchPage])
  const navContextValue = useMemo(() => ({ navigate: navigatePage }), [navigatePage])

  useEffect(() => {
    if (status !== 'authenticated') { setCheckingOnboard(false); return }
    fetch('/api/me')
      .then(r => r.json())
      .then((u) => { setNeedsOnboarding(!u.onboardedAt); setCheckingOnboard(false) })
      .catch(() => setCheckingOnboard(false))
  }, [status])

  useEffect(() => {
    const locationPage = pageFromSearch(window.location.search)
    initialPageRef.current = locationPage
    setPage(locationPage)
    writePageToUrl(locationPage, 'replace')

    function handlePopState() {
      setPage(pageFromSearch(window.location.search))
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

  // A client-side account switch must never reuse another user's cached API
  // response or mounted page state. The extension is deliberately one-way
  // synced from this authoritative web session, never the other direction.
  useEffect(() => {
    const previousUserId = previousUserIdRef.current
    if (previousUserId && previousUserId !== activeUserId) {
      clearCachedApiResponses()
      window.dispatchEvent(new Event('applymate:identity-changed'))
    }
    previousUserIdRef.current = activeUserId
  }, [activeUserId])

  // Notify extension when dashboard logs out
  useEffect(() => {
    if (status === 'unauthenticated') {
      window.postMessage({ type: 'DASHBOARD_LOGOUT' }, window.location.origin)
    }
  }, [status])

  useEffect(() => {
    if (status !== 'authenticated') return

    let cancelled = false
    const loadJobCount = () => {
      fetch('/api/jobs?page=1&pageSize=1')
        .then(r => r.ok ? r.json() as Promise<{ total?: number }> : Promise.reject(new Error('jobs fetch failed')))
        .then(data => { if (!cancelled) setJobCount(data.total ?? 0) })
        .catch(() => { if (!cancelled) setJobCount(0) })
    }

    loadJobCount()
    window.addEventListener('applymate:jobs-changed', loadJobCount)
    window.addEventListener('focus', loadJobCount)
    return () => {
      cancelled = true
      window.removeEventListener('applymate:jobs-changed', loadJobCount)
      window.removeEventListener('focus', loadJobCount)
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

  useEffect(() => {
    if (!mobileMoreOpen) return

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') setMobileMoreOpen(false)
    }

    function closeOnOutsidePointer(event: PointerEvent) {
      const target = event.target
      if (!(target instanceof Element)) return
      if (!target.closest('[data-mobile-more-menu]') && !target.closest('[data-mobile-more-button]')) {
        setMobileMoreOpen(false)
      }
    }

    document.addEventListener('keydown', closeOnEscape)
    document.addEventListener('pointerdown', closeOnOutsidePointer)
    return () => {
      document.removeEventListener('keydown', closeOnEscape)
      document.removeEventListener('pointerdown', closeOnOutsidePointer)
    }
  }, [mobileMoreOpen])

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
    setSidebarPopover(null)
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
      <NavContext.Provider value={navContextValue}>
        {needsOnboarding ? (
          <OnboardingFlow onComplete={() => setNeedsOnboarding(false)} />
        ) : (
          <>
            <div style={{ display: 'flex', height: '100vh', overflow: 'hidden' }}>
              <div id="desktop-sidebar">
                <Sidebar
                  active={page === 'gmail-recommendations' ? 'gmail' : page}
                  onNav={navigatePage}
                  onNavIntent={prefetchPage}
                  session={session}
                  jobCount={jobCount}
                  accountMenuOpen={sidebarPopover === 'account'}
                  onAccountMenuToggle={() => setSidebarPopover(current => current === 'account' ? null : 'account')}
                  onDismissSidebarPopovers={() => setSidebarPopover(null)}
                  notificationControl={
                    <NotificationControl
                      unreadCount={unreadCount}
                      onToggle={() => setSidebarPopover(current => current === 'notifications' ? null : 'notifications')}
                    />
                  }
                  notificationPanel={sidebarPopover === 'notifications' ? (
                    <NotificationPanel
                      notifications={notifications}
                      unreadCount={unreadCount}
                      onMarkRead={() => markNotificationRead()}
                      onOpenNotification={openNotification}
                    />
                  ) : null}
                />
              </div>
              <div id="main-content" style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                <PageComp key={activeUserId ?? 'anonymous'} />
              </div>
            </div>

            {mobileMoreOpen && (
              <div className="mobile-more-menu" data-mobile-more-menu role="menu" aria-label="More navigation">
                {getMobileMoreItems(t('nav.signout')).map(item => (
                  <button key={item.id} role="menuitem" data-danger={item.id === 'signout'} onClick={() => {
                    if (item.id === 'signout') void signOut({ callbackUrl: '/login' })
                    else navigatePage(item.id)
                  }}>
                    {item.label}
                  </button>
                ))}
              </div>
            )}

            {/* Mobile bottom bar */}
            <div id="mobile-bottom-bar">
              {getMobileNavItems().map(item => {
                const isMore = item.id === 'more'
                const isActive = isMore
                  ? mobileMoreOpen || page === 'gmail' || page === 'settings'
                  : page === item.id
                return (
                  <button key={item.id}
                    aria-label={item.label}
                    aria-expanded={isMore ? mobileMoreOpen : undefined}
                    aria-haspopup={isMore ? 'menu' : undefined}
                    data-mobile-more-button={isMore ? '' : undefined}
                    onClick={() => {
                      if (item.id === 'more') setMobileMoreOpen(open => !open)
                      else navigatePage(item.id)
                    }}
                    onPointerEnter={() => {
                      if (item.id !== 'more') prefetchPage(item.id)
                    }}
                    style={{
                      display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3,
                      flex: 1, padding: '6px 0', border: 'none', background: 'transparent', cursor: 'pointer',
                      color: isActive ? 'var(--primary)' : 'var(--text-muted)',
                      fontSize: 10, fontFamily: 'inherit', position: 'relative',
                    }}>
                    <span aria-hidden="true" style={{ fontSize: 18 }}>{MOB_ICONS[item.id]}</span>
                    <span>{item.label}</span>
                  </button>
                )
              })}
            </div>
          </>
        )}
      </NavContext.Provider>
    </>
  )
}
