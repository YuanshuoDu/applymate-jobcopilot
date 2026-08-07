import { redirect } from 'next/navigation'
import { AdminPlatformPage } from '@/components/admin/AdminPlatformPage'
import { isAdminResponse, requireAdmin } from '@/lib/admin/authorization'

export default async function PlatformAdminPage() {
  const actor = await requireAdmin('feature_flags.read')
  if (isAdminResponse(actor)) redirect('/login?callbackUrl=/admin/platform')
  return <AdminPlatformPage permissions={actor.permissions} />
}
