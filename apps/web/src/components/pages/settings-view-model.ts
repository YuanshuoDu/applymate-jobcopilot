export type SettingsTab = 'profile' | 'appearance' | 'accounts' | 'apiKeys' | 'billing' | 'notifs' | 'privacy'

export const SETTINGS_TABS: readonly SettingsTab[] = [
  'profile', 'appearance', 'accounts', 'apiKeys', 'billing', 'notifs', 'privacy',
]

export const EXTENSION_SETUP_HREF =
  'https://github.com/YuanshuoDu/applymate-jobcopilot/blob/main/apps/extension/EXTENSION_SETUP.md'

export function gmailOAuthStartHref(transfer = false): string {
  const params = new URLSearchParams({
    returnTo: '/?page=settings&tab=accounts',
  })
  if (transfer) params.set('transfer', '1')
  return `/api/gmail/oauth/start?${params.toString()}`
}

export function parseSettingsTab(value: string | null | undefined): SettingsTab {
  return SETTINGS_TABS.includes(value as SettingsTab) ? value as SettingsTab : 'profile'
}

export function settingsTabFromHref(href: string): SettingsTab {
  try {
    return parseSettingsTab(new URL(href, 'https://applymate.invalid').searchParams.get('tab'))
  } catch {
    return 'profile'
  }
}

export function secretInputValue(saved: string, draft: string | undefined): string {
  return draft === undefined ? saved : draft
}

export function hasPendingSecretClear(saved: string, draft: string | undefined): boolean {
  return Boolean(saved) && draft === ''
}

export function discoveryKeyClearPatch(provider: 'adzuna' | 'rapidapi'): Record<string, null> {
  return provider === 'adzuna'
    ? { adzunaAppId: null, adzunaAppKey: null }
    : { rapidapiKey: null }
}

export type DiscoveryStatusView = {
  hasAdzuna?: boolean
  hasRapidapi?: boolean
  userHasAdzuna?: boolean
  userHasRapidapi?: boolean
  adzunaSource?: 'user' | 'platform' | 'incomplete' | 'none'
  rapidapiSource?: 'user' | 'platform' | 'incomplete' | 'none'
  needsAdzunaPair?: boolean
}

export function hasSavedDiscoveryKey(status: DiscoveryStatusView, provider: 'adzuna' | 'rapidapi'): boolean {
  return provider === 'adzuna' ? Boolean(status.userHasAdzuna) : Boolean(status.userHasRapidapi)
}

export function discoveryKeyStatusText(status: DiscoveryStatusView, provider: 'adzuna' | 'rapidapi'): string {
  if (provider === 'adzuna' && status.needsAdzunaPair) return 'incomplete — App ID + App Key required'
  const ready = provider === 'adzuna' ? Boolean(status.hasAdzuna) : Boolean(status.hasRapidapi)
  if (!ready) return 'not configured'
  const source = provider === 'adzuna' ? status.adzunaSource : status.rapidapiSource
  return source === 'platform'
    ? 'platform fallback · ready'
    : provider === 'adzuna' ? 'your credentials · ready' : 'your key · ready'
}

export function settingsTabHref(tab: SettingsTab, href: string): string {
  const url = new URL(href)
  url.searchParams.set('tab', tab)
  return url.toString()
}

export function settingsExportFilename(date: Date): string {
  return `applymate-data-${date.toISOString().slice(0, 10)}.json`
}

export function matchesEmailConfirmation(input: string, expected: string): boolean {
  return input.trim().toLowerCase() === expected.trim().toLowerCase()
}

export function billingSupportHref(address: string, action: string): string {
  return `mailto:${address}?subject=${encodeURIComponent(`ApplyMate billing: ${action}`)}`
}

export function billingStatusText(interval: string | undefined, plan: string | undefined): {
  label: string
  detail: string
} {
  const isFree = interval === 'forever' || plan === 'free'
  return isFree
    ? { label: 'Free plan', detail: 'No recurring billing configured' }
    : { label: 'Plan assigned', detail: 'Billing managed by support' }
}
