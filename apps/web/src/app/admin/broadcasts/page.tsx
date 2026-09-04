import { redirect } from 'next/navigation'
import { AdminBroadcastsPage } from '@/components/admin/AdminBroadcastsPage'
import { isAdminResponse, requireAdmin } from '@/lib/admin/authorization'

export default async function BroadcastsAdminPage() {
  const actor = await requireAdmin('broadcasts.create')
  if (isAdminResponse(actor)) redirect('/login?callbackUrl=/admin/broadcasts')
  return <AdminBroadcastsPage actorId={actor.userId} permissions={actor.permissions} />
}
