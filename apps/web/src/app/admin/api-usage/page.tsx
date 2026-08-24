import { redirect } from 'next/navigation'
import { AdminApiUsagePage } from '@/components/admin/AdminApiUsagePage'
import { isAdminResponse, requireAdmin } from '@/lib/admin/authorization'

export default async function ApiUsageAdminPage() {
  const actor = await requireAdmin('observability.read')
  if (isAdminResponse(actor)) redirect('/login?callbackUrl=/admin/api-usage')
  return <AdminApiUsagePage canUpdateJob={actor.permissions.includes('ats.update')} canUpdateAi={actor.permissions.includes('ai_budget.update')} />
}
