import { redirect } from 'next/navigation'
import { AdminSecurityPage } from '@/components/admin/AdminSecurityPage'
import { isAdminResponse, requireAdmin } from '@/lib/admin/authorization'

export default async function SecurityAdminPage() {
  const actor = await requireAdmin('break_glass.request')
  if (isAdminResponse(actor)) redirect('/login?callbackUrl=/admin/security')
  return <AdminSecurityPage canApprove={actor.permissions.includes('break_glass.approve')} />
}
