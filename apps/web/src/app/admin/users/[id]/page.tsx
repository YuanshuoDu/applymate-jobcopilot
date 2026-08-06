import { UsersPage } from '@/components/admin/UsersPage'

export default async function AdminUserDetailRoute({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return <UsersPage userId={id} />
}
