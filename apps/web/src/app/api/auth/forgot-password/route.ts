import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { err, ok } from '@/lib/api-helpers'
import {
  createPasswordResetToken,
  isValidEmail,
  normalizeEmail,
  passwordResetEmailConfigurationError,
  passwordResetExpiry,
  passwordResetIdentifier,
  passwordResetUrl,
  sendPasswordResetEmail,
  hashPasswordResetToken,
} from '@/lib/password-reset'
import { checkAuthRateLimit } from '@/lib/auth-rate-limit'

function emailFromBody(body: unknown): string {
  if (!body || typeof body !== 'object') return ''
  return normalizeEmail((body as Record<string, unknown>).email)
}

export async function POST(req: NextRequest) {
  const email = emailFromBody(await req.json().catch(() => null))
  if (!email) return err('email is required')
  if (!isValidEmail(email)) return err('Invalid email address')

  const rate = await checkAuthRateLimit(req, 'forgot-password', email, { ipLimit: 6, identityLimit: 3, windowMs: 15 * 60_000 })
  if (!rate.ok) return err(rate.unavailable ? 'Authentication service temporarily unavailable' : 'Too many requests — retry later', rate.unavailable ? 503 : 429)

  const configurationError = passwordResetEmailConfigurationError()
  if (configurationError) return err(configurationError, 503)

  try {
    const user = await db.user.findFirst({
      where: { email: { equals: email, mode: 'insensitive' } },
      select: { id: true },
    })

    // Keep the response identical for known and unknown accounts.
    if (!user) return ok({ ok: true })

    const token = createPasswordResetToken()
    const tokenHash = hashPasswordResetToken(token)
    const identifier = passwordResetIdentifier(user.id)

    await db.verificationToken.deleteMany({ where: { identifier } })
    await db.verificationToken.create({
      data: {
        identifier,
        token: tokenHash,
        expires: passwordResetExpiry(),
      },
    })

    const delivered = await sendPasswordResetEmail(email, passwordResetUrl(req.url, token))
    if (!delivered) {
      await db.verificationToken.deleteMany({
        where: { identifier, token: tokenHash },
      })
      return ok({ ok: true })
    }

    return ok({ ok: true })
  } catch {
    return err('Unable to create password reset request. Please try again later.', 500)
  }
}
