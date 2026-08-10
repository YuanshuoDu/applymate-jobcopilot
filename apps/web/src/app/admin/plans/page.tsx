import { redirect } from 'next/navigation'
import { PlanManagementPage } from '@/components/pages/PlanManagementPage'
import { isAdminResponse, requireAdmin } from '@/lib/admin/authorization'

export default async function AdminPlansRoute() {
  const actor = await requireAdmin('billing.read')
  if (isAdminResponse(actor)) redirect('/login?callbackUrl=/admin/plans')
  return <PlanManagementPage canUpdate={actor.permissions.includes('billing.update')} canViewObservability={actor.permissions.includes('observability.read')} />
}
