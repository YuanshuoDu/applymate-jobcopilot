import { db } from '@/lib/db'

type AuditRow = { id: string; previousHash: string | null; recordHash: string | null }

type AuditVerification = {
  verified: boolean
  recordCount: number
  brokenAt: string | null
  firstRecordHash: string | null
  lastRecordHash: string | null
}

function failure(rows: AuditRow[], brokenAt: string): AuditVerification {
  return {
    verified: false,
    recordCount: rows.length,
    brokenAt,
    firstRecordHash: rows[0]?.recordHash ?? null,
    lastRecordHash: rows[rows.length - 1]?.recordHash ?? null,
  }
}

export async function verifyAdminAuditChain() {
  const rows = await db.adminAuditLog.findMany({ select: { id: true, previousHash: true, recordHash: true } }) as AuditRow[]
  if (rows.length === 0) return { verified: true, recordCount: 0, brokenAt: null, firstRecordHash: null, lastRecordHash: null }

  const rowsByHash = new Map<string, AuditRow>()
  const childByParentHash = new Map<string, AuditRow>()
  let root: AuditRow | undefined

  for (const row of rows) {
    if (!row.recordHash || rowsByHash.has(row.recordHash)) return failure(rows, row.id)
    rowsByHash.set(row.recordHash, row)

    if (row.previousHash === null) {
      if (root) return failure(rows, row.id)
      root = row
      continue
    }

    if (childByParentHash.has(row.previousHash)) return failure(rows, row.id)
    childByParentHash.set(row.previousHash, row)
  }

  for (const row of rows) {
    if (row.previousHash !== null && !rowsByHash.has(row.previousHash)) return failure(rows, row.id)
  }
  if (!root) return failure(rows, rows[0].id)

  const visited = new Set<string>()
  let current: AuditRow | undefined = root
  let previousHash: string | null = null
  while (current) {
    if (visited.has(current.id) || current.previousHash !== previousHash) return failure(rows, current.id)
    const recordHash = current.recordHash
    if (!recordHash) return failure(rows, current.id)
    visited.add(current.id)
    previousHash = recordHash
    current = childByParentHash.get(recordHash)
  }

  if (visited.size !== rows.length) {
    const disconnected = rows.find((row) => !visited.has(row.id))
    return failure(rows, disconnected?.id ?? rows[0].id)
  }

  return { verified: true, recordCount: rows.length, brokenAt: null, firstRecordHash: root.recordHash, lastRecordHash: previousHash }
}
