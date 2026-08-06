'use client'

import React, { type ReactNode } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { signOut } from 'next-auth/react'
import { Activity, BadgeDollarSign, Bot, ClipboardList, KeyRound, LayoutDashboard, LogOut, ShieldCheck, Users } from 'lucide-react'
import type { Permission } from '@/lib/admin/permissions'

export interface AdminShellActor {
  userId: string
  email?: string
  roleKey: string
  permissions: Permission[]
}

interface AdminNavItem {
  href: string
  label: string
  permission: Permission
  icon: ReactNode
}

const ADMIN_NAV: AdminNavItem[] = [
  { href: '/admin', label: 'Overview', permission: 'admin_members.read', icon: <LayoutDashboard size={16} aria-hidden="true" /> },
  { href: '/admin/access', label: 'Access', permission: 'admin_members.read', icon: <KeyRound size={16} aria-hidden="true" /> },
  { href: '/admin/users', label: 'Users', permission: 'users.read', icon: <Users size={16} aria-hidden="true" /> },
  { href: '/admin/plans', label: 'Plans', permission: 'billing.read', icon: <BadgeDollarSign size={16} aria-hidden="true" /> },
  { href: '/admin/ai', label: 'Platform AI', permission: 'ai_budget.read', icon: <Bot size={16} aria-hidden="true" /> },
  { href: '/admin/broadcasts', label: 'Broadcasts', permission: 'broadcasts.create', icon: <ClipboardList size={16} aria-hidden="true" /> },
  { href: '/admin/contact-us', label: 'Contact us', permission: 'support_cases.read', icon: <ShieldCheck size={16} aria-hidden="true" /> },
  { href: '/admin/observability', label: 'Observability', permission: 'observability.read', icon: <Activity size={16} aria-hidden="true" /> },
]

export function filterAdminNav(permissions: readonly string[]): AdminNavItem[] {
  const granted = new Set(permissions)
  return ADMIN_NAV.filter(item => granted.has(item.permission))
}

export function AdminShell({ actor, children }: { actor: AdminShellActor; children: ReactNode }) {
  const pathname = usePathname()
  const items = filterAdminNav(actor.permissions)
  return (
    <div className="admin-shell">
      <style>{`
        .admin-shell { min-height: 100vh; display: flex; background: #f4f7fb; color: #172033; }
        .admin-shell aside { width: 236px; flex: 0 0 236px; background: #10253f; color: #d9e6f5; padding: 20px 14px; display: flex; flex-direction: column; gap: 20px; }
        .admin-brand { color: #fff; font-weight: 750; letter-spacing: .01em; font-size: 16px; padding: 0 10px; }
        .admin-nav { display: grid; gap: 4px; }
        .admin-nav a { display: flex; align-items: center; gap: 10px; min-height: 38px; padding: 0 10px; color: #b7c9dc; text-decoration: none; border-radius: 6px; font-size: 13px; }
        .admin-nav a:hover, .admin-nav a[data-active="true"] { color: #fff; background: #1e3b5c; }
        .admin-identity { margin-top: auto; border-top: 1px solid rgba(255,255,255,.14); padding: 14px 10px 0; font-size: 11px; color: #9fb4ca; overflow: hidden; }
        .admin-identity strong { display: block; color: #fff; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-bottom: 4px; }
        .admin-signout { width: 100%; display: flex; align-items: center; gap: 8px; margin-top: 12px; padding: 8px 0; border: 0; color: #c2d0de; background: transparent; cursor: pointer; font: inherit; font-size: 12px; }
        .admin-signout:hover { color: #fff; }
        .admin-main { min-width: 0; flex: 1; padding: 28px; }
        @media (max-width: 720px) { .admin-shell { display: block; } .admin-shell aside { width: 100%; padding: 14px 12px; gap: 12px; } .admin-nav { display: flex; overflow-x: auto; padding-bottom: 2px; } .admin-nav a { flex: 0 0 auto; } .admin-identity { display: none; } .admin-main { padding: 16px; } }
      `}</style>
      <aside aria-label="Admin navigation">
        <div className="admin-brand">ApplyMate Admin</div>
        <nav className="admin-nav">
          {items.map(item => (
            <Link key={item.href} href={item.href} data-active={pathname === item.href || (item.href !== '/admin' && pathname.startsWith(`${item.href}/`))}>
              {item.icon}<span>{item.label}</span>
            </Link>
          ))}
        </nav>
        <div className="admin-identity">
          <strong>{actor.email || 'Administrator'}</strong>
          <span>{actor.roleKey}</span>
          <button type="button" className="admin-signout" onClick={() => void signOut({ callbackUrl: '/login' })}>
            <LogOut size={14} aria-hidden="true" /> Sign out
          </button>
        </div>
      </aside>
      <main className="admin-main">{children}</main>
    </div>
  )
}
