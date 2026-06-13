import { ErrorBoundary } from '@/components/ErrorBoundary'
import { ObservabilityPage } from '@/components/pages/ObservabilityPage'

export default function AdminObservabilityRoute() {
  return (
    <ErrorBoundary>
      <ObservabilityPage />
    </ErrorBoundary>
  )
}
