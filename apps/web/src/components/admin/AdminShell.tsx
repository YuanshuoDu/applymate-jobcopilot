'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Activity, Bell, Bot, CreditCard, FileText, Flag, Home, Inbox, LogOut, Radio, ServerCog, ShieldAlert, ShieldCheck, Siren, Trash2, Users } from 'lucide-react'
import { signOut } from 'next-auth/react'
import { useEffect, useState, type ReactNode } from 'react'
import { AdminExportLink } from './AdminExportLink'
import { useI18n, type Lang } from '@/lib/i18n'

const navigation = [
  { href: '/admin', labelKey: 'admin.nav.overview', icon: Home, permission: 'observability.read' },
  { href: '/admin/contact-us', labelKey: 'admin.nav.support', icon: Inbox, permission: 'support_cases.read' },
  { href: '/admin/users', labelKey: 'admin.nav.users', icon: Users, permission: 'users.read' },
  { href: '/admin/users/deletions', labelKey: 'admin.nav.deletions', icon: Trash2, permission: 'users.deletion.manage' },
  { href: '/admin/plans', labelKey: 'admin.nav.plans', icon: CreditCard, permission: 'billing.read' },
  { href: '/admin/ats', labelKey: 'admin.nav.ats', icon: Radio, permission: 'ats.read' },
  { href: '/admin/applications', labelKey: 'admin.nav.applications', icon: Activity, permission: 'applications.read' },
  { href: '/admin/queues', labelKey: 'admin.nav.queues', icon: ServerCog, permission: 'queues.read' },
  { href: '/admin/ai', labelKey: 'admin.nav.ai', icon: Bot, permission: 'ai_budget.read' },
  { href: '/admin/incidents', labelKey: 'admin.nav.incidents', icon: Siren, permission: 'observability.read' },
  { href: '/admin/platform', labelKey: 'admin.nav.flags', icon: Flag, permission: 'feature_flags.read' },
  { href: '/admin/broadcasts', labelKey: 'admin.nav.broadcasts', icon: Bell, permission: 'broadcasts.create' },
  { href: '/admin/audit', labelKey: 'admin.nav.audit', icon: FileText, permission: 'audit.read' },
  { href: '/admin/access', labelKey: 'admin.nav.access', icon: ShieldCheck, permission: 'admin_members.read' },
  { href: '/admin/security', labelKey: 'admin.nav.security', icon: ShieldAlert, permission: 'break_glass.request' },
]

export function filterAdminNav(permissions: readonly string[]) {
  return navigation.filter(item => permissions.includes(item.permission))
}

const notificationPermissions = ['support_cases.read', 'audit.read', 'observability.read']

function exportConfigForPath(pathname: string) {
  if (pathname.startsWith('/admin/users/deletions')) return { resource: 'deletions', permission: 'users.deletion.manage' }
  if (pathname.startsWith('/admin/contact-us')) return { resource: 'support-cases', permission: 'support_cases.read' }
  if (pathname.startsWith('/admin/users')) return { resource: 'users', permission: 'users.export_anonymized' }
  if (pathname.startsWith('/admin/plans')) return { resource: 'subscriptions', permission: 'billing.read' }
  if (pathname.startsWith('/admin/ats')) return { resource: 'ats', permission: 'ats.read' }
  if (pathname.startsWith('/admin/applications')) return { resource: 'applications', permission: 'applications.read' }
  if (pathname.startsWith('/admin/ai')) return { resource: 'ai-usage', permission: 'ai_budget.read' }
  if (pathname.startsWith('/admin/incidents')) return { resource: 'incidents', permission: 'observability.read' }
  if (pathname.startsWith('/admin/access')) return { resource: 'access-members', permission: 'admin_members.read' }
  if (pathname.startsWith('/admin/broadcasts')) return { resource: 'broadcasts', permission: 'broadcasts.preview' }
  return null
}

export function AdminShell({ children, permissions, roleKey }: { children: ReactNode; permissions: readonly string[]; roleKey: string }) {
  const pathname = usePathname()
  const exportConfig = exportConfigForPath(pathname)
  const { lang, setLang, t } = useI18n()
  const canReadNotifications = permissions.some(permission => notificationPermissions.includes(permission))
  const [notifications, setNotifications] = useState<Array<{ id: string; title: string; body: string | null; entityId: string | null; createdAt: string; readAt: string | null }>>([])
  const [unreadCount, setUnreadCount] = useState(0)
  const [notificationsOpen, setNotificationsOpen] = useState(false)

  useEffect(() => {
    if (!canReadNotifications) return
    const load = async () => {
      const response = await fetch('/api/admin/v1/notifications?limit=20', { cache: 'no-store' })
      if (!response.ok) return
      const payload = await response.json().catch(() => null) as { notifications?: typeof notifications; unreadCount?: number } | null
      setNotifications(payload?.notifications ?? [])
      setUnreadCount(payload?.unreadCount ?? 0)
    }
    void load()
    const timer = window.setInterval(() => void load(), 60_000)
    return () => window.clearInterval(timer)
  }, [canReadNotifications])

  async function markNotification(id?: string) {
    const response = await fetch('/api/admin/v1/notifications', { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify(id ? { id } : { all: true }) })
    if (!response.ok) return
    const payload = await response.json().catch(() => null) as { unreadCount?: number } | null
    setUnreadCount(payload?.unreadCount ?? 0)
    setNotifications(current => id ? current.map(item => item.id === id ? { ...item, readAt: new Date().toISOString() } : item) : current.map(item => ({ ...item, readAt: new Date().toISOString() })))
  }

  return <div className="admin-shell">
    <aside className="admin-sidebar">
      <Link href="/admin" className="admin-brand"><span>ApplyMate</span><small>Internal Admin</small></Link>
      <nav aria-label="Admin navigation" className="admin-nav">
        {filterAdminNav(permissions).map(item => {
          const active = item.href === '/admin' ? pathname === '/admin' : pathname.startsWith(item.href)
          const Icon = item.icon
          const label = t(item.labelKey)
          return <Link key={item.href} href={item.href} title={label} aria-label={label} data-active={active} className="admin-nav-link"><Icon size={18} aria-hidden="true" />{label}</Link>
        })}
      </nav>
      <div className="admin-identity"><span className="admin-avatar">{roleKey.slice(0, 2).toUpperCase()}</span><div><strong>{roleKey.replaceAll('_', ' ')}</strong><small>Internal role</small></div><button type="button" className="admin-logout" onClick={() => signOut({ callbackUrl: '/login?callbackUrl=%2Fadmin' })} aria-label="Sign out"><LogOut size={15} aria-hidden="true" /></button></div>
    </aside>
    <main className="admin-main">
      <div className="admin-topbar">{exportConfig && permissions.includes(exportConfig.permission) && <AdminExportLink resource={exportConfig.resource} label={t('admin.exportCsv')} />}<label className="admin-language-picker"><span className="sr-only">{t('admin.language')}</span><select aria-label={t('admin.language')} value={lang} onChange={event => setLang(event.target.value as Lang)}><option value="en">EN</option><option value="zh">中文</option></select></label>{canReadNotifications && <div className="admin-notification-center"><button type="button" className="admin-notification-button" aria-label={`${t('admin.notifications')}${unreadCount ? `, ${unreadCount} unread` : ''}`} aria-expanded={notificationsOpen} onClick={() => setNotificationsOpen(current => !current)}><Bell size={17} aria-hidden="true" />{unreadCount > 0 && <span className="admin-notification-badge" aria-live="polite">{unreadCount > 99 ? '99+' : unreadCount}</span>}</button>{notificationsOpen && <div className="admin-notification-panel" role="dialog" aria-label={t('admin.notifications')}><div className="admin-notification-panel-title"><strong>{t('admin.notifications')}</strong><button type="button" onClick={() => void markNotification()}>{t('admin.markAllRead')}</button></div>{notifications.length === 0 ? <p>{t('admin.noNotifications')}</p> : notifications.map(item => <Link key={item.id} href={item.entityId ? `/admin/contact-us?case=${encodeURIComponent(item.entityId)}` : '/admin'} className="admin-notification-item" data-unread={!item.readAt} onClick={() => { if (!item.readAt) void markNotification(item.id); setNotificationsOpen(false) }}><strong>{item.title}</strong><span>{item.body ?? ''}</span><time>{new Date(item.createdAt).toLocaleString()}</time></Link>)}</div>}</div>}</div>
      {children}
    </main>
  </div>
}
