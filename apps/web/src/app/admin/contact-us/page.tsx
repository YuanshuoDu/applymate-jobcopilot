import { redirect } from 'next/navigation'
import { ContactUsPage } from '@/components/admin/ContactUsPage'
import { isAdminResponse, requireAdmin } from '@/lib/admin/authorization'

export default async function ContactUsAdminPage() {
  const actor = await requireAdmin('support_cases.read')
  if (isAdminResponse(actor)) redirect('/login?callbackUrl=/admin/contact-us')
  return <ContactUsPage />
}
