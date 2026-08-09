import { redirect } from 'next/navigation'
import { AdminDeletionQueuePage } from '@/components/admin/AdminDeletionQueuePage'
import { isAdminResponse, requireAdmin } from '@/lib/admin/authorization'

export default async function DeletionQueuePage() {
  const actor = await requireAdmin('users.deletion.manage')
  if (isAdminResponse(actor)) redirect('/login?callbackUrl=/admin/users/deletions')
  return <AdminDeletionQueuePage />
}
