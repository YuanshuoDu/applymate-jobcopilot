import { auth } from '@/lib/auth'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { AppShell } from '@/components/layout/AppShell'
import { LandingPage } from '@/components/landing/LandingPage'

export default async function Home() {
  const session = await auth()

  if (!session?.user) {
    return <LandingPage />
  }

  return (
    <ErrorBoundary>
      <AppShell />
    </ErrorBoundary>
  )
}
