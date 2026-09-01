import { redirect } from 'next/navigation'
import { AdminSecurityPage } from '@/components/admin/AdminSecurityPage'
import { isAdminResponse, requireAdminMembership } from '@/lib/admin/authorization'

export default async function SecurityAdminPage() {
  const actor = await requireAdminMembership()
  if (isAdminResponse(actor)) redirect('/login?callbackUrl=/admin/security')
  return <AdminSecurityPage canRequest={actor.permissions.includes('break_glass.request')} canApprove={actor.permissions.includes('break_glass.approve')} />
}
