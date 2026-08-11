import { NextRequest } from 'next/server'
import bcrypt from 'bcryptjs'
import { db } from '@/lib/db'
import { err, ok } from '@/lib/api-helpers'
import {
  hashPasswordResetToken,
  isValidPasswordResetToken,
  userIdFromPasswordResetIdentifier,
} from '@/lib/password-reset'
import { checkAuthRateLimit } from '@/lib/auth-rate-limit'

const MIN_PASSWORD_LENGTH = 8
const MAX_PASSWORD_LENGTH = 256

function parseBody(body: unknown): { token: string; password: string } | null {
  if (!body || typeof body !== 'object') return null
  const candidate = body as Record<string, unknown>
  if (typeof candidate.token !== 'string' || typeof candidate.password !== 'string') return null
  return { token: candidate.token, password: candidate.password }
}

export async function POST(req: NextRequest) {
  const body = parseBody(await req.json().catch(() => null))
  if (!body) return err('token and password are required')
  if (!isValidPasswordResetToken(body.token)) return err('Invalid or expired password reset link')
  if (body.password.length < MIN_PASSWORD_LENGTH) {
    return err(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`)
  }
  if (body.password.length > MAX_PASSWORD_LENGTH) {
    return err(`Password must be at most ${MAX_PASSWORD_LENGTH} characters`)
  }

  // bcrypt is intentionally expensive. Rate-limit before hashing so random
  // token probes cannot turn this unauthenticated endpoint into a CPU sink.
  const rate = await checkAuthRateLimit(req, 'reset-password', undefined, { ipLimit: 20, windowMs: 15 * 60_000 })
  if (!rate.ok) return err(rate.unavailable ? 'Authentication service temporarily unavailable' : 'Too many requests — retry later', rate.unavailable ? 503 : 429)

  const tokenHash = hashPasswordResetToken(body.token)

  try {
    const password = await bcrypt.hash(body.password, 12)
    const result = await db.$transaction(async tx => {
      const verificationToken = await tx.verificationToken.findUnique({
        where: { token: tokenHash },
        select: { identifier: true, expires: true },
      })
      const userId = verificationToken
        ? userIdFromPasswordResetIdentifier(verificationToken.identifier)
        : null

      if (!verificationToken || !userId || verificationToken.expires <= new Date()) {
        if (verificationToken) {
          await tx.verificationToken.deleteMany({ where: { token: tokenHash } })
        }
        return 'invalid'
      }

      const consumed = await tx.verificationToken.deleteMany({
        where: {
          identifier: verificationToken.identifier,
          token: tokenHash,
          expires: { gt: new Date() },
        },
      })
      if (consumed.count !== 1) return 'invalid'

      await tx.user.update({
        where: { id: userId },
        data: { password, authVersion: { increment: 1 } },
      })
      return 'updated'
    })

    if (result !== 'updated') return err('Invalid or expired password reset link')
    return ok({ ok: true })
  } catch {
    return err('Unable to reset password. Please request a new link and try again.', 500)
  }
}
