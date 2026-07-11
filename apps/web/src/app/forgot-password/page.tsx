import { redirect } from 'next/navigation'
import { safeAuth } from '@/lib/safe-auth'
import { ForgotPasswordPage } from '@/components/auth/ForgotPasswordPage'

export default async function Page() {
  const session = await safeAuth()
  if (session?.user) redirect('/')
  return <ForgotPasswordPage />
}
