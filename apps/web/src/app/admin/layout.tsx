import { redirect } from 'next/navigation'
import { headers } from 'next/headers'
import { AdminShell } from '@/components/admin/AdminShell'
import { isAdminResponse, requireAdminMembership } from '@/lib/admin/authorization'
import { isAdminHost, isLocalHost } from '@/lib/host-routing'
import './admin.css'

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const requestHost = (await headers()).get('host') ?? ''
  if (!isAdminHost(requestHost) && !isLocalHost(requestHost)) redirect('/')
  const actor = await requireAdminMembership()
  if (isAdminResponse(actor)) redirect('/login?callbackUrl=%2Fadmin&error=not_admin')
  return <AdminShell permissions={actor.permissions} roleKey={actor.roleKey}>{children}</AdminShell>
}
