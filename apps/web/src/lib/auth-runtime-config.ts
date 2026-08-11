type AuthEnvironment = Readonly<Record<string, string | undefined>>

const ORIGIN_OVERRIDE_KEYS = ['AUTH_URL', 'NEXTAUTH_URL'] as const

function deployedOnVercel(environment: AuthEnvironment): boolean {
  return environment.VERCEL === '1'
    || environment.VERCEL_ENV === 'production'
    || environment.VERCEL_ENV === 'preview'
}

export function authOriginOverrideError(environment: AuthEnvironment = process.env): string | null {
  if (!deployedOnVercel(environment)) return null
  const configured = ORIGIN_OVERRIDE_KEYS.filter(key => Boolean(environment[key]?.trim()))
  if (configured.length === 0) return null
  return `${configured.join(' and ')} must be unset on Vercel so Auth.js uses the request host for public and administrator sessions.`
}

export function assertNoAuthOriginOverride(environment: AuthEnvironment = process.env): void {
  const error = authOriginOverrideError(environment)
  if (error) throw new Error(error)
}
