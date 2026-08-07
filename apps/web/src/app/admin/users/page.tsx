import { ErrorBoundary } from '@/components/ErrorBoundary'
import { AdminUsersPage } from '@/components/pages/AdminUsersPage'

export default function AdminUsersRoute() {
  return (
    <ErrorBoundary>
      <AdminUsersPage />
    </ErrorBoundary>
  )
}
