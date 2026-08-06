export type AdminWriteValidation =
  | { ok: true }
  | { ok: false; status: 403; code: 'CSRF_ORIGIN_MISMATCH' }

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

export function validateAdminWriteRequest(request: Request): AdminWriteValidation {
  if (SAFE_METHODS.has(request.method.toUpperCase())) return { ok: true }

  const configuredOrigin = originFrom(process.env.AUTH_CANONICAL_URL)
    ?? originFrom(process.env.NEXTAUTH_URL)
    ?? originFrom(request.url)
  const requestOrigin = request.headers.get('origin')
    ?? originFrom(request.headers.get('referer') ?? undefined)

  if (!configuredOrigin || requestOrigin !== configuredOrigin) {
    return { ok: false, status: 403, code: 'CSRF_ORIGIN_MISMATCH' }
  }

  return { ok: true }
}

function originFrom(value: string | undefined): string | null {
  if (!value) return null
  try {
    return new URL(value).origin
  } catch {
    return null
  }
}
