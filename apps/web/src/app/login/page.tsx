import { Suspense } from 'react'
import { LoginPage } from '@/components/auth/LoginPage'
import { redirect } from 'next/navigation'
import { auth } from '@/lib/auth'
import { LoadingShell } from '@/components/LoadingShell'

export default async function Page() {
  const session = await auth()
  if (session?.user) redirect('/')
  return (
    <Suspense fallback={<LoadingShell text="Loading login…" />}>
      <LoginPage />
    </Suspense>
  )
}
