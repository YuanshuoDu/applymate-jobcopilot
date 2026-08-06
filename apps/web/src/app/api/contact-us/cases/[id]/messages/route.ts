import { db } from '@/lib/db'
import { requireAuth, isErrorResponse, ok, err } from '@/lib/api-helpers'
import { sanitizeSupportMessage } from '@/lib/admin/support'

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(); if (isErrorResponse(auth)) return auth; const { id } = await context.params
  const supportCase = await db.supportCase.findFirst({ where: { id, requesterUserId: auth.userId }, select: { messages: { where: { authorType: { not: 'internal_note' as const } }, orderBy: { createdAt: 'asc' }, select: { id: true, authorType: true, body: true, redacted: true, createdAt: true } } } })
  if (!supportCase) return err('Case not found', 404)
  return ok({ messages: supportCase.messages.map(message => ({ ...message, createdAt: message.createdAt.toISOString() })) })
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(); if (isErrorResponse(auth)) return auth; const { id } = await context.params; const body = await request.json().catch(() => null) as { message?: unknown } | null
  let sanitized: ReturnType<typeof sanitizeSupportMessage>
  try { sanitized = sanitizeSupportMessage(body?.message) } catch (error) { return err(error instanceof Error ? error.message : 'Message is invalid', 400) }
  const supportCase = await db.supportCase.findFirst({ where: { id, requesterUserId: auth.userId }, select: { id: true, status: true } }); if (!supportCase) return err('Case not found', 404); if (supportCase.status === 'closed') return err('Case is closed', 409)
  const message = await db.supportCaseMessage.create({ data: { caseId: id, authorType: 'customer_reply', authorUserId: auth.userId, body: sanitized.text, redacted: sanitized.redacted }, select: { id: true, createdAt: true } })
  await db.supportCase.update({ where: { id }, data: { status: 'in_progress' } })
  return ok({ message: { id: message.id, createdAt: message.createdAt.toISOString(), redacted: sanitized.redacted } }, 201)
}
