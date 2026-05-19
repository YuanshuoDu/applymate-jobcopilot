'use client'

import { useState, useEffect, useRef } from 'react'
import { signOut } from 'next-auth/react'
import type { Session } from 'next-auth'
import type { Page } from '@/lib/types'
import { useTheme, type ThemeMode } from '@/components/ThemeProvider'
import { UserAvatar } from '@/components/ui'
import { useI18n, LANGUAGES, type Lang } from '@/lib/i18n'

interface SidebarProps {
  active:  Page
  onNav:   (p: Page) => void
  session: Session | null
}

// ── Nav SVG icons ─────────────────────────────────────────────────────────────
const NavIcon = ({ id }: { id: string }) => {
  const icons: Record<string, React.ReactNode> = {
    dashboard: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>,
    jobs:      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2"/></svg>,
    search:    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>,
    resume:    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>,
    gmail:     <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>,
    agent:     <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83"/></svg>,
    animation: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>,
    extension: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18M3 9h18"/></svg>,
    settings:  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>,
  }
  return <span style={{ display: 'flex', alignItems: 'center', flexShrink: 0 }}>{icons[id] ?? null}</span>
}

// ── Theme mode icons ──────────────────────────────────────────────────────────
const THEME_OPTIONS: { mode: ThemeMode; icon: string; label: string }[] = [
  { mode: 'light',  icon: '☀', label: 'Light'  },
  { mode: 'system', icon: '💻', label: 'System' },
  { mode: 'dark',   icon: '🌙', label: 'Dark'   },
]

export function Sidebar({ active, onNav, session }: SidebarProps) {
  const user = session?.user
  const { theme, mode, setMode } = useTheme()
  const { lang, t, setLang } = useI18n()

  const [gmailUnread, setGmailUnread] = useState<number | null>(null)
  const [jobCount,    setJobCount]    = useState<number | null>(null)
  const [userPlan,    setUserPlan]    = useState<string | null>(null)
  const [logoutHov,   setLogoutHov]   = useState(false)
  const [langOpen,    setLangOpen]    = useState(false)
  const langRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    fetch('/api/gmail/unread').then(r => r.json()).then(d => { if (d.hasGmail) setGmailUnread(d.unread) }).catch(() => {})
    fetch('/api/jobs?pageSize=1').then(r => r.json()).then(d => { if (typeof d.total === 'number') setJobCount(d.total) }).catch(() => {})
    fetch('/api/me').then(r => r.json()).then(d => { if (d.plan) setUserPlan(d.plan) }).catch(() => {})
  }, [])

  // Close lang dropdown on outside click
  useEffect(() => {
    function handler(e: MouseEvent) {
      if (langRef.current && !langRef.current.contains(e.target as Node)) {
        setLangOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const plan = userPlan ?? (user as { plan?: string } | undefined)?.plan ?? 'free'
  const planLabel = plan === 'enterprise' ? 'Team Plan' : plan === 'pro' ? 'Pro Plan' : 'Free Plan'
  const planColor = plan === 'enterprise' ? '#0284C7' : plan === 'pro' ? '#7C3AED' : '#64748B'
  const planBg    = plan === 'enterprise' ? 'rgba(2,132,199,0.10)' : plan === 'pro' ? 'rgba(124,58,237,0.10)' : 'rgba(100,116,139,0.10)'

  const currentLang = LANGUAGES.find(l => l.value === lang) ?? LANGUAGES[0]

  const NAV_ITEMS: { id: Page; label: string }[] = [
    { id: 'dashboard', label: t('nav.dashboard') },
    { id: 'jobs',      label: t('nav.jobs')      },
    { id: 'search',    label: t('nav.search')    },
    { id: 'resume',    label: t('nav.resume')    },
    { id: 'gmail',     label: t('nav.gmail')     },
    { id: 'agent',     label: t('nav.agent')     },
    { id: 'animation', label: 'Flow Demo'        },
    { id: 'extension', label: t('nav.extension') },
    { id: 'settings',  label: t('nav.settings')  },
  ]

  return (
    <div style={{
      width: 220, flexShrink: 0,
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
            background: 'linear-gradient(135deg, #4F46E5 0%, #7C3AED 100%)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: '#fff', fontSize: 13, fontWeight: 700, flexShrink: 0,
            boxShadow: '0 3px 10px rgba(79,70,229,0.40)',
          }}>A</div>
          <div>
            <div style={{
              fontSize: 13, fontWeight: 700, lineHeight: 1.2,
              background: 'linear-gradient(135deg, #4F46E5 0%, #7C3AED 100%)',
              WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', backgroundClip: 'text',
            }}>ApplyMate AI</div>
            <div style={{ fontSize: 10, color: 'var(--text-subtle)', lineHeight: 1.2, marginTop: 1 }}>Job Copilot · Europe</div>
          </div>
        </div>
      </div>

      {/* ── Nav ── */}
      <nav style={{ flex: 1, padding: '8px', display: 'flex', flexDirection: 'column', gap: 1, overflowY: 'auto' }}>
        {NAV_ITEMS.map(item => (
          <button key={item.id} onClick={() => onNav(item.id)} style={{
            display: 'flex', alignItems: 'center', gap: 9,
            padding: '7px 10px', borderRadius: 8, border: 'none', cursor: 'pointer',
            background: active === item.id
              ? 'linear-gradient(135deg, rgba(79,70,229,0.12) 0%, rgba(124,58,237,0.08) 100%)'
              : 'transparent',
            color: active === item.id ? 'var(--primary)' : 'var(--text-muted)',
            fontWeight: active === item.id ? 600 : 400,
            fontSize: 13, textAlign: 'left', width: '100%', transition: 'all 0.15s',
          }}>
            <NavIcon id={item.id} />
            {item.label}
            {item.id === 'jobs' && jobCount != null && (
              <span style={{ marginLeft: 'auto', fontSize: 10, background: 'rgba(79,70,229,0.12)', color: 'var(--primary)', borderRadius: 999, padding: '1px 6px', fontWeight: 600 }}>{jobCount}</span>
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

        {/* ── Theme mode picker ── */}
        <div>
          <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-subtle)', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 6, paddingLeft: 2 }}>
            Appearance
          </div>
          <div style={{
            display: 'flex', borderRadius: 9, overflow: 'hidden',
            border: '1px solid var(--border)',
            background: 'var(--bg-secondary)',
          }}>
            {THEME_OPTIONS.map(opt => {
              const active = mode === opt.mode
              return (
                <button key={opt.mode} onClick={() => setMode(opt.mode)} title={t(`theme.${opt.mode}`) || opt.label} style={{
                  flex: 1, padding: '6px 4px', border: 'none', cursor: 'pointer',
                  display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2,
                  background: active
                    ? 'linear-gradient(135deg, rgba(79,70,229,0.18) 0%, rgba(124,58,237,0.12) 100%)'
                    : 'transparent',
                  color: active ? 'var(--primary)' : 'var(--text-muted)',
                  transition: 'all 0.15s',
                  borderRight: opt.mode !== 'dark' ? '1px solid var(--border)' : 'none',
                  fontFamily: 'inherit',
                }}>
                  <span style={{ fontSize: 14, lineHeight: 1 }}>{opt.icon}</span>
                  <span style={{ fontSize: 9, fontWeight: active ? 700 : 400, letterSpacing: '0.02em' }}>
                    {t(`theme.${opt.mode}`) || opt.label}
                  </span>
                </button>
              )
            })}
          </div>
        </div>

        {/* ── Language picker ── */}
        <div ref={langRef} style={{ position: 'relative' }}>
          <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-subtle)', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 6, paddingLeft: 2 }}>
            {t('lang.label')}
          </div>
          <button onClick={() => setLangOpen(v => !v)} style={{
            width: '100%', padding: '7px 10px',
            border: '1px solid var(--border)', borderRadius: 9,
            background: langOpen ? 'rgba(79,70,229,0.08)' : 'var(--bg-secondary)',
            color: 'var(--text)', fontSize: 12, cursor: 'pointer',
            display: 'flex', alignItems: 'center', gap: 7,
            transition: 'all 0.15s', fontFamily: 'inherit',
          }}>
            <span style={{ fontSize: 15 }}>{currentLang.flag}</span>
            <span style={{ flex: 1, textAlign: 'left', fontWeight: 500 }}>{currentLang.native}</span>
            <span style={{ fontSize: 10, color: 'var(--text-muted)', transition: 'transform 0.2s', transform: langOpen ? 'rotate(180deg)' : 'none' }}>▾</span>
          </button>

          {langOpen && (
            <>
              <div style={{ position: 'fixed', inset: 0, zIndex: 99 }} onClick={() => setLangOpen(false)} />
              <div style={{
                position: 'absolute', bottom: '110%', left: 0, right: 0, zIndex: 100,
                background: 'var(--glass-modal)',
                backdropFilter: 'blur(20px)',
                WebkitBackdropFilter: 'blur(20px)',
                border: '1px solid var(--border-glass)',
                borderRadius: 12,
                boxShadow: '0 8px 32px rgba(0,0,0,0.20)',
                overflow: 'hidden',
              }}>
                {LANGUAGES.map(l => {
                  const selected = l.value === lang
                  return (
                    <button key={l.value} onClick={() => { setLang(l.value as Lang); setLangOpen(false) }} style={{
                      display: 'flex', alignItems: 'center', gap: 9,
                      width: '100%', padding: '9px 12px', border: 'none', cursor: 'pointer',
                      background: selected ? 'rgba(79,70,229,0.10)' : 'transparent',
                      color: selected ? 'var(--primary)' : 'var(--text)',
                      fontSize: 13, textAlign: 'left', fontFamily: 'inherit',
                      transition: 'background 0.12s',
                    }}>
                      <span style={{ fontSize: 16 }}>{l.flag}</span>
                      <span style={{ flex: 1 }}>{l.native}</span>
                      <span style={{ fontSize: 11, color: 'var(--text-subtle)' }}>{l.label}</span>
                      {selected && <span style={{ fontSize: 11, color: 'var(--primary)' }}>✓</span>}
                    </button>
                  )
                })}
              </div>
            </>
          )}
        </div>

        {/* ── User info + sign out ── */}
        <div style={{ borderTop: '1px solid var(--border)', paddingTop: 8 }}>
          {/* Plan badge */}
          <div style={{ paddingLeft: 2, marginBottom: 6 }}>
            <span style={{ fontSize: 10, fontWeight: 600, padding: '2px 8px', borderRadius: 999, background: planBg, color: planColor }}>{planLabel}</span>
          </div>

          {/* User row */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <UserAvatar src={user?.image} name={user?.name} email={user?.email} size={26} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {user?.name ?? user?.email?.split('@')[0] ?? 'User'}
              </div>
              <div style={{ fontSize: 10, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {user?.email ?? ''}
              </div>
            </div>
          </div>

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
