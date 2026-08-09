import { db } from '@/lib/db'

export async function verifyAdminAuditChain() {
  const rows = await db.adminAuditLog.findMany({ orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { id: true, previousHash: true, recordHash: true } })
  let previous: string | null = null
  for (const row of rows) {
    if (!row.recordHash || row.previousHash !== previous) return { verified: false, recordCount: rows.length, brokenAt: row.id, firstRecordHash: rows[0]?.recordHash ?? null, lastRecordHash: rows[rows.length - 1]?.recordHash ?? null }
    previous = row.recordHash
  }
  return { verified: true, recordCount: rows.length, brokenAt: null, firstRecordHash: rows[0]?.recordHash ?? null, lastRecordHash: rows[rows.length - 1]?.recordHash ?? null }
}
