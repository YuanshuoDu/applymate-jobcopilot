import { NextRequest, NextResponse } from 'next/server'
import { SupportCaseStatus } from '@prisma/client'
import { isAdminResponse, requireAdmin } from '@/lib/admin/authorization'
import { writeAdminAudit } from '@/lib/admin/audit'
import { adminUserMetadataSelect, toAdminUserMetadata } from '@/lib/admin/dto'
import { supportCaseScope } from '@/lib/admin/support-case'
import { db } from '@/lib/db'

export async function GET(request: NextRequest) {
  const actor = await requireAdmin('support_cases.read', request)
  if (isAdminResponse(actor)) return actor
  const status = request.nextUrl.searchParams.get('status')
  if (status && !Object.values(SupportCaseStatus).includes(status as SupportCaseStatus)) {
    return NextResponse.json({ error: 'Invalid support case status' }, { status: 400, headers: { 'Cache-Control': 'no-store' } })
  }
  const statusFilter = status ? { status: status as SupportCaseStatus } : {}
  const scope = supportCaseScope(actor)
  const cases = await db.supportCase.findMany({
    where: { ...statusFilter, ...scope },
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
