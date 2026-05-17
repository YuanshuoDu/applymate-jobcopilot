'use client'

import { useState, useEffect } from 'react'
import { signOut } from 'next-auth/react'
import type { Session } from 'next-auth'
import type { Page } from '@/lib/types'
import { useTheme } from '@/components/ThemeProvider'
import { UserAvatar } from '@/components/ui'
import { useI18n } from '@/lib/i18n'

interface SidebarProps {
  active:  Page
  onNav:   (p: Page) => void
  session: Session | null
}

export function Sidebar({ active, onNav, session }: SidebarProps) {
  const user      = session?.user
  const planLabel = 'Pro plan'
  const { theme, toggle } = useTheme()
  const { lang, t, setLang } = useI18n()
  const [gmailUnread, setGmailUnread] = useState<number | null>(null)

  useEffect(() => {
    fetch('/api/gmail/unread')
      .then(r => r.json())
      .then(d => { if (d.hasGmail) setGmailUnread(d.unread) })
      .catch(() => {})
  }, [])

  // Nav items with i18n labels
  const NAV_ITEMS: { id: Page; label: string; icon: string }[] = [
    { id: 'dashboard',  label: t('nav.dashboard'),    icon: '▦' },
    { id: 'jobs',       label: t('nav.jobs'),         icon: '◈' },
    { id: 'search',     label: t('nav.search'),       icon: '⊕' },
    { id: 'resume',     label: t('nav.resume'),       icon: '☰' },
    { id: 'gmail',      label: t('nav.gmail'),        icon: '✉' },
    { id: 'agent',      label: t('nav.agent'),        icon: '◉' },
    { id: 'animation',  label: 'Flow Demo',           icon: '▷' },
    { id: 'extension',  label: t('nav.extension'),    icon: '⊞' },
    { id: 'settings',   label: t('nav.settings'),     icon: '⚙' },
  ]

  return (
    <div style={{
      width: 200, flexShrink: 0, background: 'var(--bg-secondary)',
      borderRight: '0.5px solid var(--border)',
      display: 'flex', flexDirection: 'column', height: '100vh', position: 'sticky', top: 0,
    }}>
      {/* Logo */}
      <div style={{ padding: '16px 16px 14px', borderBottom: '0.5px solid var(--border)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ width: 24, height: 24, borderRadius: 6, background: '#185FA5', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: 11, fontWeight: 700 }}>A</div>
          <div>
            <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text)', lineHeight: 1.2 }}>ApplyMate AI</div>
            <div style={{ fontSize: 10, color: 'var(--text-muted)', lineHeight: 1.2 }}>Job Copilot</div>
          </div>
        </div>
      </div>

      {/* Nav */}
      <nav style={{ flex: 1, padding: '8px 8px', display: 'flex', flexDirection: 'column', gap: 1 }}>
        {NAV_ITEMS.map(item => (
          <button key={item.id} onClick={() => onNav(item.id)} style={{
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '7px 8px', borderRadius: 6, border: 'none', cursor: 'pointer',
            background: active === item.id ? 'var(--bg)' : 'transparent',
            color: active === item.id ? 'var(--text)' : 'var(--text-muted)',
            fontWeight: active === item.id ? 500 : 400,
            fontSize: 13, textAlign: 'left', width: '100%', transition: 'all 0.12s',
          }}>
            <span style={{ fontSize: 14, opacity: active === item.id ? 1 : 0.5 }}>{item.icon}</span>
            {item.label}
            {item.id === 'jobs'      && <span style={{ marginLeft: 'auto', fontSize: 10, background: 'rgba(24,95,165,0.12)', color: '#185FA5', borderRadius: 999, padding: '1px 6px' }}>47</span>}
            {item.id === 'gmail' && gmailUnread != null && gmailUnread > 0 && (
              <span style={{ marginLeft: 'auto', fontSize: 10, background: 'rgba(163,45,45,0.12)', color: '#A32D2D', borderRadius: 999, padding: '1px 6px' }}>{gmailUnread}</span>
            )}
            {item.id === 'agent'     && <span style={{ marginLeft: 'auto', width: 7, height: 7, borderRadius: '50%', background: '#3B6D11', flexShrink: 0 }} />}
            {item.id === 'animation' && <span style={{ marginLeft: 'auto', fontSize: 9, background: 'rgba(91,61,200,0.12)', color: '#5B3DC8', borderRadius: 999, padding: '1px 6px' }}>new</span>}
          </button>
        ))}
      </nav>

      {/* User section */}
      <div style={{ borderTop: '0.5px solid var(--border)' }}>
        {/* User info */}
        <div style={{ padding: '10px 12px', display: 'flex', alignItems: 'center', gap: 8 }}>
          <UserAvatar src={user?.image} name={user?.name} email={user?.email} size={28} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {user?.name ?? user?.email?.split('@')[0] ?? 'User'}
            </div>
            <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>{planLabel}</div>
          </div>
        </div>

        {/* Theme toggle */}
        <button
          onClick={toggle}
          style={{
            width: '100%', padding: '6px 12px', border: 'none', background: 'transparent',
            color: 'var(--text-muted)', fontSize: 12, textAlign: 'left', cursor: 'pointer',
            display: 'flex', alignItems: 'center', gap: 8,
            borderTop: '0.5px solid var(--border)',
            transition: 'all 0.12s',
          }}>
          <span style={{ fontSize: 13 }}>{theme === 'dark' ? '☀' : '☾'}</span>
          {theme === 'dark' ? 'Light Mode' : 'Dark Mode'}
        </button>

        {/* Language switcher */}
        <button
          onClick={() => setLang(lang === 'en' ? 'zh' : 'en')}
          style={{
            width: '100%', padding: '6px 12px', border: 'none', background: 'transparent',
            color: 'var(--text-muted)', fontSize: 12, textAlign: 'left', cursor: 'pointer',
            display: 'flex', alignItems: 'center', gap: 8,
            borderTop: '0.5px solid var(--border)',
            transition: 'all 0.12s',
          }}>
          <span style={{ fontSize: 13 }}>🌐</span>
          {t('lang.switch')}
        </button>

        {/* Logout button */}
        <button
          onClick={() => signOut({ callbackUrl: '/login' })}
          className="sidebar-logout-btn"
          style={{
            width: '100%', padding: '8px 12px', border: 'none', background: 'transparent',
            color: 'var(--text-muted)', fontSize: 12, textAlign: 'left', cursor: 'pointer',
            display: 'flex', alignItems: 'center', gap: 8,
            borderTop: '0.5px solid var(--border)',
            transition: 'all 0.12s',
          }}
        >
          <span style={{ fontSize: 13, opacity: 0.6 }}>↪</span>
          退出登录
        </button>
      </div>
    </div>
  )
}
