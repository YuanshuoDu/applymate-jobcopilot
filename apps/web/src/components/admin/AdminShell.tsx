'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Activity, Bell, Bot, FileText, Flag, Home, Inbox, Radio, ShieldCheck, Users } from 'lucide-react'
import type { ReactNode } from 'react'

const navigation = [
  { href: '/admin', label: 'Overview', icon: Home, permission: 'observability.read' },
  { href: '/admin/contact-us', label: 'Contact us', icon: Inbox, permission: 'support_cases.read' },
  { href: '/admin/users', label: 'Users', icon: Users, permission: 'users.read' },
  { href: '/admin/ats', label: 'ATS sources', icon: Radio, permission: 'ats.read' },
  { href: '/admin/applications', label: 'Applications', icon: Activity, permission: 'applications.read' },
  { href: '/admin/ai', label: 'AI operations', icon: Bot, permission: 'ai_budget.read' },
  { href: '/admin/platform', label: 'Feature flags', icon: Flag, permission: 'feature_flags.read' },
  { href: '/admin/broadcasts', label: 'Broadcasts', icon: Bell, permission: 'broadcasts.create' },
  { href: '/admin/audit', label: 'Audit', icon: FileText, permission: 'audit.read' },
  { href: '/admin/access', label: 'Access', icon: ShieldCheck, permission: 'admin_members.read' },
]

export function AdminShell({ children, permissions, roleKey }: { children: ReactNode; permissions: readonly string[]; roleKey: string }) {
  const pathname = usePathname()
  return (
    <div className="admin-shell">
      <aside className="admin-sidebar">
        <Link href="/admin" className="admin-brand"><span>ApplyMate</span><small>Internal Admin</small></Link>
        <nav aria-label="Admin navigation" className="admin-nav">
          {navigation.filter((item) => permissions.includes(item.permission)).map((item) => {
            const active = item.href === '/admin' ? pathname === '/admin' : pathname.startsWith(item.href)
            const Icon = item.icon
            return <Link key={item.href} href={item.href} data-active={active} className="admin-nav-link"><Icon size={18} aria-hidden="true" />{item.label}</Link>
          })}
        </nav>
        <div className="admin-identity"><span className="admin-avatar">{roleKey.slice(0, 2).toUpperCase()}</span><div><strong>{roleKey.replaceAll('_', ' ')}</strong><small>Internal role</small></div></div>
      </aside>
      <main className="admin-main">{children}</main>
    </div>
  )
}
