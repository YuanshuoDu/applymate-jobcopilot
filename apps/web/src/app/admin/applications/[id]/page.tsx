import { redirect } from 'next/navigation'
import { AdminApplicationDetailPage } from '@/components/admin/AdminApplicationDetailPage'
import { isAdminResponse, requireAdmin } from '@/lib/admin/authorization'

export default async function ApplicationDetailAdminPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requireAdmin('applications.read')
  if (isAdminResponse(actor)) redirect('/login?callbackUrl=/admin/applications')
  return <AdminApplicationDetailPage applicationId={(await params).id} permissions={actor.permissions} />
}
