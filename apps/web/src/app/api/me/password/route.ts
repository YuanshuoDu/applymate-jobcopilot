/**
 * PATCH /api/me/password
 *
 * Body: { currentPassword: string, newPassword: string }
 */
import { NextRequest } from 'next/server'
import bcrypt from 'bcryptjs'
import { db } from '@/lib/db'
import { requireAuth, isErrorResponse, ok, err } from '@/lib/api-helpers'

export async function PATCH(req: NextRequest) {
  const auth = await requireAuth()
  if (isErrorResponse(auth)) return auth

  const body = await req.json().catch(() => null)
  if (!body) return err('Invalid JSON body')

  const { currentPassword, newPassword } = body as {
    currentPassword: string
    newPassword: string
  }

  if (!currentPassword || !newPassword) return err('currentPassword and newPassword are required')
  if (newPassword.length < 8) return err('New password must be at least 8 characters')

  // Verify current password
  const user = await db.user.findUnique({ where: { id: auth.userId } })
  if (!user || !user.password) return err('Cannot change password — account uses OAuth')

  const valid = await bcrypt.compare(currentPassword, user.password)
  if (!valid) return err('Current password is incorrect')

  // Hash and update
  const hashed = await bcrypt.hash(newPassword, 12)
  await db.user.update({
    where: { id: auth.userId },
    data: { password: hashed },
  })

  return ok({ message: 'Password updated' })
}
