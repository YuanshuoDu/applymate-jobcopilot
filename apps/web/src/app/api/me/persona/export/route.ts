import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, isErrorResponse, ok, err } from '@/lib/api-helpers'

/** GDPR data portability: an authenticated user can download their Persona data. */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req)
  if (isErrorResponse(auth)) return auth

  const user = await db.user.findUnique({
    where: { id: auth.userId },
    select: {
      name: true, email: true, phone: true, location: true, linkedin: true, github: true,
      preferences: true, personaFields: true, personaFacts: true,
      resumes: { select: { id: true, name: true, content: true, updatedAt: true } },
    },
  })
  if (!user) return err('User not found', 404)

  const response = ok({ exportedAt: new Date().toISOString(), profile: user })
  response.headers.set('Cache-Control', 'private, no-store')
  return response
}
