import { NextRequest } from 'next/server'
import { requireAuth, ok, err, isErrorResponse } from '@/lib/api-helpers'
import { getPersonaProfile, personaContext } from '@/lib/persona'
import { isPersonaAllowedUse } from '@/lib/persona-facts'

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req)
  if (isErrorResponse(auth)) return auth

  const requestedUse = new URL(req.url).searchParams.get('use')
  const allowedUse = isPersonaAllowedUse(requestedUse) ? requestedUse : undefined
  if (requestedUse && !allowedUse) {
    return err('use must be form_fill, tailor, or cover_letter')
  }

  try {
    const profile = await getPersonaProfile(auth.userId, allowedUse)
    return privateOk({ persona: personaContext(profile), profile })
  } catch (e) {
    console.error('[/api/me/persona]', e)
    return err(`Failed to build persona: ${(e as Error).message}`, 500)
  }
}

function privateOk<T>(data: T) {
  const response = ok(data)
  response.headers.set('Cache-Control', 'private, no-store')
  return response
}
