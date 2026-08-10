const DEVELOPMENT_FALLBACK = 'development-only-auth-secret'
const BUILD_FALLBACK = 'build-time-auth-secret-not-for-runtime'

export const EXTENSION_TOKEN_ISSUER = 'applymate-extension'
export const EXTENSION_TOKEN_AUDIENCE = 'applymate-extension'

function isProductionBuild() {
  return process.env.NEXT_PHASE === 'phase-production-build'
}

export function getAuthSecret() {
  // AUTH_SECRET is Auth.js v5's supported name. NEXTAUTH_SECRET remains an
  // explicit compatibility path for deployments created before the v5 rename.
  const secret = process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET
  if (secret) return secret
  // Next imports route modules while collecting build metadata. The server
  // process loads this module again at request time, where production remains
  // fail-closed when AUTH_SECRET is missing.
  if (isProductionBuild()) return BUILD_FALLBACK
  if (process.env.NODE_ENV === 'production') {
    throw new Error('AUTH_SECRET or NEXTAUTH_SECRET must be configured in production')
  }
  return DEVELOPMENT_FALLBACK
}

export function getAuthJwtSecret() {
  return new TextEncoder().encode(getAuthSecret())
}
