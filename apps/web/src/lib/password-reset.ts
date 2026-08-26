import { trackedExternalApiFetch } from '@/lib/api-usage/external-api-usage'
import { createHash, randomBytes } from 'node:crypto'
import { normalizeEmail as normalizeAuthEmail } from '@/lib/auth-identifiers'
import { configuredAppOrigin } from '@/lib/app-url'

const PASSWORD_RESET_TOKEN_TTL_MS = 60 * 60 * 1000
const PASSWORD_RESET_IDENTIFIER_PREFIX = 'password-reset:'

export function normalizeEmail(value: unknown): string {
  return typeof value === 'string' ? normalizeAuthEmail(value) : ''
}

export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
}

export function passwordResetIdentifier(userId: string): string {
  return `${PASSWORD_RESET_IDENTIFIER_PREFIX}${userId}`
}

export function userIdFromPasswordResetIdentifier(identifier: string): string | null {
  if (!identifier.startsWith(PASSWORD_RESET_IDENTIFIER_PREFIX)) return null

  const userId = identifier.slice(PASSWORD_RESET_IDENTIFIER_PREFIX.length)
  return userId || null
}

export function createPasswordResetToken(): string {
  return randomBytes(32).toString('base64url')
}

export function hashPasswordResetToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export function passwordResetExpiry(now = Date.now()): Date {
  return new Date(now + PASSWORD_RESET_TOKEN_TTL_MS)
}

export function isValidPasswordResetToken(token: unknown): token is string {
  return typeof token === 'string' && /^[A-Za-z0-9_-]{32,128}$/.test(token)
}

export function configuredAppUrl(requestUrl: string): string {
  return configuredAppOrigin(requestUrl)
}

export function passwordResetUrl(requestUrl: string, token: string): string {
  const url = new URL('/reset-password', configuredAppUrl(requestUrl))
  url.searchParams.set('token', token)
  return url.toString()
}

export function passwordResetEmailConfigurationError(): string | null {
  if (process.env.RESEND_API_KEY?.trim() && process.env.EMAIL_FROM?.trim()) return null
  return 'Password reset email is not configured. Set RESEND_API_KEY and EMAIL_FROM.'
}

export async function sendPasswordResetEmail(email: string, resetUrl: string): Promise<boolean> {
  const apiKey = process.env.RESEND_API_KEY?.trim()
  const from = process.env.EMAIL_FROM?.trim()
  if (!apiKey || !from) return false

  try {
    const response = await trackedExternalApiFetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from,
        to: [email],
        subject: 'Reset your ApplyMate password',
        text: `Use this link to reset your ApplyMate password: ${resetUrl}\n\nThis link expires in 1 hour.`,
        html: `<p>Use the link below to reset your ApplyMate password.</p><p><a href="${resetUrl}">Reset password</a></p><p>This link expires in 1 hour.</p>`,
      }),
    }, { provider: 'resend', operation: 'password_reset', credentialSource: 'platform' })
    return response.ok
  } catch {
    return false
  }
}
