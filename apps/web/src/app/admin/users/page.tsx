import { redirect } from 'next/navigation'
import { AdminUsersPage } from '@/components/admin/OperationsPages'
import { isAdminResponse, requireAdmin } from '@/lib/admin/authorization'

export default async function UsersAdminPage() {
  const actor = await requireAdmin('users.read')
  if (isAdminResponse(actor)) redirect('/login?callbackUrl=/admin/users')
  return <AdminUsersPage canExport={actor.permissions.includes('users.export_anonymized')} />
}
