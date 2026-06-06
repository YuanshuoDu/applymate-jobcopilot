/**
 * GET /api/me/api-keys
 * PUT /api/me/api-keys
 *
 * Stores user-provided discovery API keys. GET never returns secret values.
 */
import { NextRequest } from 'next/server'
import { requireAuth, isErrorResponse, ok, err } from '@/lib/api-helpers'
import { db } from '@/lib/db'

type ApiKeyPatch = {
  adzunaAppId?: string | null
  adzunaAppKey?: string | null
  rapidapiKey?: string | null
}

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
  return save(req)
}
