/**
 * DELETE /api/me/delete — permanently delete the current user's account and all data
 *
 * Body (optional): { confirmation: string } — must be the user's email to confirm
 */
import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, isErrorResponse, ok, err } from '@/lib/api-helpers'
import { deleteAccountWithSourceFence } from '@/lib/agent/account-delete-source-write'

export async function DELETE(req: NextRequest) {
  const auth = await requireAuth(req)
  if (isErrorResponse(auth)) return auth

  const body = await req.json().catch(() => null)
  const confirmation = typeof body?.confirmation === 'string' ? body.confirmation : ''

  const result = await deleteAccountWithSourceFence(db, auth.userId, confirmation)
  if (result === 'not_found') return err('User not found', 404)
  if (result === 'confirmation_required') return err('Must provide your email as confirmation', 400)

  return ok({ message: 'Account permanently deleted' })
}
