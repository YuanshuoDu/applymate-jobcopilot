import { NextRequest, NextResponse } from 'next/server'
import { verifyAdminAuditChain } from '@/lib/admin/audit-integrity'
import { db } from '@/lib/db'

function authorized(request: NextRequest) {
  const secret = process.env.CRON_SECRET?.trim()
  return Boolean(secret && request.headers.get('authorization') === `Bearer ${secret}`)
}

export async function POST(request: NextRequest) {
  if (!authorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const verification = await verifyAdminAuditChain()
  const now = new Date()
  const checkpointDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  const checkpoint = await db.adminAuditCheckpoint.upsert({ where: { checkpointDate }, create: { checkpointDate, firstRecordHash: verification.firstRecordHash, lastRecordHash: verification.lastRecordHash, recordCount: verification.recordCount, verified: verification.verified }, update: { firstRecordHash: verification.firstRecordHash, lastRecordHash: verification.lastRecordHash, recordCount: verification.recordCount, verified: verification.verified } })
  return NextResponse.json({ verified: verification.verified, checkpointId: checkpoint.id, recordCount: verification.recordCount }, { status: verification.verified ? 200 : 503 })
}
