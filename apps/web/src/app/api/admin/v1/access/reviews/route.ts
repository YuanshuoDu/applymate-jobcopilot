import { NextRequest, NextResponse } from 'next/server'
import { AdminMembershipStatus } from '@prisma/client'
import { isAdminResponse, requireAdmin } from '@/lib/admin/authorization'
import { writeAdminAudit } from '@/lib/admin/audit'
import { validateAdminWrite } from '@/lib/admin/csrf'
import { db } from '@/lib/db'
import { runAdminMutation } from '@/lib/admin/write-transaction'

const REVIEW_STATUSES = ['approved', 'revoked', 'exception'] as const

function cycleWindow(now = new Date()) {
  const quarter = Math.floor(now.getUTCMonth() / 3) + 1
  const cycleKey = `${now.getUTCFullYear()}-Q${quarter}`
  const endMonth = quarter * 3
  const dueAt = new Date(Date.UTC(now.getUTCFullYear(), endMonth, 0, 23, 59, 59, 999))
  return { cycleKey, dueAt }
}

export async function GET(request: NextRequest) {
  const actor = await requireAdmin('admin_access_reviews.read', request)
  if (isAdminResponse(actor)) return actor
  const { cycleKey, dueAt } = cycleWindow()
  const memberships = await db.adminMembership.findMany({
    where: { status: { in: [AdminMembershipStatus.active, AdminMembershipStatus.suspended] } },
    orderBy: { grantedAt: 'asc' },
    select: { id: true, userId: true, status: true, mfaLevel: true, grantedAt: true, role: { select: { key: true, name: true, permissions: true } }, user: { select: { name: true, email: true } }, accessReviews: { where: { cycleKey }, orderBy: { createdAt: 'desc' }, take: 1, select: { id: true, status: true, reviewedAt: true, notes: true, reviewerId: true } } },
  })
  await writeAdminAudit({ requestId: actor.requestId, actorUserId: actor.userId, actorRoleKey: actor.roleKey, action: 'admin.access_review_list_viewed', outcome: 'success' })
  return NextResponse.json({ cycleKey, dueAt, reviews: memberships.map((membership) => ({ ...membership, review: membership.accessReviews[0] ?? { id: null, status: 'pending', reviewedAt: null, notes: null, reviewerId: null } })) }, { headers: { 'Cache-Control': 'no-store', 'x-request-id': actor.requestId } })
}

export async function POST(request: NextRequest) {
  const writeError = validateAdminWrite(request)
  if (writeError) return writeError
  const actor = await requireAdmin('admin_access_reviews.manage', request)
  if (isAdminResponse(actor)) return actor
  const body = await request.json().catch(() => null) as { membershipId?: string; status?: string; notes?: string; reason?: string } | null
  const membershipId = typeof body?.membershipId === 'string' ? body.membershipId.trim() : ''
  const status = typeof body?.status === 'string' ? body.status : ''
  const notes = typeof body?.notes === 'string' ? body.notes.trim().slice(0, 2000) : null
  const reason = typeof body?.reason === 'string' ? body.reason.trim() : ''
  const key = request.headers.get('idempotency-key')?.trim() ?? ''
  if (!membershipId || !key || !REVIEW_STATUSES.includes(status as (typeof REVIEW_STATUSES)[number]) || reason.length < 10 || reason.length > 500) return NextResponse.json({ error: 'membershipId, valid status, idempotency key and a 10-500 character reason are required' }, { status: 400 })
  const membership = await db.adminMembership.findUnique({ where: { id: membershipId }, select: { id: true, userId: true, status: true, role: { select: { key: true } } } })
  if (!membership) return NextResponse.json({ error: 'Administrator membership not found' }, { status: 404 })
  if (membership.userId === actor.userId) return NextResponse.json({ error: 'An administrator cannot review their own access' }, { status: 409 })
  const { cycleKey, dueAt } = cycleWindow()
  const result = await runAdminMutation({
    actorUserId: actor.userId,
    action: 'admin.access_review_completed',
    idempotencyKey: key,
    targetId: membershipId,
    audit: { requestId: actor.requestId, actorRoleKey: actor.roleKey, targetType: 'admin_member', targetId: membershipId, reason, outcome: 'success', before: { status: membership.status, role: membership.role.key }, after: { reviewStatus: status, cycleKey, membershipStatus: status === 'revoked' ? 'revoked' : membership.status } },
    mutate: async (tx) => {
    const review = await tx.adminAccessReview.upsert({ where: { membershipId_cycleKey: { membershipId, cycleKey } }, create: { membershipId, reviewerId: actor.userId, cycleKey, status, dueAt, reviewedAt: new Date(), notes }, update: { reviewerId: actor.userId, status, reviewedAt: new Date(), notes, dueAt } })
    if (status === 'revoked') await tx.adminMembership.update({ where: { id: membershipId }, data: { status: AdminMembershipStatus.revoked, revokedAt: new Date(), sessionVersion: { increment: 1 } } })
    return review
    },
  })
  if (result.duplicate) return NextResponse.json({ duplicate: true }, { headers: { 'Cache-Control': 'no-store', 'x-request-id': actor.requestId } })
  return NextResponse.json({ review: result.value }, { headers: { 'Cache-Control': 'no-store', 'x-request-id': actor.requestId } })
}
