/**
 * GET /api/me/api-keys
 * PUT /api/me/api-keys
 *
 * Stores user-provided discovery API keys. GET never returns secret values.
 */
import { NextRequest } from 'next/server'
import { requireAuth, isErrorResponse, ok, err } from '@/lib/api-helpers'
import { db } from '@/lib/db'
import { getDiscoveryApiKeys } from '@/lib/discovery-api-keys'

type ApiKeyPatch = {
  adzunaAppId?: string | null
  adzunaAppKey?: string | null
  rapidapiKey?: string | null
}

type ApiKeyTestRequest = { action?: 'test'; provider?: 'adzuna' | 'rapidapi' }

function normalize(value: unknown): string | null | undefined {
  if (value === null) return null
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed ? trimmed : undefined
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

  if (adzunaAppId !== undefined) data.adzunaAppId = adzunaAppId
  if (adzunaAppKey !== undefined) data.adzunaAppKey = adzunaAppKey
  if (rapidapiKey !== undefined) data.rapidapiKey = rapidapiKey

  if (Object.keys(data).length === 0) return err('No API keys provided')

  const saved = await db.userApiKeys.upsert({
    where:  { userId: auth.userId },
    create: { userId: auth.userId, ...data },
    update: data,
  })

  return ok({
    hasAdzuna:   Boolean(saved.adzunaAppId && saved.adzunaAppKey),
    hasRapidapi: Boolean(saved.rapidapiKey),
  })
}

async function testConnection(req: NextRequest, body: ApiKeyTestRequest) {
  const auth = await requireAuth(req)
  if (isErrorResponse(auth)) return auth
  if (body.provider !== 'adzuna' && body.provider !== 'rapidapi') return err('Choose Adzuna or RapidAPI to test')

  const keys = await getDiscoveryApiKeys(auth.userId)
  if (body.provider === 'adzuna') {
    if (!keys.adzunaAppId || !keys.adzunaAppKey) return err('Save both Adzuna credentials before testing')
    const params = new URLSearchParams({ app_id: keys.adzunaAppId, app_key: keys.adzunaAppKey, results_per_page: '1', what: 'software engineer' })
    const response = await fetch(`https://api.adzuna.com/v1/api/jobs/gb/search/1?${params}`, { cache: 'no-store' }).catch(() => null)
    if (!response?.ok) return err(`Adzuna rejected the credentials (${response?.status ?? 'network error'})`)
  } else {
    if (!keys.rapidapiKey) return err('Save your RapidAPI key before testing')
    const response = await fetch('https://jsearch.p.rapidapi.com/search?query=software%20engineer&page=1&num_pages=1', {
      headers: { 'X-RapidAPI-Key': keys.rapidapiKey, 'X-RapidAPI-Host': 'jsearch.p.rapidapi.com' },
      cache: 'no-store',
    }).catch(() => null)
    if (!response?.ok) return err(`RapidAPI rejected the credentials (${response?.status ?? 'network error'})`)
  }

  return ok({ ok: true })
}

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req)
  if (isErrorResponse(auth)) return auth

  const keys = await db.userApiKeys.findUnique({
    where:  { userId: auth.userId },
    select: { adzunaAppId: true, adzunaAppKey: true, rapidapiKey: true },
  })

  return ok({
    hasAdzuna:   Boolean(keys?.adzunaAppId && keys?.adzunaAppKey),
    hasRapidapi: Boolean(keys?.rapidapiKey),
  })
}

export async function PUT(req: NextRequest) {
  return save(req)
}

export async function POST(req: NextRequest) {
  const body = await req.clone().json().catch(() => null) as ApiKeyTestRequest | null
  if (body?.action === 'test') return testConnection(req, body)
  return save(req)
}
