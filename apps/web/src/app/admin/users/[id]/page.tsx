import { redirect } from 'next/navigation'
import { AdminUserDetailPage } from '@/components/admin/AdminUserDetailPage'
import { isAdminResponse, requireAdmin } from '@/lib/admin/authorization'

export default async function UserDetailAdminPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requireAdmin('users.read')
  if (isAdminResponse(actor)) redirect('/login?callbackUrl=/admin/users')
  const { id } = await params
  return <AdminUserDetailPage userId={id} />
}
