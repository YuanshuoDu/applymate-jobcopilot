import { RegisterPage } from '@/components/auth/RegisterPage'
import { redirect } from 'next/navigation'
import { safeAuth } from '@/lib/safe-auth'

export default async function Page() {
  const session = await safeAuth()
  if (session?.user) redirect('/')
  return <RegisterPage />
}
