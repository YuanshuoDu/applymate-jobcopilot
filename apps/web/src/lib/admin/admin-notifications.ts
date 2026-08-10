import { db } from '@/lib/db'

export async function notifyAdministrators(input: { permission: string; type: string; title: string; body: string; entityType?: string; entityId?: string | null; dedupeKey: string }): Promise<void> {
  const membership = db.adminMembership
  const notification = db.adminNotification
  if (!membership || typeof membership.findMany !== 'function' || !notification || typeof notification.createMany !== 'function') return
  const members = await membership.findMany({ where: { status: 'active', role: { permissions: { has: input.permission } } }, select: { userId: true } })
  if (!members.length) return
  await notification.createMany({
    data: members.map(({ userId }) => ({ adminUserId: userId, type: input.type, title: input.title, body: input.body.slice(0, 500), entityType: input.entityType, entityId: input.entityId ?? null, dedupeKey: `${input.dedupeKey}:${userId}` })),
    skipDuplicates: true,
  })
}

export async function notifySupportAdmins(input: { caseId: string; messageId: string; subject: string; event: 'new_case' | 'customer_reply' }): Promise<void> {
  const title = input.event === 'new_case' ? 'New customer support case' : 'Customer replied to a support case'
  await notifyAdministrators({
    permission: 'support_cases.read',
    type: `support_case_${input.event}`,
    title,
    body: input.subject,
    entityType: 'support_case',
    entityId: input.caseId,
    dedupeKey: `${input.event}:${input.messageId}`,
  })
}
