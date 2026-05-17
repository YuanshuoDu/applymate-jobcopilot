import { redirect } from 'next/navigation'
import { auth } from '@/lib/auth'
import { ForgotPasswordPage } from '@/components/auth/ForgotPasswordPage'

export default async function Page() {
  const session = await auth()
  if (session?.user) redirect('/')
  return <ForgotPasswordPage />
}
