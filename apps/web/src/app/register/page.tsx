import { RegisterPage } from '@/components/auth/RegisterPage'
import { redirect } from 'next/navigation'
import { safeAuth } from '@/lib/safe-auth'
import { safeCallbackUrl } from '@/lib/auth-callback'

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ callbackUrl?: string }>
}) {
  const { callbackUrl } = await searchParams
  const session = await safeAuth()
  if (session?.user?.id?.trim()) redirect('/')
  return <RegisterPage callbackUrl={safeCallbackUrl(callbackUrl)} />
}
