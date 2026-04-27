import { ErrorBoundary } from '@/components/ErrorBoundary'
import { AppShell } from '@/components/layout/AppShell'

export default function Home() {
  return (
    <ErrorBoundary>
      <AppShell />
    </ErrorBoundary>
  )
}
