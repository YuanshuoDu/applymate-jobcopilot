const DEVELOPMENT_FALLBACK = 'development-only-auth-secret'

export function getAuthSecret() {
  const secret = process.env.AUTH_SECRET
  if (secret) return secret
  if (process.env.NODE_ENV === 'production') throw new Error('AUTH_SECRET must be configured in production')
  return DEVELOPMENT_FALLBACK
}

export function getAuthJwtSecret() {
  return new TextEncoder().encode(getAuthSecret())
}
