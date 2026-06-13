import { NextRequest } from 'next/server'
import { requireAuth, ok, err, isErrorResponse } from '@/lib/api-helpers'
import { buildPersona } from '@/lib/persona'

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req)
  if (isErrorResponse(auth)) return auth

  try {
    const persona = await buildPersona(auth.userId)
    return ok({ persona })
  } catch (e) {
    console.error('[/api/me/persona]', e)
    return err(`Failed to build persona: ${(e as Error).message}`, 500)
  }
}
