import { NextRequest, NextResponse } from 'next/server'
import { isErrorResponse, requireAuth } from '@/lib/api-helpers'
import { parseReply } from '@/lib/contact-us'
import { notifySupportAdmins } from '@/lib/admin/admin-notifications'
import { db } from '@/lib/db'

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(request)
  if (isErrorResponse(auth)) return auth
  const { id } = await context.params
  const supportCase = await db.supportCase.findFirst({
    where: { id, requesterUserId: auth.userId },
    select: { id: true, subject: true, status: true, messages: { where: { authorType: { not: 'internal_note' } }, select: { id: true, authorType: true, body: true, redacted: true, createdAt: true }, orderBy: { createdAt: 'asc' } } },
  })
  if (!supportCase) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json({ case: supportCase }, { headers: { 'Cache-Control': 'no-store' } })
}

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(request)
  if (isErrorResponse(auth)) return auth
  const { id } = await context.params
  const message = parseReply(await request.json().catch(() => null))
  if (!message) return NextResponse.json({ error: 'Invalid message' }, { status: 400 })
  const result = await db.supportCase.updateMany({ where: { id, requesterUserId: auth.userId, status: { not: 'closed' } }, data: { status: 'in_progress' } })
  if (!result.count) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const created = await db.supportCaseMessage.create({ data: { caseId: id, authorType: 'customer_reply', authorUserId: auth.userId, body: message.body, redacted: message.redacted }, select: { id: true, authorType: true, body: true, redacted: true, createdAt: true, supportCase: { select: { subject: true } } } })
  await Promise.resolve(notifySupportAdmins({ caseId: id, messageId: created.id, subject: created.supportCase.subject, event: 'customer_reply' })).catch(() => undefined)
  return NextResponse.json({ message: created }, { status: 201 })
}
