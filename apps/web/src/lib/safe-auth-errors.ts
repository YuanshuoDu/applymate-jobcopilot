type ErrorLike = {
  cause?: unknown
  err?: unknown
  message?: unknown
  name?: unknown
  type?: unknown
}

function errorFragments(value: unknown, depth = 0): string[] {
  if (depth > 2 || value === null || typeof value !== 'object') {
    return typeof value === 'string' ? [value] : []
  }

  const error = value as ErrorLike
  const fragments = [error.name, error.type, error.message]
    .filter((fragment): fragment is string => typeof fragment === 'string')

  return [
    ...fragments,
    ...errorFragments(error.cause, depth + 1),
    ...errorFragments(error.err, depth + 1),
  ]
}

export function isRecoverableAuthSessionError(error: unknown): boolean {
  return errorFragments(error).some(fragment => {
    const value = fragment.toLowerCase()
    return value.includes('jwtsessionerror')
      || value.includes('no matching decryption secret')
  })
}

export function shouldSuppressAuthSessionErrorLog(
  error: unknown,
  environment: string | undefined,
): boolean {
  return environment === 'development'
    && errorFragments(error).some(fragment =>
      fragment.toLowerCase().includes('no matching decryption secret'),
    )
}
