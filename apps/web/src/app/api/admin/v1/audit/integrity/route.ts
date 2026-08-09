import { NextRequest, NextResponse } from 'next/server'
import { isAdminResponse, requireAdmin } from '@/lib/admin/authorization'
import { writeAdminAudit } from '@/lib/admin/audit'
import { verifyAdminAuditChain } from '@/lib/admin/audit-integrity'

export async function GET(request: NextRequest) {
  const actor = await requireAdmin('audit.read', request)
  if (isAdminResponse(actor)) return actor
  const result = await verifyAdminAuditChain()
  await writeAdminAudit({ requestId: actor.requestId, actorUserId: actor.userId, actorRoleKey: actor.roleKey, action: 'audit.integrity_checked', outcome: result.verified ? 'success' : 'failed', errorCode: result.verified ? undefined : 'hash_chain_broken', after: { verified: result.verified, recordCount: result.recordCount, brokenAt: result.brokenAt } })
  return NextResponse.json(result, { status: result.verified ? 200 : 503, headers: { 'Cache-Control': 'no-store', 'x-request-id': actor.requestId } })
}
