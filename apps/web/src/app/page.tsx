import { safeAuth } from '@/lib/safe-auth'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { AppShell } from '@/components/layout/AppShell'
import { LandingPage } from '@/components/landing/LandingPage'

export const dynamic = 'force-dynamic'

export default async function Home() {
  const session = await safeAuth()

  if (!session?.user) {
    return <LandingPage />
  }

  return (
    <ErrorBoundary>
      <AppShell />
    </ErrorBoundary>
  )
}
