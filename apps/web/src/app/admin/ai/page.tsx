import { redirect } from 'next/navigation'
import { AdminAiPage } from '@/components/admin/OperationsPages'
import { isAdminResponse, requireAdmin } from '@/lib/admin/authorization'

export default async function AiAdminPage() {
  const actor = await requireAdmin('ai_budget.read')
  if (isAdminResponse(actor)) redirect('/login?callbackUrl=/admin/ai')
  return <AdminAiPage permissions={actor.permissions} />
}
