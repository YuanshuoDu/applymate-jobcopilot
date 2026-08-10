/**
 * GET /api/me/api-keys
 * PUT /api/me/api-keys
 *
 * Stores user-provided discovery API keys. GET never returns secret values.
 */
import { NextRequest } from 'next/server'
import { pinnedFetch } from '@jobcopilot/shared'
import { requireAuth, isErrorResponse, ok, err } from '@/lib/api-helpers'
import { db } from '@/lib/db'
import { encryptDiscoveryApiKey, getDiscoveryApiKeyStatus, getDiscoveryApiKeys } from '@/lib/discovery-api-keys'

type ApiKeyPatch = {
  adzunaAppId?: string | null
  adzunaAppKey?: string | null
  rapidapiKey?: string | null
}

type ApiKeyTestRequest = { action?: 'test'; provider?: 'adzuna' | 'rapidapi' }
const MAX_KEY_LENGTH = 4096

function normalize(value: unknown): { value?: string | null; error?: string } {
  if (value === undefined) return { value: undefined }
  if (value === null) return { value: null }
  if (typeof value !== 'string') return { error: 'API keys must be strings or null' }
  const trimmed = value.trim()
  if (!trimmed) return { value: undefined }
  if (trimmed.length > MAX_KEY_LENGTH) return { error: 'API keys are too long' }
  return { value: trimmed }
}

async function save(req: NextRequest) {
  const auth = await requireAuth(req)
  if (isErrorResponse(auth)) return auth

  const body = await req.json().catch(() => null) as ApiKeyPatch | null
  if (!body || typeof body !== 'object') return err('Invalid JSON body')

  const data: ApiKeyPatch = {}
  const adzunaAppId = normalize(body.adzunaAppId)
  const adzunaAppKey = normalize(body.adzunaAppKey)
  const rapidapiKey = normalize(body.rapidapiKey)
  if (adzunaAppId.error || adzunaAppKey.error || rapidapiKey.error) {
    return err(adzunaAppId.error ?? adzunaAppKey.error ?? rapidapiKey.error ?? 'Invalid API key')
  }

  if (adzunaAppId.value !== undefined) data.adzunaAppId = adzunaAppId.value
  if (adzunaAppKey.value !== undefined) data.adzunaAppKey = adzunaAppKey.value
  if (rapidapiKey.value !== undefined) data.rapidapiKey = rapidapiKey.value

  if (Object.keys(data).length === 0) return err('No API keys provided')

  const encryptedData: Record<string, string | null> = {}
  for (const [field, value] of Object.entries(data) as Array<[keyof ApiKeyPatch, string | null | undefined]>) {
    if (value === null) {
      encryptedData[`${field}Enc`] = null
      continue
    }
    if (typeof value === 'string') encryptedData[`${field}Enc`] = await encryptDiscoveryApiKey(field, value)
  }

  await db.userApiKeys.upsert({
    where:  { userId: auth.userId },
    create: { userId: auth.userId, ...encryptedData },
    update: { ...encryptedData, ...Object.fromEntries(Object.keys(data).map(field => [field, null])) },
  })

  return ok(await getDiscoveryApiKeyStatus(auth.userId))
}

async function testConnection(req: NextRequest, body: ApiKeyTestRequest) {
  const auth = await requireAuth(req)
  if (isErrorResponse(auth)) return auth
  if (body.provider !== 'adzuna' && body.provider !== 'rapidapi') return err('Choose Adzuna or RapidAPI to test')

  const keys = await getDiscoveryApiKeys(auth.userId)
  if (body.provider === 'adzuna') {
    if (!keys.adzunaAppId || !keys.adzunaAppKey) return err('Save both Adzuna credentials before testing')
    const params = new URLSearchParams({ app_id: keys.adzunaAppId, app_key: keys.adzunaAppKey, results_per_page: '1', what: 'software engineer' })
    const response = await pinnedFetch(`https://api.adzuna.com/v1/api/jobs/gb/search/1?${params}`, { cache: 'no-store', signal: AbortSignal.timeout(10_000), redirect: 'error' }).catch(() => null)
    if (!response?.ok) return err(`Adzuna rejected the credentials (${response?.status ?? 'network error'})`)
  } else {
    if (!keys.rapidapiKey) return err('Save your RapidAPI key before testing')
    const response = await pinnedFetch('https://jsearch.p.rapidapi.com/search?query=software%20engineer&page=1&num_pages=1', {
      headers: { 'X-RapidAPI-Key': keys.rapidapiKey, 'X-RapidAPI-Host': 'jsearch.p.rapidapi.com' },
      cache: 'no-store',
      signal: AbortSignal.timeout(10_000),
      redirect: 'error',
    }).catch(() => null)
    if (!response?.ok) return err(`RapidAPI rejected the credentials (${response?.status ?? 'network error'})`)
  }

  return ok({ ok: true })
}

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req)
  if (isErrorResponse(auth)) return auth

  return ok(await getDiscoveryApiKeyStatus(auth.userId))
}

export async function PUT(req: NextRequest) {
  return save(req)
}

export async function POST(req: NextRequest) {
  const body = await req.clone().json().catch(() => null) as ApiKeyTestRequest | null
  if (body?.action === 'test') return testConnection(req, body)
  return save(req)
}
