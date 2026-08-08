import { NextRequest } from 'next/server'
import type { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { err, isErrorResponse, ok, requireAuth } from '@/lib/api-helpers'
import { mergeUserPreferences } from '@/lib/settings-preferences'

type StoredPreferences = Record<string, unknown>

function asPreferences(value: unknown): StoredPreferences {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as StoredPreferences
    : {}
}

function responseFor(status: string, requestedAt: string) {
  const response = ok({ requested: true, requestedAt, status })
  response.headers.set('Cache-Control', 'no-store')
  return response
}

/** Record a GDPR deletion request while leaving the account available for support follow-up. */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req)
  if (isErrorResponse(auth)) return auth

  const user = await db.user.findUnique({
    where: { id: auth.userId },
    select: { preferences: true },
  })
  if (!user) return err('User not found', 404)

  const current = asPreferences(user.preferences)
  const existingAt = typeof current.dataDeletionRequestedAt === 'string'
    ? current.dataDeletionRequestedAt
    : null
  const existingStatus = typeof current.dataDeletionRequestStatus === 'string'
    ? current.dataDeletionRequestStatus
    : null

  if (existingAt && (existingStatus === 'requested' || existingStatus === 'processing')) {
    return responseFor(existingStatus, existingAt)
  }

  const requestedAt = new Date().toISOString()
  const preferences = mergeUserPreferences(current, {
    dataDeletionRequestedAt: requestedAt,
    dataDeletionRequestStatus: 'requested',
  }) as Prisma.InputJsonValue

  await db.$transaction(async tx => {
    await tx.user.update({
      where: { id: auth.userId },
      data: { preferences },
    })
    await tx.activity.create({
      data: {
        userId: auth.userId,
        type: 'note_added',
        text: '[Privacy] GDPR data deletion request submitted',
        color: '#DC2626',
      },
    })
  })

  return responseFor('requested', requestedAt)
}
