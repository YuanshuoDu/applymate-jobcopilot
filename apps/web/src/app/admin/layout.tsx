import { redirect } from 'next/navigation'
import { AdminShell } from '@/components/admin/AdminShell'
import { isAdminResponse, requireAdminMembership } from '@/lib/admin/authorization'
import './admin.css'

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const actor = await requireAdminMembership()
  if (isAdminResponse(actor)) redirect('/login?callbackUrl=/admin')
  return <AdminShell permissions={actor.permissions} roleKey={actor.roleKey}>{children}</AdminShell>
}
