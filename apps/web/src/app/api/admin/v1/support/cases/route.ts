import { NextRequest, NextResponse } from 'next/server'
import { SupportCasePriority, SupportCaseStatus } from '@prisma/client'
import { isAdminResponse, requireAdmin } from '@/lib/admin/authorization'
import { writeAdminAudit } from '@/lib/admin/audit'
import { adminUserMetadataSelect, toAdminUserMetadata } from '@/lib/admin/dto'
import { supportCaseScope } from '@/lib/admin/support-case'
import { db } from '@/lib/db'

export async function GET(request: NextRequest) {
  const actor = await requireAdmin('support_cases.read', request)
  if (isAdminResponse(actor)) return actor
  const params = request.nextUrl.searchParams
  const status = params.get('status')
  const priority = params.get('priority')
  const assigned = params.get('assigned')
  const category = params.get('category')?.trim()
  const sla = params.get('sla')
  if (status && !Object.values(SupportCaseStatus).includes(status as SupportCaseStatus)) {
    return NextResponse.json({ error: 'Invalid support case status' }, { status: 400, headers: { 'Cache-Control': 'no-store' } })
  }
  if (priority && !Object.values(SupportCasePriority).includes(priority as SupportCasePriority)) return NextResponse.json({ error: 'Invalid support case priority' }, { status: 400, headers: { 'Cache-Control': 'no-store' } })
  if (assigned && assigned !== 'unassigned' && !/^[a-z0-9_-]{1,100}$/i.test(assigned)) return NextResponse.json({ error: 'Invalid assignee' }, { status: 400, headers: { 'Cache-Control': 'no-store' } })
  if (sla && !['overdue', 'due_soon'].includes(sla)) return NextResponse.json({ error: 'Invalid SLA filter' }, { status: 400, headers: { 'Cache-Control': 'no-store' } })
  const statusFilter = status ? { status: status as SupportCaseStatus } : {}
  const priorityFilter = priority ? { priority: priority as SupportCasePriority } : {}
  const assignmentFilter = assigned === 'unassigned' ? { assignedAdminId: null } : assigned ? { assignedAdminId: assigned } : {}
  const categoryFilter = category ? { category: { contains: category, mode: 'insensitive' as const } } : {}
  const slaFilter = sla === 'overdue' ? { slaDueAt: { lt: new Date() }, status: { notIn: ['resolved', 'closed'] as SupportCaseStatus[] } } : sla === 'due_soon' ? { slaDueAt: { gte: new Date(), lte: new Date(Date.now() + 24 * 60 * 60_000) }, status: { notIn: ['resolved', 'closed'] as SupportCaseStatus[] } } : {}
  const scope = supportCaseScope(actor)
  const cases = await db.supportCase.findMany({
    where: { ...statusFilter, ...priorityFilter, ...assignmentFilter, ...categoryFilter, ...slaFilter, ...scope },
    orderBy: [{ priority: 'desc' }, { slaDueAt: 'asc' }], take: 100,
    select: {
      id: true, subject: true, category: true, status: true, priority: true, assignedAdminId: true, slaDueAt: true, version: true, createdAt: true, updatedAt: true, safeContext: true,
      requester: { select: adminUserMetadataSelect },
      messages: { select: { id: true, authorType: true, body: true, redacted: true, createdAt: true }, orderBy: { createdAt: 'asc' } },
    },
  })
  await writeAdminAudit({ requestId: actor.requestId, actorUserId: actor.userId, actorRoleKey: actor.roleKey, action: 'support.case_list_viewed', outcome: 'success' })
  return NextResponse.json({ cases: cases.map((supportCase) => ({ ...supportCase, requester: toAdminUserMetadata(supportCase.requester) })) }, { headers: { 'Cache-Control': 'no-store' } })
}
