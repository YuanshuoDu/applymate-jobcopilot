import { redirect } from 'next/navigation'
import { AdminOverview } from '@/components/admin/AdminOverview'
import { isAdminResponse, requireAdmin } from '@/lib/admin/authorization'

export default async function AdminPage() {
  const actor = await requireAdmin('observability.read')
  if (isAdminResponse(actor)) redirect('/login?callbackUrl=/admin')
  return <AdminOverview />
}
