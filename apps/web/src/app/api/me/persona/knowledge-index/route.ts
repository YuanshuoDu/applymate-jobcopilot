import { NextRequest } from 'next/server'
import { requireAuth, isErrorResponse, ok, err } from '@/lib/api-helpers'
import { syncPersonaEvidence } from '@/lib/persona-evidence'

/** Explicit user opt-in: indexes approved Persona evidence for semantic retrieval. */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req)
  if (isErrorResponse(auth)) return auth
  try {
    const result = await syncPersonaEvidence(auth.userId)
    const response = ok(result)
    response.headers.set('Cache-Control', 'private, no-store')
    return response
  } catch (error) {
    console.error('[/api/me/persona/knowledge-index]', error)
    return err('Could not build the Persona knowledge index.', 500)
  }
}
