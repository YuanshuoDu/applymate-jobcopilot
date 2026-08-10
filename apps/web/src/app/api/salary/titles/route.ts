/**
 * GET /api/salary/titles?query=developer&country=de
 * Returns valid job title suggestions for the salary API
 * (used to map fuzzy titles → canonical titles before calling /salary/range).
 */
import { NextRequest } from 'next/server'
import { pinnedFetch } from '@jobcopilot/shared'
import { requireAuth, isErrorResponse, ok, err } from '@/lib/api-helpers'
import { DISCOVERY_KEY_ERROR_MESSAGES, getDiscoveryApiKeys } from '@/lib/discovery-api-keys'

const HOST = 'jobs-api14.p.rapidapi.com'

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req)
  if (isErrorResponse(auth)) return auth

  const { rapidapiKey: apiKey } = await getDiscoveryApiKeys(auth.userId)
  if (!apiKey) return err(DISCOVERY_KEY_ERROR_MESSAGES.rapidapi, 501)

  const { searchParams } = req.nextUrl
  const query   = searchParams.get('query')?.trim()
  const country = (searchParams.get('country') ?? 'us').toLowerCase()
  if (!query) return err('query is required')

  const params = new URLSearchParams({ query, countryCode: country })

  let raw: Response
  try {
    raw = await pinnedFetch(`https://${HOST}/v2/salary/titles?${params}`, {
      headers: { 'x-rapidapi-key': apiKey, 'x-rapidapi-host': HOST },
      cache: 'no-store',
    })
  } catch { return err('Failed to reach salary API', 502) }

  if (!raw.ok) {
    const msg = await raw.text().catch(() => raw.statusText)
    return err(`Salary API error ${raw.status}: ${msg.slice(0, 200)}`, 502)
  }

  const json = await raw.json() as {
    data?: { jobTitles?: Array<{ jobTitle: string; count: number }> }
  }

  return ok({ titles: json.data?.jobTitles ?? [] })
}
