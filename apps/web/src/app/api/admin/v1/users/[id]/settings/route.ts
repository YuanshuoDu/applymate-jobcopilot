import { NextRequest } from 'next/server'
import type { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { err, isErrorResponse, ok } from '@/lib/api-helpers'
import {
  canTransitionDeletionRequest,
  parseAdminSettingsPatch,
  requireSettingsAdmin,
  toAdminSettingsDto,
} from '@/lib/admin/settings-access'
import { mergeUserPreferences } from '@/lib/settings-preferences'

type Params = { params: Promise<{ id: string }> }

function adminOk<T>(data: T, status = 200) {
  const response = ok(data, status)
  response.headers.set('Cache-Control', 'no-store')
  response.headers.set('x-request-id', crypto.randomUUID())
  return response
}

const USER_SELECT = {
  id: true, email: true, name: true, plan: true,
  phone: true, location: true, linkedin: true, github: true,
  createdAt: true, onboardedAt: true,
  preferences: true,
  apiKeys: { select: { adzunaAppId: true, adzunaAppKey: true, rapidapiKey: true } },
  accounts: { select: { provider: true, scope: true } },
} as const

export async function GET(req: NextRequest, { params }: Params) {
  const actor = await requireSettingsAdmin(req)
  if (isErrorResponse(actor)) return actor
  const { id } = await params
  const user = await db.user.findUnique({ where: { id }, select: USER_SELECT })
  if (!user) return err('User not found', 404)
  return adminOk({ user: toAdminSettingsDto(user as Record<string, unknown>) })
}

export async function PATCH(req: NextRequest, { params }: Params) {
  const actor = await requireSettingsAdmin(req)
  if (actor instanceof Response) return actor
  const { id } = await params
  const body = await req.json().catch(() => null)
  const patch = parseAdminSettingsPatch(body)
  if ('error' in patch) return err(patch.error)

  const existing = await db.user.findUnique({ where: { id }, select: USER_SELECT })
  if (!existing) return err('User not found', 404)
  if (
    patch.dataDeletionRequestStatus
    && !canTransitionDeletionRequest(existing.preferences, patch.dataDeletionRequestStatus)
  ) {
    return err('Invalid deletion request transition', 409)
  }
  const preferencePatch: Record<string, unknown> = {
    ...(patch.notificationPreferences ? { notificationPreferences: patch.notificationPreferences } : {}),
    ...(patch.privacyPreferences ? { privacyPreferences: patch.privacyPreferences } : {}),
    ...(patch.dataDeletionRequestStatus ? { dataDeletionRequestStatus: patch.dataDeletionRequestStatus } : {}),
  }
  const preferences = mergeUserPreferences(existing.preferences, preferencePatch) as Prisma.InputJsonValue
  const auditFields = [
    patch.notificationPreferences ? 'notifications' : null,
    patch.privacyPreferences ? 'privacy' : null,
    patch.dataDeletionRequestStatus ? `GDPR deletion request ${patch.dataDeletionRequestStatus}` : null,
  ].filter(Boolean).join(', ')

  const updated = await db.$transaction(async tx => {
    const user = await tx.user.update({
      where: { id },
      data: { preferences },
      select: USER_SELECT,
    })
    await tx.activity.create({
      data: {
        userId: id,
        type: 'note_added',
        text: `[Admin] Updated ${auditFields}`,
        color: '#4F46E5',
      },
    })
    return user
  })

  return adminOk({ user: toAdminSettingsDto(updated as Record<string, unknown>), changedBy: actor.userId })
}
