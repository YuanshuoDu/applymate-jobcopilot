import { redirect } from 'next/navigation'
import { AdminAuditPage } from '@/components/admin/OperationsPages'
import { isAdminResponse, requireAdmin } from '@/lib/admin/authorization'

export default async function AuditAdminPage() {
  const actor = await requireAdmin('audit.read')
  if (isAdminResponse(actor)) redirect('/login?callbackUrl=/admin/audit')
  return <AdminAuditPage />
}
