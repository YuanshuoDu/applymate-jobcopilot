import type { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { err, isErrorResponse, requireAuth } from '@/lib/api-helpers'

export type PricingAdminActor = { userId: string; email: string }

function envList(value: string | undefined): string[] {
  return (value ?? '').split(',').map(item => item.trim().toLowerCase()).filter(Boolean)
}

/** Pricing administration is deny-by-default and independent of candidate plan. */
export async function requirePricingAdmin(req?: NextRequest): Promise<PricingAdminActor | Response> {
  const auth = await requireAuth(req)
  if (isErrorResponse(auth)) return auth

  const user = await db.user.findUnique({
    where: { id: auth.userId },
    select: { id: true, email: true },
  })
  if (!user) return err('Admin identity not found', 403)

  const allowedIds = envList(process.env.ADMIN_USER_IDS)
  const allowedEmails = envList(process.env.ADMIN_EMAILS)
  if (!allowedIds.includes(user.id.toLowerCase()) && !allowedEmails.includes(user.email.toLowerCase())) {
    return err('Admin access denied', 403)
  }

  return { userId: user.id, email: user.email }
}
