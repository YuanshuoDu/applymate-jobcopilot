import { Suspense } from 'react'
import { LoginPage } from '@/components/auth/LoginPage'
import { redirect } from 'next/navigation'
import { headers } from 'next/headers'
import { safeAuth } from '@/lib/safe-auth'
import { LoadingShell } from '@/components/LoadingShell'
import { isAdminHost } from '@/lib/host-routing'

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ switchAccount?: string; error?: string }>
}) {
  const { switchAccount } = await searchParams
  const session = await safeAuth()
  const requestHost = (await headers()).get('host') ?? ''
  const adminHost = isAdminHost(requestHost)
  const allowAccountSwitch = switchAccount === '1'
  if (session?.user && !allowAccountSwitch && !adminHost) redirect('/')
  return (
    <Suspense fallback={<LoadingShell text="Loading login…" />}>
      <LoginPage
        switchAccount={allowAccountSwitch || (adminHost && Boolean(session?.user))}
        adminLogin={adminHost}
      />
    </Suspense>
  )
}
