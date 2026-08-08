import { NextRequest, NextResponse } from 'next/server'
import type { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { isAdminResponse, requireAdmin } from '@/lib/admin/authorization'
import { validateAdminWrite } from '@/lib/admin/csrf'
import { runAdminMutation } from '@/lib/admin/write-transaction'
import {
  adminSettingsAuditSnapshot,
  canTransitionDeletionRequest,
  parseAdminSettingsPatch,
  toAdminSettingsDto,
} from '@/lib/admin/settings-access'
import { mergeUserPreferences } from '@/lib/settings-preferences'

type Params = { params: Promise<{ id: string }> }
type SettingsUser = Prisma.UserGetPayload<{ select: typeof USER_SELECT }>

const USER_SELECT = {
  id: true, email: true, name: true, plan: true,
  phone: true, location: true, linkedin: true, github: true,
  createdAt: true, onboardedAt: true,
  preferences: true,
  apiKeys: { select: { adzunaAppId: true, adzunaAppKey: true, rapidapiKey: true } },
  accounts: { select: { provider: true, scope: true } },
} as const

function adminJson<T>(data: T, requestId: string, status = 200) {
  return NextResponse.json(data, {
    status,
    headers: { 'Cache-Control': 'no-store', 'x-request-id': requestId },
  })
}

function settingsRecord(user: unknown) {
  return toAdminSettingsDto(user as Record<string, unknown>)
}

export async function GET(req: NextRequest, { params }: Params) {
  const actor = await requireAdmin('users.read', req)
  if (isAdminResponse(actor)) return actor

  const { id } = await params
  const user = await db.user.findUnique({ where: { id }, select: USER_SELECT })
  if (!user) return adminJson({ error: 'User not found' }, actor.requestId, 404)

  return adminJson({ user: settingsRecord(user) }, actor.requestId)
}

export async function PATCH(req: NextRequest, { params }: Params) {
  const actor = await requireAdmin('users.update_preferences', req)
  if (isAdminResponse(actor)) return actor
  const writeError = validateAdminWrite(req)
  if (writeError) return writeError

  const body = await req.json().catch(() => null)
  const bodyRecord = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : null
  const reason = typeof bodyRecord?.reason === 'string' ? bodyRecord.reason.trim() : ''
  if (reason.length < 10 || reason.length > 500) return adminJson({ error: 'A settings-change reason is required' }, actor.requestId, 400)
  const settingsBody = bodyRecord
    ? Object.fromEntries(Object.entries(bodyRecord).filter(([key]) => key !== 'reason'))
    : body
  const patch = parseAdminSettingsPatch(settingsBody)
  if ('error' in patch) return adminJson({ error: patch.error }, actor.requestId, 400)

  const { id } = await params
  const existing = await db.user.findUnique({ where: { id }, select: USER_SELECT })
  if (!existing) return adminJson({ error: 'User not found' }, actor.requestId, 404)
  if (patch.dataDeletionRequestStatus && !canTransitionDeletionRequest(existing.preferences, patch.dataDeletionRequestStatus)) {
    return adminJson({ error: 'Invalid deletion request transition' }, actor.requestId, 409)
  }

  const preferencePatch: Record<string, unknown> = {
    ...(patch.notificationPreferences ? { notificationPreferences: patch.notificationPreferences } : {}),
    ...(patch.privacyPreferences ? { privacyPreferences: patch.privacyPreferences } : {}),
    ...(patch.dataDeletionRequestStatus ? { dataDeletionRequestStatus: patch.dataDeletionRequestStatus } : {}),
  }
  const preferences = mergeUserPreferences(existing.preferences, preferencePatch) as Prisma.InputJsonValue
  const result = await runAdminMutation<SettingsUser>({
    actorUserId: actor.userId,
    action: 'users.preferences_updated',
    idempotencyKey: req.headers.get('idempotency-key') as string,
    targetId: id,
    audit: (updated) => ({
      requestId: actor.requestId,
      actorRoleKey: actor.roleKey,
      targetType: 'user',
      targetId: id,
      tenantUserId: id,
      reason,
      outcome: 'success',
      before: adminSettingsAuditSnapshot(existing.preferences) as unknown as Prisma.InputJsonValue,
      after: adminSettingsAuditSnapshot(updated.preferences) as unknown as Prisma.InputJsonValue,
    }),
    mutate: (tx) => tx.user.update({
      where: { id },
      data: { preferences },
      select: USER_SELECT,
    }),
  })
  if (result.duplicate) return adminJson({ duplicate: true }, actor.requestId)

  return adminJson({ user: settingsRecord(result.value) }, actor.requestId)
}
