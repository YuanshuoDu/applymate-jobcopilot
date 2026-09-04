import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { notifySupportAdmins } from '@/lib/admin/admin-notifications'
import { requireAuth, isErrorResponse, ok } from '@/lib/api-helpers'
import { parseNewCase, getSlaDueAt } from '@/lib/contact-us'

const CASE_SELECT = { id: true, subject: true, category: true, status: true, priority: true, slaDueAt: true, createdAt: true, updatedAt: true, messages: { where: { authorType: { not: 'internal_note' as const } }, orderBy: { createdAt: 'asc' as const }, select: { id: true, authorType: true, body: true, redacted: true, createdAt: true } } } as const

export async function GET() {
  const auth = await requireAuth()
  if (isErrorResponse(auth)) return auth
  const cases = await db.supportCase.findMany({ where: { requesterUserId: auth.userId }, orderBy: { updatedAt: 'desc' }, select: CASE_SELECT })
  return ok({ cases: cases.map(serializeCase) })
}

export async function POST(request: Request) {
  const auth = await requireAuth()
  if (isErrorResponse(auth)) return auth
  const input = parseNewCase(await request.json().catch(() => null))
  if (!input) return NextResponse.json({ error: 'Invalid support request' }, { status: 400 })
  const supportCase = await db.supportCase.create({
    data: {
      requesterUserId: auth.userId, subject: input.subject, category: input.category,
      slaDueAt: getSlaDueAt(input.category, 'normal'),
      messages: { create: { authorType: 'customer_reply', authorUserId: auth.userId, body: input.message.body, redacted: input.message.redacted } },
    },
    select: { id: true, subject: true, status: true, createdAt: true, messages: { select: { id: true }, orderBy: { createdAt: 'asc' }, take: 1 } },
  })
  const firstMessage = supportCase.messages[0]
  if (firstMessage) await Promise.resolve(notifySupportAdmins({ caseId: supportCase.id, messageId: firstMessage.id, subject: supportCase.subject, event: 'new_case' })).catch(() => undefined)
  return NextResponse.json({ case: supportCase }, { status: 201, headers: { 'Cache-Control': 'no-store' } })
}

function serializeCase(value: { id: string; subject: string; category: string; status: unknown; priority: unknown; slaDueAt: Date | null; createdAt: Date; updatedAt: Date; messages: Array<{ id: string; authorType: unknown; body: string; redacted: boolean; createdAt: Date }> }) { return { ...value, slaDueAt: value.slaDueAt?.toISOString() ?? null, createdAt: value.createdAt.toISOString(), updatedAt: value.updatedAt.toISOString(), messages: value.messages.map(message => ({ ...message, createdAt: message.createdAt.toISOString() })) } }
