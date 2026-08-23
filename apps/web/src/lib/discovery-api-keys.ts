import { db } from '@/lib/db'
import { decryptSecret, discoveryCredentialContext, encryptSecret } from '@/lib/credential-secrets'

export type DiscoveryApiKeys = {
  adzunaAppId: string
  adzunaAppKey: string
  rapidapiKey: string
  cleanJobDataApiKey: string
}

/** Shared user-facing guidance for discovery providers with missing credentials. */
export const DISCOVERY_KEY_ERROR_MESSAGES = {
  adzuna: 'Adzuna is not configured. Add both credentials in Settings → Keys & connections.',
  rapidapi: 'RapidAPI is not configured. Add a key in Settings → Keys & connections.',
} as const

export type DiscoveryKeySource = 'user' | 'platform' | 'incomplete' | 'none'

export type DiscoveryApiKeyStatus = {
  hasAdzuna: boolean
  hasRapidapi: boolean
  userHasAdzuna: boolean
  userHasRapidapi: boolean
  adzunaSource: DiscoveryKeySource
  rapidapiSource: DiscoveryKeySource
  needsAdzunaPair: boolean
}

export type DiscoverySavedKeys = {
  adzunaAppId?: string | null
  adzunaAppKey?: string | null
  rapidapiKey?: string | null
  adzunaAppIdEnc?: string | null
  adzunaAppKeyEnc?: string | null
  rapidapiKeyEnc?: string | null
} | null

function clean(value?: string | null): string {
  return value?.trim() ?? ''
}

function storedValue(plain?: string | null, encrypted?: string | null): string {
  return clean(plain) || clean(encrypted)
}

function hasPair(first: string, second: string): boolean {
  return Boolean(first && second)
}

function resolveKeys(saved: DiscoverySavedKeys): DiscoveryApiKeys {
  const userId = clean(saved?.adzunaAppId)
  const userKey = clean(saved?.adzunaAppKey)
  const hasUserAdzuna = Boolean(userId || userKey)

  // Never combine one user credential with one platform credential. A partial
  // user pair must remain incomplete and fail clearly at the source boundary.
  const adzunaAppId = hasUserAdzuna ? userId : clean(process.env.ADZUNA_APP_ID)
  const adzunaAppKey = hasUserAdzuna ? userKey : clean(process.env.ADZUNA_APP_KEY)
  const rapidapiKey = clean(saved?.rapidapiKey) || clean(process.env.RAPIDAPI_KEY)
  const cleanJobDataApiKey = clean(process.env.CLEANJOBDATA_API_KEY)

  return { adzunaAppId, adzunaAppKey, rapidapiKey, cleanJobDataApiKey }
}

/** Prefer a user's saved discovery credentials, with platform credentials as fallback. */
export async function getDiscoveryApiKeys(userId: string): Promise<DiscoveryApiKeys> {
  const saved = await db.userApiKeys.findUnique({
    where: { userId },
    select: {
      adzunaAppId: true, adzunaAppKey: true, rapidapiKey: true,
      adzunaAppIdEnc: true, adzunaAppKeyEnc: true, rapidapiKeyEnc: true,
    },
  }).catch(() => null)

  const decrypted = saved ? {
    adzunaAppId: await decryptSecret(saved.adzunaAppIdEnc ?? saved.adzunaAppId, discoveryCredentialContext('adzunaAppId')),
    adzunaAppKey: await decryptSecret(saved.adzunaAppKeyEnc ?? saved.adzunaAppKey, discoveryCredentialContext('adzunaAppKey')),
    rapidapiKey: await decryptSecret(saved.rapidapiKeyEnc ?? saved.rapidapiKey, discoveryCredentialContext('rapidapiKey')),
  } : null
  return resolveKeys(decrypted)
}

/** Return safe readiness/source metadata for the candidate/admin UI. */
export async function getDiscoveryApiKeyStatus(userId: string): Promise<DiscoveryApiKeyStatus> {
  const saved = await db.userApiKeys.findUnique({
    where: { userId },
    select: {
      adzunaAppId: true, adzunaAppKey: true, rapidapiKey: true,
      adzunaAppIdEnc: true, adzunaAppKeyEnc: true, rapidapiKeyEnc: true,
    },
  }).catch(() => null)

  return discoveryApiKeyStatusFromSaved(saved)
}

export async function encryptDiscoveryApiKey(field: 'adzunaAppId' | 'adzunaAppKey' | 'rapidapiKey', value: string): Promise<string> {
  return encryptSecret(value, discoveryCredentialContext(field))
}

export function discoveryApiKeyStatusFromSaved(saved: DiscoverySavedKeys): DiscoveryApiKeyStatus {
  const userIdValue = storedValue(saved?.adzunaAppId, saved?.adzunaAppIdEnc)
  const userKeyValue = storedValue(saved?.adzunaAppKey, saved?.adzunaAppKeyEnc)
  const userRapidValue = storedValue(saved?.rapidapiKey, saved?.rapidapiKeyEnc)
  const userHasAdzuna = Boolean(userIdValue || userKeyValue)
  const userHasRapidapi = Boolean(userRapidValue)
  const effective = resolveKeys({ adzunaAppId: userIdValue, adzunaAppKey: userKeyValue, rapidapiKey: userRapidValue })
  const platformAdzuna = hasPair(clean(process.env.ADZUNA_APP_ID), clean(process.env.ADZUNA_APP_KEY))
  const adzunaReady = hasPair(effective.adzunaAppId, effective.adzunaAppKey)
  const rapidReady = Boolean(effective.rapidapiKey)

  return {
    hasAdzuna: adzunaReady,
    hasRapidapi: rapidReady,
    userHasAdzuna,
    userHasRapidapi,
    adzunaSource: adzunaReady
      ? userHasAdzuna ? 'user' : platformAdzuna ? 'platform' : 'none'
      : userHasAdzuna ? 'incomplete' : 'none',
    rapidapiSource: rapidReady ? userHasRapidapi ? 'user' : 'platform' : 'none',
    needsAdzunaPair: userHasAdzuna && !hasPair(userIdValue, userKeyValue),
  }
}
