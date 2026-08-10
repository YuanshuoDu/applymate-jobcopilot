import { db } from '@/lib/db'
import { requireAuth, isErrorResponse, ok, err } from '@/lib/api-helpers'
import { parseSupportCaseCreateInput, sanitizeSupportMessage, supportSlaDueAt } from '@/lib/admin/support'

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
  const body = await request.json().catch(() => null) as { subject?: unknown; category?: unknown; priority?: unknown; message?: unknown } | null
  let input: ReturnType<typeof parseSupportCaseCreateInput>
  try { input = parseSupportCaseCreateInput(body) } catch (error) { return err(error instanceof Error ? error.message : 'Case input is invalid', 400) }
  let sanitized: ReturnType<typeof sanitizeSupportMessage>
  try { sanitized = sanitizeSupportMessage(body?.message) } catch (error) { return err(error instanceof Error ? error.message : 'Message is invalid', 400) }
  const user = await db.user.findUnique({ where: { id: auth.userId }, select: { id: true, plan: true, accountStatus: true, _count: { select: { jobs: true, applicationTasks: true } } } })
  if (!user) return err('Unauthorized', 401)
  const result = await db.$transaction(async transaction => {
    const supportCase = await transaction.supportCase.create({ data: { requesterUserId: auth.userId, subject: input.subject, category: input.category, priority: input.priority, slaDueAt: supportSlaDueAt(input.priority), safeContext: { plan: user.plan, accountStatus: user.accountStatus, jobCount: user._count.jobs, applicationTaskCount: user._count.applicationTasks } }, select: { id: true } })
    const message = await transaction.supportCaseMessage.create({ data: { caseId: supportCase.id, authorType: 'customer_reply', authorUserId: auth.userId, body: sanitized.text, redacted: sanitized.redacted }, select: { id: true } })
    return { caseId: supportCase.id, messageId: message.id, redacted: sanitized.redacted }
  })
  return ok(result, 201)
}

function serializeCase(value: { id: string; subject: string; category: string; status: unknown; priority: unknown; slaDueAt: Date | null; createdAt: Date; updatedAt: Date; messages: Array<{ id: string; authorType: unknown; body: string; redacted: boolean; createdAt: Date }> }) { return { ...value, slaDueAt: value.slaDueAt?.toISOString() ?? null, createdAt: value.createdAt.toISOString(), updatedAt: value.updatedAt.toISOString(), messages: value.messages.map(message => ({ ...message, createdAt: message.createdAt.toISOString() })) } }
