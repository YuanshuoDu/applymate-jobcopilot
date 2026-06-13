/**
 * PATCH /api/me/onboarding — save onboarding step data
 */
import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, isErrorResponse, ok, err } from '@/lib/api-helpers'

export async function PATCH(req: NextRequest) {
  const auth = await requireAuth(req)
  if (isErrorResponse(auth)) return auth

  const body = await req.json().catch(() => null)
  if (!body) return err('Invalid JSON body')

  // Reset onboarding
  if (body.reset === true) {
    await db.user.update({ where: { id: auth.userId }, data: { onboardedAt: null } })
    return ok({ ok: true })
  }

  const {
    goals, persona, defaultTemplateId, defaultAccentColor,
    defaultFontFamily, aiAutoPilot, complete,
  } = body

  const data: Record<string, unknown> = {}
  if (Array.isArray(goals))               data.onboardingGoals    = goals
  if (defaultTemplateId !== undefined)    data.defaultTemplateId  = defaultTemplateId
  if (defaultAccentColor !== undefined)   data.defaultAccentColor = defaultAccentColor
  if (defaultFontFamily !== undefined)    data.defaultFontFamily  = defaultFontFamily
  if (aiAutoPilot !== undefined)          data.aiAutoPilot        = aiAutoPilot
  if (complete)                           data.onboardedAt        = new Date()

  // Persona fields map to User table columns
  if (persona) {
    if (persona.name)     data.name     = persona.name
    if (persona.email)    data.email    = persona.email
    if (persona.phone)    data.phone    = persona.phone
    if (persona.location) data.location = persona.location
    if (persona.linkedin) data.linkedin = persona.linkedin
    if (persona.github)   data.github   = persona.github
  }

  if (Object.keys(data).length === 0) return ok({ ok: true })

  await db.user.update({ where: { id: auth.userId }, data })
  return ok({ ok: true })
}
