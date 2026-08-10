import { NextRequest, NextResponse } from 'next/server'
import { verifyAdminAuditChain } from '@/lib/admin/audit-integrity'
import { notifyAdministrators } from '@/lib/admin/admin-notifications'
import { db } from '@/lib/db'

function authorized(request: NextRequest) {
  const secrets = [
    process.env.AUDIT_CHECKPOINT_CRON_SECRET,
    process.env.WEB_MAINTENANCE_CRON_SECRET,
    process.env.CRON_SECRET,
  ].filter((value): value is string => Boolean(value?.trim()))
  const authorization = request.headers.get('authorization')
  return secrets.some((secret) => authorization === `Bearer ${secret}`)
}

export async function POST(request: NextRequest) {
  if (!authorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const verification = await verifyAdminAuditChain()
  const now = new Date()
  const checkpointDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  const checkpoint = await db.adminAuditCheckpoint.upsert({ where: { checkpointDate }, create: { checkpointDate, firstRecordHash: verification.firstRecordHash, lastRecordHash: verification.lastRecordHash, recordCount: verification.recordCount, verified: verification.verified }, update: { firstRecordHash: verification.firstRecordHash, lastRecordHash: verification.lastRecordHash, recordCount: verification.recordCount, verified: verification.verified } })
  if (!verification.verified) await notifyAdministrators({ permission: 'audit.read', type: 'audit_integrity_failed', title: 'Audit hash chain verification failed', body: `The administrator audit chain is broken at ${verification.brokenAt ?? 'an unknown record'}. Immediate investigation is required.`, entityType: 'audit_integrity', entityId: verification.brokenAt, dedupeKey: `audit-integrity:${checkpointDate.toISOString().slice(0, 10)}` }).catch(() => undefined)
  return NextResponse.json({ verified: verification.verified, checkpointId: checkpoint.id, recordCount: verification.recordCount }, { status: verification.verified ? 200 : 503 })
}
