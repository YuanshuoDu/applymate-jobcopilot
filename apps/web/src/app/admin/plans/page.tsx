import { ErrorBoundary } from '@/components/ErrorBoundary'
import { PlanManagementPage } from '@/components/pages/PlanManagementPage'

export default function AdminPlansRoute() {
  return (
    <ErrorBoundary>
      <PlanManagementPage />
    </ErrorBoundary>
  )
}
