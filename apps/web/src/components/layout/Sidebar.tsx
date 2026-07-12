'use client'

import { useState, useEffect } from 'react'
import { signOut } from 'next-auth/react'
import type { Session } from 'next-auth'
import type { Page } from '@/lib/types'
import { UserAvatar } from '@/components/ui'
import { useI18n } from '@/lib/i18n'

interface SidebarProps {
  active:  Page
  onNav:   (p: Page) => void
  session: Session | null
  jobCount?: number
}

export type SidebarNavItem = { id: Page; label: string }

// ── Nav SVG icons ─────────────────────────────────────────────────────────────
const NavIcon = ({ id }: { id: string }) => {
  const icons: Record<string, React.ReactNode> = {
    dashboard: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>,
    jobs:      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2"/></svg>,
    search:    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>,
    resume:    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>,
    gmail:     <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>,
    agent:     <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83"/></svg>,
    'agent-history': <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 3v18h18"/><path d="M7 14l3-3 3 2 4-6"/><circle cx="7" cy="14" r="1"/><circle cx="10" cy="11" r="1"/><circle cx="13" cy="13" r="1"/><circle cx="17" cy="7" r="1"/></svg>,
    observability: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 3v18h18"/><rect x="7" y="12" width="3" height="5" rx="1"/><rect x="12" y="8" width="3" height="9" rx="1"/><rect x="17" y="5" width="3" height="12" rx="1"/></svg>,
    settings:  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>,
  }
  return <span style={{ display: 'flex', alignItems: 'center', flexShrink: 0 }}>{icons[id] ?? null}</span>
}

export function getSidebarNavItems(t: (key: string) => string): SidebarNavItem[] {
  return [
    { id: 'dashboard', label: t('nav.dashboard') },
    { id: 'jobs',      label: t('nav.jobs')      },
    { id: 'search',    label: t('nav.search')    },
    { id: 'resume',    label: t('nav.resume')    },
    { id: 'gmail',     label: t('nav.gmail')     },
    { id: 'agent',     label: t('nav.agent')     },
  ]
}

export function Sidebar({ active, onNav, session, jobCount: jobCountProp }: SidebarProps) {
  const user = session?.user
  const { t } = useI18n()

  const [gmailUnread, setGmailUnread] = useState<number | null>(null)
  const [jobCount,    setJobCount]    = useState<number | null>(null)
  const [userPlan,    setUserPlan]    = useState<string | null>(null)
  const [logoutHov,   setLogoutHov]   = useState(false)

  useEffect(() => {
    fetch('/api/gmail/unread').then(r => r.json()).then(d => { if (d.hasGmail) setGmailUnread(d.unread) }).catch(() => {})
    fetch('/api/jobs?pageSize=1').then(r => r.json()).then(d => { if (typeof d.total === 'number') setJobCount(d.total) }).catch(() => {})
    fetch('/api/me').then(r => r.json()).then(d => { if (d.plan) setUserPlan(d.plan) }).catch(() => {})
  }, [])

  const plan = userPlan ?? (user as { plan?: string } | undefined)?.plan ?? 'free'
  const planLabel = plan === 'enterprise' ? 'Team Plan' : plan === 'pro' ? 'Pro Plan' : 'Free Plan'
  const planColor = plan === 'enterprise' ? '#0284C7' : plan === 'pro' ? '#7C3AED' : '#64748B'
  const planBg    = plan === 'enterprise' ? 'rgba(2,132,199,0.10)' : plan === 'pro' ? 'rgba(124,58,237,0.10)' : 'rgba(100,116,139,0.10)'

  const NAV_ITEMS = getSidebarNavItems(t)

  return (
    <div className="app-sidebar" style={{
      flexShrink: 0,
      background: 'var(--glass-sidebar)',
      backdropFilter: 'blur(24px) saturate(180%)',
      WebkitBackdropFilter: 'blur(24px) saturate(180%)',
      borderRight: '1px solid var(--border-glass)',
      display: 'flex', flexDirection: 'column', height: '100vh',
      position: 'sticky', top: 0,
    }}>

      {/* ── Logo ── */}
      <div style={{ padding: '18px 16px 14px', borderBottom: '1px solid var(--border)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{
            width: 30, height: 30, borderRadius: 9,
            background: 'var(--brand-gradient)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: '#fff', fontSize: 13, fontWeight: 700, flexShrink: 0,
            boxShadow: '0 3px 10px rgba(79,70,229,0.40)',
          }}>A</div>
          <div>
            <div style={{
              fontSize: 13, fontWeight: 700, lineHeight: 1.2,
              background: 'var(--brand-gradient)',
              WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', backgroundClip: 'text',
            }}>ApplyMate AI</div>
            <div style={{ fontSize: 10, color: 'var(--text-subtle)', lineHeight: 1.2, marginTop: 1 }}>Job Copilot · Europe</div>
          </div>
        </div>
      </div>

      {/* ── Nav ── */}
      <nav style={{ flex: 1, padding: '10px 8px', display: 'flex', flexDirection: 'column', gap: 2, overflowY: 'auto' }}>
        {NAV_ITEMS.map(item => (
          <button key={item.id} className="app-nav-button" data-active={active === item.id} onClick={() => onNav(item.id)} style={{
            display: 'flex', alignItems: 'center', gap: 9,
            padding: '8px 10px 8px 14px', borderRadius: 8, border: 'none', cursor: 'pointer',
            background: 'transparent',
            color: active === item.id ? 'var(--primary)' : 'var(--text-muted)',
            fontWeight: active === item.id ? 600 : 400,
            fontSize: 13, textAlign: 'left', width: '100%', transition: 'all 0.15s',
          }}>
            <NavIcon id={item.id} />
            {item.label}
            {item.id === 'jobs' && (jobCountProp ?? jobCount) != null && (jobCountProp ?? jobCount)! > 0 && (
              <span style={{ marginLeft: 'auto', fontSize: 10, background: 'rgba(79,70,229,0.12)', color: 'var(--primary)', borderRadius: 999, padding: '1px 6px', fontWeight: 600 }}>
                {(jobCountProp ?? jobCount)! > 99 ? '99+' : (jobCountProp ?? jobCount)}
              </span>
            )}
            {item.id === 'gmail' && gmailUnread != null && gmailUnread > 0 && (
              <span style={{ marginLeft: 'auto', fontSize: 10, background: 'rgba(163,45,45,0.12)', color: '#A32D2D', borderRadius: 999, padding: '1px 6px', fontWeight: 600 }}>{gmailUnread}</span>
            )}
            {item.id === 'agent' && (
              <span style={{ marginLeft: 'auto', width: 6, height: 6, borderRadius: '50%', background: '#22C55E', flexShrink: 0 }} />
            )}
          </button>
        ))}
      </nav>

      {/* ── Bottom panel ── */}
      <div style={{ borderTop: '1px solid var(--border)', padding: '10px 10px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>

        {/* ── User info + sign out ── */}
        <div style={{ borderTop: '1px solid var(--border)', paddingTop: 8 }}>
          {/* Plan badge */}
          <div style={{ paddingLeft: 2, marginBottom: 6 }}>
            <span style={{ fontSize: 10, fontWeight: 600, padding: '2px 8px', borderRadius: 999, background: planBg, color: planColor }}>{planLabel}</span>
          </div>

          {/* User row */}
          <button onClick={() => onNav('settings')} title={t('nav.settings')} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, width: '100%', padding: 4, border: 'none', borderRadius: 8, background: active === 'settings' ? 'rgba(79,70,229,0.10)' : 'transparent', cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit' }}>
            <UserAvatar src={user?.image} name={user?.name} email={user?.email} size={26} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {user?.name ?? user?.email?.split('@')[0] ?? 'User'}
              </div>
              <div style={{ fontSize: 10, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {user?.email ?? ''}
              </div>
            </div>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: active === 'settings' ? 'var(--primary)' : 'var(--text-muted)', flexShrink: 0 }}><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 15a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
          </button>

          {/* Sign out */}
          <button
            onClick={() => signOut({ callbackUrl: '/login' })}
            onMouseEnter={() => setLogoutHov(true)}
            onMouseLeave={() => setLogoutHov(false)}
            style={{
              width: '100%', padding: '6px 10px', border: 'none', borderRadius: 7,
              background: logoutHov ? 'rgba(163,45,45,0.10)' : 'transparent',
              color: logoutHov ? '#DC2626' : 'var(--text-muted)',
              fontSize: 12, textAlign: 'left', cursor: 'pointer',
              display: 'flex', alignItems: 'center', gap: 7,
              transition: 'all 0.12s', fontFamily: 'inherit',
            }}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
            {t('nav.signout')}
          </button>
        </div>
      </div>
    </div>
  )
}
