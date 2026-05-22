/**
 * GET /api/resume/default
 * Returns the authenticated user's default resume content.
 * Used by ScoreJobButton to supply resumeContent to the AI scoring API.
 */
import { NextRequest } from 'next/server'
import { requireAuth, isErrorResponse, ok, err } from '@/lib/api-helpers'
import { db } from '@/lib/db'

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req)
  if (isErrorResponse(auth)) return auth

  const resume = await db.resume.findFirst({
    where: { userId: auth.userId, isDefault: true },
    select: { id: true, content: true },
  })

  if (!resume) {
    const fallback = await db.resume.findFirst({
      where: { userId: auth.userId },
      orderBy: { createdAt: 'desc' },
      select: { id: true, content: true },
    })
    if (!fallback) return err('No resume found', 404)
    return ok({ content: fallback.content })
  }

  return ok({ content: resume.content })
}
