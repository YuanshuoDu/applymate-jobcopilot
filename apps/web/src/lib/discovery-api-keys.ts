import { db } from '@/lib/db'

export type DiscoveryApiKeys = {
  adzunaAppId: string
  adzunaAppKey: string
  rapidapiKey: string
}

function firstConfigured(userValue?: string | null, platformValue?: string): string {
  return userValue?.trim() || platformValue?.trim() || ''
}

/** Prefer a user's saved discovery credentials, with platform credentials as fallback. */
export async function getDiscoveryApiKeys(userId: string): Promise<DiscoveryApiKeys> {
  const saved = await db.userApiKeys.findUnique({
    where: { userId },
    select: { adzunaAppId: true, adzunaAppKey: true, rapidapiKey: true },
  }).catch(() => null)

  return {
    adzunaAppId: firstConfigured(saved?.adzunaAppId, process.env.ADZUNA_APP_ID),
    adzunaAppKey: firstConfigured(saved?.adzunaAppKey, process.env.ADZUNA_APP_KEY),
    rapidapiKey: firstConfigured(saved?.rapidapiKey, process.env.RAPIDAPI_KEY),
  }
}
