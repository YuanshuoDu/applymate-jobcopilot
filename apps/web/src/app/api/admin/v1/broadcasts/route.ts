import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/admin/authorization'
import { writeAdminAudit } from '@/lib/admin/audit'
import { validateAdminWriteRequest } from '@/lib/admin/csrf'
import { withAdminIdempotency } from '@/lib/admin/idempotency'
import { sanitizeBroadcastText, validateBroadcastAudience, broadcastWhere } from '@/lib/admin/broadcast'
import { adminError, adminJson, jsonBody, requestId, requiredIdempotencyKey, requiredReason } from '@/lib/admin/route-utils'
import type { Prisma } from '@prisma/client'

const BROADCAST_SELECT = { id: true, title: true, body: true, audienceType: true, audience: true, status: true, scheduledAt: true, createdById: true, approvedById: true, publishedById: true, recipientCount: true, deliveredCount: true, failedCount: true, createdAt: true, updatedAt: true } as const

export async function GET(request: Request) {
  const correlationId = requestId(request)
  try { await requireAdmin('broadcasts.create', request); const broadcasts = await db.adminBroadcast.findMany({ orderBy: { updatedAt: 'desc' }, take: 100, select: BROADCAST_SELECT }); return adminJson({ items: broadcasts.map(serializeBroadcast) }, 200, correlationId) } catch (error) { return adminError(error, correlationId) }
}

export async function POST(request: Request) {
  const correlationId = requestId(request)
  try {
    const actor = await requireAdmin('broadcasts.create', request); const csrf = validateAdminWriteRequest(request); if (!csrf.ok) return adminJson({ error: csrf.code }, csrf.status, correlationId); const body = await jsonBody(request); const reason = requiredReason(body)
    if (typeof body.title !== 'string' || !body.title.trim() || body.title.trim().length > 120) throw new Error('Broadcast title is invalid')
    const title = body.title.trim(); const text = sanitizeBroadcastText(body.body); const audience = validateBroadcastAudience(body); const idempotencyKey = requiredIdempotencyKey(request)
    const response = await withAdminIdempotency(db, { actorUserId: actor.userId, key: idempotencyKey, action: 'admin.broadcast.create', body: { title, text: text.text, audience, reason } }, async transaction => {
      const broadcast = await transaction.adminBroadcast.create({ data: { title, body: text.text, audienceType: audience.audienceType, audience: audience.audience as Prisma.InputJsonValue, createdById: actor.userId }, select: BROADCAST_SELECT })
      await writeAdminAudit(transaction, { requestId: correlationId, actorUserId: actor.userId, actorRoleKey: actor.roleKey, action: 'admin.broadcast.create', targetType: 'broadcast', targetId: broadcast.id, reason, outcome: 'success', after: { status: broadcast.status, audienceType: broadcast.audienceType, redacted: text.redacted } })
      return { status: 201, body: { broadcast: serializeBroadcast(broadcast) } }
    }); return adminJson(response.body, response.status, correlationId)
  } catch (error) { return adminError(error, correlationId) }
}

export function serializeBroadcast(value: { id: string; title: string; body: string; audienceType: unknown; audience: unknown; status: unknown; scheduledAt: Date | null; createdById: string; approvedById: string | null; publishedById: string | null; recipientCount: number; deliveredCount: number; failedCount: number; createdAt: Date; updatedAt: Date }) { return { ...value, scheduledAt: value.scheduledAt?.toISOString() ?? null, createdAt: value.createdAt.toISOString(), updatedAt: value.updatedAt.toISOString() } }

export function storedAudience(value: { audienceType: unknown; audience: unknown }) { const raw = value.audience !== null && typeof value.audience === 'object' && !Array.isArray(value.audience) ? value.audience as Record<string, unknown> : {}; return validateBroadcastAudience({ audienceType: value.audienceType, ...raw }) }

export { BROADCAST_SELECT }
