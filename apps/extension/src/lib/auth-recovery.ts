export function isAuthFailure(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'status' in error
    ? (error as { status?: unknown }).status === 401
    : /unauthorized|session expired|account unavailable/i.test(error instanceof Error ? error.message : String(error))
}

export function isApplyMateDashboardUrl(rawUrl: string | undefined): boolean {
  if (!rawUrl) return false
  try {
    const url = new URL(rawUrl)
    return url.protocol === 'https:' && url.hostname === 'applymate.site'
  } catch {
    return false
  }
}
import type { ExtensionSettings } from './types'


type AccountIdentity = { apiBaseUrl?: unknown; userEmail?: unknown }

export function isSameRecoveryAccount(before: AccountIdentity | undefined, after: AccountIdentity | null | undefined): boolean {
  const email = typeof before?.userEmail === 'string' ? before.userEmail.trim().toLowerCase() : ''
  return Boolean(email) && typeof before?.apiBaseUrl === 'string' && before.apiBaseUrl === after?.apiBaseUrl &&
    typeof after?.userEmail === 'string' && email === after.userEmail.trim().toLowerCase()
}

/** A refreshed token may replay a request only for its original, identified account. */
export async function withAccountAuthRecovery<T>(
  settings: ExtensionSettings,
  refresh: () => Promise<ExtensionSettings | null>,
  operation: (selected: ExtensionSettings) => Promise<T>,
): Promise<T> {
  let selected = settings
  if (!selected.apiToken) {
    const connected = await refresh()
    if (!connected?.apiToken) throw new Error('Not logged in — open the ApplyMate dashboard or extension popup to log in first')
    if (!isSameRecoveryAccount(selected, connected)) {
      // Login state is now available to the UI. The user must confirm that
      // account with a new action before this pending payload can be sent.
      throw new Error('ApplyMate account connected or changed. Check the selected account in the extension, then try this action again.')
    }
    selected = connected
  }

  try {
    return await operation(selected)
  } catch (error) {
    if (!isAuthFailure(error)) throw error
    const refreshed = await refresh()
    if (!refreshed?.apiToken || refreshed.apiToken === selected.apiToken || !isSameRecoveryAccount(selected, refreshed)) throw error
    return operation(refreshed)
  }
}
