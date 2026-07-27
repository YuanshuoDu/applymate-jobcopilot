import { Suspense } from 'react'
import { LoginPage } from '@/components/auth/LoginPage'
import { redirect } from 'next/navigation'
import { safeAuth } from '@/lib/safe-auth'
import { LoadingShell } from '@/components/LoadingShell'

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ switchAccount?: string }>
}) {
  const { switchAccount } = await searchParams
  const session = await safeAuth()
  const allowAccountSwitch = switchAccount === '1'
  if (session?.user && !allowAccountSwitch) redirect('/')
  return (
    <Suspense fallback={<LoadingShell text="Loading login…" />}>
      <LoginPage switchAccount={allowAccountSwitch} />
    </Suspense>
  )
}
