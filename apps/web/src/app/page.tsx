import { safeAuth } from '@/lib/safe-auth'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { AppShell } from '@/components/layout/AppShell'
import { LandingPage } from '@/components/landing/LandingPage'
import { getPublicPlans } from '@/lib/plan-catalogue'

export const dynamic = 'force-dynamic'

export default async function Home() {
  const session = await safeAuth()

  // Auth.js's server helper may represent a rejected legacy JWT as an empty
  // user object. Only an issued application user id is an authenticated shell.
  if (!session?.user?.id?.trim()) {
    return <LandingPage plans={await getPublicPlans()} />
  }

  return (
    <ErrorBoundary>
      <AppShell />
    </ErrorBoundary>
  )
}
