export function userScopedStorageKey(prefix: string, userId: string | null | undefined): string | null {
  const normalizedUserId = userId?.trim()
  return normalizedUserId ? prefix + ':' + normalizedUserId : null
}
