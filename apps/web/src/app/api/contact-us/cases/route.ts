import { NextRequest, NextResponse } from 'next/server'
import { isErrorResponse, requireAuth } from '@/lib/api-helpers'
import { getSlaDueAt, parseNewCase } from '@/lib/contact-us'
import { db } from '@/lib/db'

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request)
  if (isErrorResponse(auth)) return auth
  const cases = await db.supportCase.findMany({
    where: { requesterUserId: auth.userId },
    select: { id: true, subject: true, category: true, status: true, priority: true, slaDueAt: true, createdAt: true, updatedAt: true },
    orderBy: { updatedAt: 'desc' }, take: 100,
  })
  return NextResponse.json({ cases }, { headers: { 'Cache-Control': 'no-store' } })
}

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request)
  if (isErrorResponse(auth)) return auth
  const input = parseNewCase(await request.json().catch(() => null))
  if (!input) return NextResponse.json({ error: 'Invalid support request' }, { status: 400 })
  const supportCase = await db.supportCase.create({
    data: {
      requesterUserId: auth.userId, subject: input.subject, category: input.category,
      slaDueAt: getSlaDueAt(input.category, 'normal'),
      messages: { create: { authorType: 'customer_reply', authorUserId: auth.userId, body: input.message.body, redacted: input.message.redacted } },
    },
    select: { id: true, subject: true, status: true, createdAt: true },
  })
  return NextResponse.json({ case: supportCase }, { status: 201, headers: { 'Cache-Control': 'no-store' } })
}
