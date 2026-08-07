import { redirect } from 'next/navigation'

/** Stable admin entry point; the API guard on the destination remains authoritative. */
export default function AdminHomeRoute() {
  redirect('/admin/observability')
}
