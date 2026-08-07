import { redirect } from 'next/navigation'
import { requireSettingsAdmin } from '@/lib/admin/settings-access'

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const actor = await requireSettingsAdmin()
  if (actor instanceof Response) redirect('/')
  return children
}
