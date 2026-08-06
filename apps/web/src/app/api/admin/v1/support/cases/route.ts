import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/admin/authorization'
import { parseSupportCasePriority, parseSupportCaseStatus } from '@/lib/admin/support'
import { adminError, adminJson, requestId } from '@/lib/admin/route-utils'

const CASE_SELECT = { id: true, subject: true, category: true, status: true, priority: true, assignedAdminId: true, slaDueAt: true, firstRespondedAt: true, resolvedAt: true, safeContext: true, createdAt: true, updatedAt: true, requester: { select: { id: true, email: true, name: true, plan: true, accountStatus: true, location: true, _count: { select: { jobs: true, applicationTasks: true, resumes: true } } } }, messages: { orderBy: { createdAt: 'asc' as const }, select: { id: true, authorType: true, authorUserId: true, body: true, redacted: true, createdAt: true } } } as const

export async function GET(request: Request) {
  const correlationId = requestId(request)
  try {
    const actor = await requireAdmin('support_cases.read', request)
    const url = new URL(request.url); const status = url.searchParams.get('status'); const priority = url.searchParams.get('priority'); const assignedAdminId = url.searchParams.get('assignedAdminId'); const category = url.searchParams.get('category'); const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 50) || 50, 1), 100)
    const statusValue = parseSupportCaseStatus(status)
    const priorityValue = parseSupportCasePriority(priority)
    const cases = await db.supportCase.findMany({ where: { ...(statusValue ? { status: statusValue } : {}), ...(priorityValue ? { priority: priorityValue } : {}), ...(assignedAdminId ? { assignedAdminId } : {}), ...(category ? { category } : {}) }, orderBy: [{ priority: 'desc' }, { slaDueAt: 'asc' }, { updatedAt: 'desc' }], take: limit, select: CASE_SELECT })
    const assignees = await db.adminMembership.findMany({ where: { status: 'active' }, orderBy: { grantedAt: 'asc' }, select: { userId: true, user: { select: { name: true, email: true } } } })
    return adminJson({ items: cases.map(toAdminCaseDto), actorUserId: actor.userId, assignees: assignees.map(member => ({ id: member.userId, name: maskName(member.user.name), email: maskEmail(member.user.email) })) }, 200, correlationId)
  } catch (error) { return adminError(error, correlationId) }
}

type AdminCaseRow = { id: string; subject: string; category: string; status: string; priority: string; assignedAdminId: string | null; slaDueAt: Date | null; firstRespondedAt: Date | null; resolvedAt: Date | null; safeContext: unknown; createdAt: Date; updatedAt: Date; requester: { id: string; email: string; name: string | null; plan: string; accountStatus: string; location: string | null; _count: { jobs: number; applicationTasks: number; resumes: number } }; messages: Array<{ id: string; authorType: string; authorUserId: string | null; body: string; redacted: boolean; createdAt: Date }> }

function toAdminCaseDto(value: AdminCaseRow) {
  const requester = value.requester
  return { id: value.id, subject: value.subject, category: value.category, status: value.status, priority: value.priority, assignedAdminId: value.assignedAdminId, slaDueAt: value.slaDueAt?.toISOString() ?? null, firstRespondedAt: value.firstRespondedAt?.toISOString() ?? null, resolvedAt: value.resolvedAt?.toISOString() ?? null, createdAt: value.createdAt.toISOString(), updatedAt: value.updatedAt.toISOString(), safeContext: value.safeContext, requester: { id: requester.id, email: maskEmail(requester.email), name: maskName(requester.name), plan: requester.plan, accountStatus: requester.accountStatus, region: requester.location ? requester.location.split(',').at(-1)?.trim() ?? '' : '', counts: requester._count }, messages: value.messages.map((message: { id: string; authorType: string; body: string; redacted: boolean; createdAt: Date }) => ({ ...message, createdAt: message.createdAt.toISOString() })) }
}

function maskEmail(value: string): string { const [local, domain] = value.split('@'); return `${local?.slice(0, 1) ?? '*'}***@${domain ?? 'redacted'}` }
function maskName(value: string | null): string { if (!value) return ''; return value.split(/\s+/).map(part => part ? `${part[0]}***` : '').join(' ') }
