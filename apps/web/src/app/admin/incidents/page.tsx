import { redirect } from 'next/navigation'
import { AdminIncidentsPage } from '@/components/admin/AdminIncidentsPage'
import { isAdminResponse, requireAdmin } from '@/lib/admin/authorization'

export default async function AdminIncidentsRoute() {
  const actor = await requireAdmin('observability.read')
  if (isAdminResponse(actor)) redirect('/login?callbackUrl=/admin/incidents')
  return <AdminIncidentsPage canManage={actor.permissions.includes('incidents.manage')} />
}
