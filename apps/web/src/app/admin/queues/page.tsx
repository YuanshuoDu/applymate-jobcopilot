import { redirect } from 'next/navigation'
import { AdminQueuesPage } from '@/components/admin/AdminQueuesPage'
import { isAdminResponse, requireAdmin } from '@/lib/admin/authorization'

export default async function QueuesAdminPage() {
  const actor = await requireAdmin('queues.read')
  if (isAdminResponse(actor)) redirect('/login?callbackUrl=/admin/queues')
  return <AdminQueuesPage permissions={actor.permissions} />
}
