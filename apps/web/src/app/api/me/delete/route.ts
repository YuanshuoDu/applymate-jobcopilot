/**
 * DELETE /api/me/delete — permanently delete the current user's account and all data
 *
 * Body (optional): { confirmation: string } — must be the user's email to confirm
 */
import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, isErrorResponse, ok, err } from '@/lib/api-helpers'

export async function DELETE(req: NextRequest) {
  const auth = await requireAuth(req)
  if (isErrorResponse(auth)) return auth

  const body = await req.json().catch(() => null)
  const confirmation = typeof body?.confirmation === 'string' ? body.confirmation : ''

  // Fetch user to verify
  const user = await db.user.findUnique({
    where: { id: auth.userId },
    select: { email: true },
  })

  if (!user) return err('User not found', 404)

  // Require email confirmation
  if (!confirmation.trim() || confirmation.trim().toLowerCase() !== user.email.trim().toLowerCase()) {
    return err('Must provide your email as confirmation', 400)
  }

  // Delete the user — cascade takes care of Account, Session, Job, Resume, Activity, AgentConfig
  await db.user.delete({ where: { id: auth.userId } })

  return ok({ message: 'Account permanently deleted' })
}
