const DEVELOPMENT_FALLBACK = 'development-only-auth-secret'
const BUILD_FALLBACK = 'build-time-auth-secret-not-for-runtime'

function isProductionBuild() {
  return process.env.NEXT_PHASE === 'phase-production-build'
}

export function getAuthSecret() {
  const secret = process.env.AUTH_SECRET
  if (secret) return secret
  // Next imports route modules while collecting build metadata. The server
  // process loads this module again at request time, where production remains
  // fail-closed when AUTH_SECRET is missing.
  if (isProductionBuild()) return BUILD_FALLBACK
  if (process.env.NODE_ENV === 'production') throw new Error('AUTH_SECRET must be configured in production')
  return DEVELOPMENT_FALLBACK
}

export function getAuthJwtSecret() {
  return new TextEncoder().encode(getAuthSecret())
}
