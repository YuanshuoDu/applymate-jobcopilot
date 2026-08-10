'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Activity, Bell, Bot, CreditCard, FileText, Flag, Home, Inbox, LogOut, Radio, ServerCog, ShieldAlert, ShieldCheck, Siren, Trash2, Users } from 'lucide-react'
import { signOut } from 'next-auth/react'
import { useEffect, useState, type ReactNode } from 'react'

const navigation = [
  { href: '/admin', label: 'Overview', icon: Home, permission: 'observability.read' },
  { href: '/admin/contact-us', label: 'Contact us', icon: Inbox, permission: 'support_cases.read' },
  { href: '/admin/users', label: 'Users', icon: Users, permission: 'users.read' },
  { href: '/admin/users/deletions', label: 'Deletion queue', icon: Trash2, permission: 'users.deletion.manage' },
  { href: '/admin/plans', label: 'Plans', icon: CreditCard, permission: 'billing.read' },
  { href: '/admin/ats', label: 'ATS sources', icon: Radio, permission: 'ats.read' },
  { href: '/admin/applications', label: 'Applications', icon: Activity, permission: 'applications.read' },
  { href: '/admin/queues', label: 'Queues', icon: ServerCog, permission: 'queues.read' },
  { href: '/admin/ai', label: 'AI operations', icon: Bot, permission: 'ai_budget.read' },
  { href: '/admin/incidents', label: 'Incidents', icon: Siren, permission: 'observability.read' },
  { href: '/admin/platform', label: 'Feature flags', icon: Flag, permission: 'feature_flags.read' },
  { href: '/admin/broadcasts', label: 'Broadcasts', icon: Bell, permission: 'broadcasts.create' },
  { href: '/admin/audit', label: 'Audit', icon: FileText, permission: 'audit.read' },
  { href: '/admin/access', label: 'Access', icon: ShieldCheck, permission: 'admin_members.read' },
  { href: '/admin/security', label: 'Security', icon: ShieldAlert, permission: 'break_glass.request' },
]

const notificationPermissions = ['support_cases.read', 'audit.read', 'observability.read']

export function AdminShell({ children, permissions, roleKey }: { children: ReactNode; permissions: readonly string[]; roleKey: string }) {
  const pathname = usePathname()
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
        {navigation.filter(item => permissions.includes(item.permission)).map(item => {
          const active = item.href === '/admin' ? pathname === '/admin' : pathname.startsWith(item.href)
          const Icon = item.icon
          return <Link key={item.href} href={item.href} title={item.label} aria-label={item.label} data-active={active} className="admin-nav-link"><Icon size={18} aria-hidden="true" />{item.label}</Link>
        })}
      </nav>
      <div className="admin-identity"><span className="admin-avatar">{roleKey.slice(0, 2).toUpperCase()}</span><div><strong>{roleKey.replaceAll('_', ' ')}</strong><small>Internal role</small></div><button type="button" className="admin-logout" onClick={() => signOut({ callbackUrl: '/login?callbackUrl=%2Fadmin' })} aria-label="Sign out"><LogOut size={15} aria-hidden="true" /></button></div>
    </aside>
    <main className="admin-main">
      <div className="admin-topbar">{canReadNotifications && <div className="admin-notification-center"><button type="button" className="admin-notification-button" aria-label={`Notifications${unreadCount ? `, ${unreadCount} unread` : ''}`} aria-expanded={notificationsOpen} onClick={() => setNotificationsOpen(current => !current)}><Bell size={17} aria-hidden="true" />{unreadCount > 0 && <span className="admin-notification-badge" aria-live="polite">{unreadCount > 99 ? '99+' : unreadCount}</span>}</button>{notificationsOpen && <div className="admin-notification-panel" role="dialog" aria-label="Admin notifications"><div className="admin-notification-panel-title"><strong>Notifications</strong><button type="button" onClick={() => void markNotification()}>Mark all read</button></div>{notifications.length === 0 ? <p>No notifications.</p> : notifications.map(item => <Link key={item.id} href={item.entityId ? `/admin/contact-us?case=${encodeURIComponent(item.entityId)}` : '/admin'} className="admin-notification-item" data-unread={!item.readAt} onClick={() => { if (!item.readAt) void markNotification(item.id); setNotificationsOpen(false) }}><strong>{item.title}</strong><span>{item.body ?? ''}</span><time>{new Date(item.createdAt).toLocaleString()}</time></Link>)}</div>}</div>}</div>
      {children}
    </main>
  </div>
}
