import { NextRequest } from 'next/server'
import { requireAuth, isErrorResponse, ok, err } from '@/lib/api-helpers'
import { listDiscoveryPersonaFacts, setDiscoveryPersonaFactConsent } from '@/lib/persona-facts'

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req)
  if (isErrorResponse(auth)) return auth
  const response = ok({ facts: await listDiscoveryPersonaFacts(auth.userId) })
  response.headers.set('Cache-Control', 'private, no-store')
  return response
}

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req)
  if (isErrorResponse(auth)) return auth
  const body = await req.json().catch(() => null)
  if (!body || typeof body.factId !== 'string' || typeof body.key !== 'string' ||
    typeof body.expectedValue !== 'string' || typeof body.expectedNormalizedValue !== 'string' ||
    typeof body.expectedUpdatedAt !== 'string' || typeof body.enabled !== 'boolean') {
    return err('Invalid discovery consent request')
  }
  const result = await setDiscoveryPersonaFactConsent(auth.userId, {
    factId: body.factId, key: body.key, expectedValue: body.expectedValue,
    expectedNormalizedValue: body.expectedNormalizedValue, expectedUpdatedAt: body.expectedUpdatedAt,
    enabled: body.enabled,
  })
  if (result.kind === 'not_found') return err('persona_fact_not_found', 404)
  if (result.kind === 'stale') return err('persona_fact_stale', 409)
  const response = ok({ fact: result.fact })
  response.headers.set('Cache-Control', 'private, no-store')
  return response
}
