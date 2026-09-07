import { NextRequest, NextResponse } from 'next/server'
import { isAdminResponse, requireAdmin } from '@/lib/admin/authorization'
import { writeAdminAudit } from '@/lib/admin/audit'
import { verifyAdminAuditChain } from '@/lib/admin/audit-integrity'

export async function GET(request: NextRequest) {
  const actor = await requireAdmin('audit.read', request)
  if (isAdminResponse(actor)) return actor
  try {
    const result = await verifyAdminAuditChain()
    if (result.verified) {
      await writeAdminAudit({ requestId: actor.requestId, actorUserId: actor.userId, actorRoleKey: actor.roleKey, action: 'audit.integrity_checked', outcome: 'success', after: { verified: true, recordCount: result.recordCount, brokenAt: null } })
    } else {
      console.error('ADMIN_AUDIT_INTEGRITY_FAILED', { requestId: actor.requestId, recordCount: result.recordCount, brokenAt: result.brokenAt })
    }
    return NextResponse.json(result, { status: result.verified ? 200 : 503, headers: { 'Cache-Control': 'no-store', 'x-request-id': actor.requestId } })
  } catch {
    console.error('ADMIN_AUDIT_INTEGRITY_UNAVAILABLE', { requestId: actor.requestId, errorCode: 'integrity_unavailable' })
    return NextResponse.json({ verified: false, recordCount: 0, brokenAt: null, firstRecordHash: null, lastRecordHash: null, errorCode: 'integrity_unavailable' }, { status: 503, headers: { 'Cache-Control': 'no-store', 'x-request-id': actor.requestId } })
  }
}
