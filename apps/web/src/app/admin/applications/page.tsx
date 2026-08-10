import { redirect } from 'next/navigation'
import { AdminApplicationsPage } from '@/components/admin/OperationsPages'
import { isAdminResponse, requireAdmin } from '@/lib/admin/authorization'

export default async function ApplicationsAdminPage() {
  const actor = await requireAdmin('applications.read')
  if (isAdminResponse(actor)) redirect('/login?callbackUrl=/admin/applications')
  return <AdminApplicationsPage permissions={actor.permissions} />
}
