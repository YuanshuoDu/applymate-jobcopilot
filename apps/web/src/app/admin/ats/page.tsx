import { redirect } from 'next/navigation'
import { AdminAtsPage } from '@/components/admin/OperationsPages'
import { isAdminResponse, requireAdmin } from '@/lib/admin/authorization'

export default async function AtsAdminPage() {
  const actor = await requireAdmin('ats.read')
  if (isAdminResponse(actor)) redirect('/login?callbackUrl=/admin/ats')
  return <AdminAtsPage permissions={actor.permissions} />
}
