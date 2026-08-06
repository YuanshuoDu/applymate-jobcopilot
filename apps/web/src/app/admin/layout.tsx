import React, { type ReactNode } from 'react'
import { requireAdmin } from '@/lib/admin/authorization'
import { AdminShell } from '@/components/admin/AdminShell'

export const dynamic = 'force-dynamic'

export default async function AdminLayout({ children }: { children: ReactNode }) {
  try {
    const actor = await requireAdmin('admin_members.read')
    return <AdminShell actor={actor}>{children}</AdminShell>
  } catch {
    return <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24, background: '#f4f7fb', color: '#172033' }}><section role="alert" style={{ maxWidth: 420, padding: 24, background: '#fff', border: '1px solid #d9e2ec', borderRadius: 8 }}><h1 style={{ margin: '0 0 8px', fontSize: 20 }}>Access denied</h1><p style={{ margin: 0, color: '#5b6b80' }}>This administrator session is not active or does not have access to the console.</p></section></main>
  }
}
