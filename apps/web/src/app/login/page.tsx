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
  const hasAuthenticatedUser = Boolean(session?.user?.id?.trim())
  if (hasAuthenticatedUser && !allowAccountSwitch && !adminHost) redirect('/')
  return (
    <Suspense fallback={<LoadingShell />}>
      <LoginPage
        switchAccount={allowAccountSwitch || (adminHost && hasAuthenticatedUser)}
        adminLogin={adminHost}
      />
    </Suspense>
  )
}
