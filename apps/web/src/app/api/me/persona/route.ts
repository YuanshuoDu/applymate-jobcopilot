import { NextRequest } from 'next/server'
import { requireAuth, ok, err, isErrorResponse } from '@/lib/api-helpers'
import { getPersonaProfile, personaContext } from '@/lib/persona'

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req)
  if (isErrorResponse(auth)) return auth

  try {
    const profile = await getPersonaProfile(auth.userId)
    return ok({ persona: personaContext(profile), profile })
  } catch (e) {
    console.error('[/api/me/persona]', e)
    return err(`Failed to build persona: ${(e as Error).message}`, 500)
  }
}
