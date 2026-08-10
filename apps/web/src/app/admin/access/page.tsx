import { redirect } from 'next/navigation'
import { AdminAccessPage } from '@/components/admin/AdminAccessPage'
import { isAdminResponse, requireAdmin } from '@/lib/admin/authorization'

export default async function AccessAdminPage() {
  const actor = await requireAdmin('admin_members.read')
  if (isAdminResponse(actor)) redirect('/login?callbackUrl=/admin/access')
  return <AdminAccessPage canRevoke={actor.permissions.includes('sessions.revoke')} canManage={actor.permissions.includes('admin_members.manage')} canManageRoles={actor.permissions.includes('admin_roles.manage')} canReview={actor.permissions.includes('admin_access_reviews.manage')} canManageWebAuthn={actor.permissions.includes('security.webauthn.manage')} />
}
